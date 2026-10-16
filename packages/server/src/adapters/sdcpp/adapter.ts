// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The sd.cpp native adapter: one sd-server instance, one route (SD1 to SD5).
 *
 * An sd-server serves one model, loaded at startup, and cannot switch over
 * HTTP; Lemonade switches by starting another child. So the adapter knows a
 * base URL and nothing else (L1): the same class serves a standalone
 * instance configured by URL, a Lemonade child, and later an orchd native
 * proxy (`…/orchd/v1/models/<id>/native`, a base URL with a path).
 *
 * - **Identity** is the model file the capabilities report (L4), checked by
 *   the engine before every submit and resume. Under a manager that
 *   supplies the capabilities (orchd, L3) they come from the manager, and the
 *   native URL is never asked; Lemonade's children are asked directly,
 *   because their model is loaded already and asking loads nothing.
 * - **Health**, standalone, is `GET /` answering at all (SD5); under a
 *   manager the registry takes it from the manager instead.
 * - **Jobs** live only in sd-server's memory and are purged ten minutes after
 *   they end (410 for ten more, then 404), so the engine spools results as
 *   soon as a status call returns them. Job ids embed a timestamp, so a
 *   restarted instance never answers with another job's result.
 * - **A 429** at submit means sd-server's queue is full: the job was never
 *   received, so it goes back to Lantern's queue (L5).
 */

import type { GenerationRequest, RouteDescriptor } from '@bureaucromancer/lantern-schema';

import {
  errorText,
  HttpStatusError,
  joinUrl,
  request,
  requestOk,
  retryAfterSeconds,
  type FetchLike,
} from '../shared/http.js';
import {
  CancelRefused,
  RejectedBeforeStart,
  type Adapter,
  type AdapterConfig,
  type BackendHealth,
  type FetchedResult,
  type JobHandle,
  type JobStatus,
  type ModelIdentity,
  type WireRequest,
} from '../shared/types.js';
import {
  identityOf,
  parseCapabilities,
  servesImages,
  type SdcppCapabilities,
} from './capabilities.js';
import { describeCapabilities } from './describe.js';
import { prepareImgGen } from './prepare.js';
import { resultOf, statusOf, type SdcppJobData } from './results.js';
import { readSdcppSettings, type SdcppSettings } from './settings.js';

const CAPABILITIES = '/sdcpp/v1/capabilities';
const IMG_GEN = '/sdcpp/v1/img_gen';
const JOBS = '/sdcpp/v1/jobs';

/** The preview `auto` asks for: projected latents, the cheapest (plan, Phase 5). */
export const AUTO_PREVIEW = 'proj';

export interface SdcppAdapterOptions {
  /** The `fetch` to use; the global one by default. */
  readonly fetch?: FetchLike;
  /**
   * Supplies the capabilities document instead of the instance: a manager
   * that captured it when the model loaded (L3). Absent: the instance's own.
   */
  readonly capabilities?: () => Promise<unknown>;
  /** The route id `describe()` names; the registry renames it anyway. */
  readonly route?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jobData(handle: JobHandle): SdcppJobData {
  const data = handle.data;
  if (
    !isRecord(data) ||
    typeof data['id'] !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(data['id']) ||
    typeof data['seed'] !== 'number' ||
    typeof data['batch_count'] !== 'number'
  ) {
    throw new TypeError('Not an sd-server job handle.');
  }
  return { id: data['id'], seed: data['seed'], batch_count: data['batch_count'] };
}

export class SdcppAdapter implements Adapter {
  private config: AdapterConfig | null = null;
  private settings: SdcppSettings = readSdcppSettings({});
  private readonly fetchImpl: FetchLike;
  private readonly supplied: (() => Promise<unknown>) | undefined;
  private readonly route: string;
  /** The last capabilities read, so `prepare` stays pure (no I/O) yet asks for a preview the build has. */
  private known: SdcppCapabilities | null = null;

  constructor(options: SdcppAdapterOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.supplied = options.capabilities;
    this.route = options.route ?? 'sdcpp';
  }

  init(config: AdapterConfig): Promise<void> {
    try {
      this.settings = readSdcppSettings(config.settings);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.config = config;
    return Promise.resolve();
  }

  /** The base URL; `init` gives it. */
  get baseUrl(): string {
    if (this.config === null) throw new Error('The sd.cpp adapter was used before init.');
    return this.config.baseUrl;
  }

  private url(path: string): string {
    return joinUrl(this.baseUrl, path);
  }

  /** The capabilities, from the manager when it supplies them, else from the instance. */
  async capabilities(signal?: AbortSignal): Promise<SdcppCapabilities> {
    let document: unknown;
    if (this.supplied !== undefined) {
      document = await this.supplied();
    } else {
      const answer = await requestOk(this.fetchImpl, this.url(CAPABILITIES), {
        timeoutMs: this.settings.timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
      document = answer.body;
    }
    const capabilities = parseCapabilities(document);
    this.known = capabilities;
    return capabilities;
  }

  /** The preview to ask for, given what the build offers; null for none. */
  private previewFor(capabilities: SdcppCapabilities | null): string | null {
    const wanted = this.settings.preview === 'auto' ? AUTO_PREVIEW : this.settings.preview;
    if (wanted === 'none' || capabilities === null) return null;
    if (capabilities.imgFeatures['preview'] !== true) return null;
    return capabilities.previewModes.includes(wanted) ? wanted : null;
  }

  async describe(): Promise<RouteDescriptor[]> {
    const capabilities = await this.capabilities();
    return [
      describeCapabilities(this.route, capabilities, {
        controlNet: this.settings.controlNet,
        ipAdapter: this.settings.ipAdapter,
        preview: this.previewFor(capabilities),
      }),
    ];
  }

  /**
   * Liveness from `GET /` (SD5): any answer means the server is up, and an
   * sd-server always has its model loaded. A 5xx is degraded.
   */
  async health(): Promise<BackendHealth> {
    try {
      const answer = await request(this.fetchImpl, this.url('/'), {
        timeoutMs: this.settings.timeoutMs,
        headers: { accept: 'text/html, application/json' },
      });
      if (answer.status >= 500) {
        return {
          status: 'degraded',
          load_state: 'loaded',
          detail: `sd-server answered ${String(answer.status)}.`,
        };
      }
      return { status: 'ok', load_state: 'loaded' };
    } catch (error) {
      return {
        status: 'down',
        load_state: 'unknown',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async identify(_route: string): Promise<ModelIdentity | null> {
    return identityOf(await this.capabilities());
  }

  prepare(_route: string, request: GenerationRequest): Promise<WireRequest> {
    try {
      return Promise.resolve(prepareImgGen(request, { preview: this.previewFor(this.known) }));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async submit(_route: string, wire: WireRequest, signal: AbortSignal): Promise<JobHandle> {
    if (!isRecord(wire) || typeof wire['seed'] !== 'number') {
      throw new TypeError('Not an sd-server img_gen body.');
    }
    // The model that takes this job: the instance fingerprint a resume checks (L4).
    const capabilities = await this.capabilities(signal);
    if (!servesImages(capabilities)) {
      throw new Error('This sd-server does not serve image generation.');
    }
    const answer = await request(this.fetchImpl, this.url(IMG_GEN), {
      method: 'POST',
      body: wire,
      timeoutMs: this.settings.submitTimeoutMs,
      signal,
    });
    if (answer.status === 429) {
      throw new RejectedBeforeStart(
        `sd-server's queue is full (429)${describe(answer.body)}`,
        retryAfterSeconds(answer.headers.get('retry-after')),
      );
    }
    if (answer.status !== 202 && answer.status !== 200) {
      throw new HttpStatusError(this.url(IMG_GEN), answer.status, answer.body);
    }
    const id = isRecord(answer.body) ? answer.body['id'] : undefined;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error('sd-server accepted the job but named no job id.');
    }
    const data: SdcppJobData = {
      id,
      seed: wire['seed'],
      batch_count: typeof wire['batch_count'] === 'number' ? wire['batch_count'] : 1,
    };
    return {
      resumable: true,
      instance: { base_url: this.baseUrl, model: identityOf(capabilities) },
      data,
    };
  }

  /** The job object, or `lost` for a job sd-server no longer knows. */
  private async job(data: SdcppJobData): Promise<{ lost: string } | { job: unknown }> {
    const url = this.url(`${JOBS}/${encodeURIComponent(data.id)}`);
    const answer = await request(this.fetchImpl, url, { timeoutMs: this.settings.timeoutMs });
    if (answer.status === 404) return { lost: 'sd-server does not know the job (404).' };
    if (answer.status === 410) {
      return { lost: 'sd-server purged the job’s result (410): it ended over ten minutes ago.' };
    }
    if (answer.status !== 200) throw new HttpStatusError(url, answer.status, answer.body);
    return { job: answer.body };
  }

  async status(handle: JobHandle): Promise<JobStatus> {
    const data = jobData(handle);
    const found = await this.job(data);
    if ('lost' in found) return { state: 'lost', reason: found.lost };
    return statusOf(found.job, data);
  }

  async cancel(handle: JobHandle): Promise<void> {
    const data = jobData(handle);
    const url = this.url(`${JOBS}/${encodeURIComponent(data.id)}/cancel`);
    const answer = await request(this.fetchImpl, url, {
      method: 'POST',
      timeoutMs: this.settings.timeoutMs,
    });
    // Gone already: the next status call says so.
    if (answer.status === 404 || answer.status === 410) return;
    if (answer.status === 409) {
      throw new CancelRefused(`sd-server cannot cancel the job now${describe(answer.body)}`);
    }
    if (answer.status !== 200) throw new HttpStatusError(url, answer.status, answer.body);
  }

  async fetchResult(handle: JobHandle): Promise<FetchedResult> {
    const data = jobData(handle);
    const found = await this.job(data);
    if ('lost' in found) throw new Error(found.lost);
    if (!isRecord(found.job) || found.job['status'] !== 'completed') {
      throw new Error(`sd-server's job ${data.id} has not completed.`);
    }
    return resultOf(found.job, data);
  }
}

function describe(body: unknown): string {
  const text = errorText(body);
  return text === undefined ? '.' : `: ${text}.`;
}
