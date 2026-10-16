// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The mock adapter (EN2, D6): a real backend kind, shown only with
 * `LANTERN_DEV=1`. It implements the adapter interface in full and draws a
 * deterministic picture from the seed, the prompt and any init image, with
 * no fonts, so hashes match on every platform and Reproduce is exact.
 *
 * The backend is simulated lazily from a clock rather than with timers: a
 * job's phases (waiting, loading, running, done) are times computed at
 * submit, and `status` reads off where the clock is. One job runs at a time,
 * first come first served, like a GPU. Nothing keeps the process alive, and
 * tests can drive the clock.
 *
 * Its state lives in the adapter object: a daemon restarted with the same
 * object is a backend that kept running; a new object is a restarted backend
 * that forgot every job.
 */

import { createHash } from 'node:crypto';

import type { GenerationRequest, RouteDescriptor } from '@bureaucromancer/lantern-schema';

import { encodePng } from '../shared/png-encode.js';
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
import { assetPlaceholder } from '../shared/wire.js';
import { mockRouteDescriptor, MOCK_ROUTE_ID } from './descriptor.js';
import { isMockProfile, settingsFor } from './profiles.js';

/** What `prepare` writes: the mock's own wire format, close to sd-server's. */
export interface MockWire {
  readonly mode: string;
  readonly prompt: string;
  readonly negative_prompt: string;
  readonly width: number;
  readonly height: number;
  readonly steps: number;
  readonly cfg: number;
  readonly sampler: string;
  readonly scheduler: string;
  readonly seed: number;
  readonly batch_count: number;
  readonly denoise?: number;
  /** A placeholder in `prepare`'s output; base64 once the engine fills it. */
  readonly init_image?: unknown;
}

interface MockJob {
  readonly id: string;
  readonly route: string;
  readonly wire: MockWire;
  readonly submittedAt: number;
  /** When it starts generating; before this it waits. */
  readonly startAt: number;
  readonly endAt: number;
  /** Why it waits, in order: memory first, then the load. */
  readonly memoryUntil: number;
  readonly loadUntil: number;
  readonly fails: boolean;
  readonly yields: boolean;
  cancelledAt: number | null;
}

export interface MockOptions {
  /** Epoch milliseconds; `Date.now` by default. Tests drive it. */
  readonly now?: () => number;
}

const MODEL_A: ModelIdentity = {
  kind: 'file',
  path: '/models/mock-sdxl.safetensors',
  stem: 'mock-sdxl',
};
const MODEL_B: ModelIdentity = {
  kind: 'file',
  path: '/models/mock-flux.safetensors',
  stem: 'mock-flux',
};

/** The model the mock serves, as the development catalog fingerprints it. */
export const MOCK_MODEL_IDENTITY = MODEL_A;

export const MOCK_GENERATOR = 'lantern-mock 1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A uniform number in [0, 1) from the seed, so a rerun of a job behaves as the job did. */
function unitFromSeed(seed: number, salt: string): number {
  const digest = createHash('sha256')
    .update(`${salt}:${String(seed)}`)
    .digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}

/**
 * The picture: 8 × 8 pixel tiles whose colours come from a generator seeded
 * by the seed, the prompt and the init image. Same inputs, same pixels.
 */
export function drawMockImage(wire: MockWire, seed: number): Uint8Array {
  const key = createHash('sha256')
    .update(String(seed))
    .update('\0')
    .update(wire.prompt)
    .update('\0')
    .update(typeof wire.init_image === 'string' ? wire.init_image : '')
    .digest();
  let state = key.readUInt32BE(0) || 1;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  const { width, height } = wire;
  const tilesX = Math.ceil(width / 8);
  const tiles: number[] = [];
  for (let tile = 0; tile < tilesX * Math.ceil(height / 8); tile += 1) tiles.push(next());
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const colour = tiles[Math.floor(y / 8) * tilesX + Math.floor(x / 8)] ?? 0;
      const at = (y * width + x) * 4;
      rgba[at] = colour & 0xff;
      rgba[at + 1] = (colour >>> 8) & 0xff;
      rgba[at + 2] = (colour >>> 16) & 0xff;
      rgba[at + 3] = 0xff;
    }
  }
  return rgba;
}

export class MockAdapter implements Adapter {
  private config: AdapterConfig | null = null;
  private settings = settingsFor({});
  private readonly now: () => number;
  private readonly jobs = new Map<string, MockJob>();
  private sequence = 0;
  private submits = 0;
  private accepted = 0;
  /** When the GPU is next free. */
  private busyUntil = 0;
  /** Routes loaded so far (orchd routes start cold). */
  private readonly loaded = new Set<string>();

  constructor(options: MockOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  init(config: AdapterConfig): Promise<void> {
    this.config = config;
    const profile = config.settings['profile'];
    const settings: Record<string, unknown> = { ...config.settings };
    if (profile !== undefined && !isMockProfile(profile)) {
      return Promise.reject(new TypeError(`Unknown mock profile: ${JSON.stringify(profile)}.`));
    }
    this.settings = settingsFor(settings);
    return Promise.resolve();
  }

  private get baseUrl(): string {
    return this.config?.baseUrl ?? 'mock://local';
  }

  private routes(): string[] {
    const routes = this.config?.settings['routes'];
    return Array.isArray(routes) && routes.every((route) => typeof route === 'string')
      ? routes
      : [MOCK_ROUTE_ID];
  }

  describe(): Promise<RouteDescriptor[]> {
    return Promise.resolve(
      this.routes().map((route) => mockRouteDescriptor(route, this.settings.profile)),
    );
  }

  health(): Promise<BackendHealth> {
    const cold = this.settings.profile === 'orchd';
    const routes = Object.fromEntries(
      this.routes().map((route) => [
        route,
        {
          status: 'ok' as const,
          load_state: cold && !this.loaded.has(route) ? ('cold' as const) : ('loaded' as const),
        },
      ]),
    );
    return Promise.resolve({ status: 'ok', load_state: cold ? 'unknown' : 'loaded', routes });
  }

  identify(_route: string): Promise<ModelIdentity | null> {
    const swapped =
      this.settings.profile === 'port_reuse' && this.submits >= this.settings.swapAfter;
    return Promise.resolve(swapped ? MODEL_B : MODEL_A);
  }

  prepare(_route: string, request: GenerationRequest): Promise<WireRequest> {
    const { sampling, geometry } = request;
    if (typeof sampling.seed !== 'number') {
      return Promise.reject(new TypeError('The mock is sent concrete seeds only.'));
    }
    const init = request.inputs?.find((input) => input.role === 'init');
    const wire: MockWire = {
      mode: request.mode,
      prompt: request.prompt.positive,
      negative_prompt: request.prompt.negative ?? '',
      width: geometry?.width ?? 512,
      height: geometry?.height ?? 512,
      steps: sampling.steps ?? 20,
      cfg: sampling.cfg ?? 7,
      sampler: sampling.sampler ?? 'euler_a',
      scheduler: sampling.scheduler ?? 'discrete',
      seed: sampling.seed,
      batch_count: request.count ?? 1,
      ...(sampling.denoise === undefined ? {} : { denoise: sampling.denoise }),
      ...(init === undefined ? {} : { init_image: assetPlaceholder(init.asset_id) }),
    };
    return Promise.resolve(wire);
  }

  async submit(route: string, wire: WireRequest, signal: AbortSignal): Promise<JobHandle> {
    signal.throwIfAborted();
    const mockWire = this.readWire(wire);
    const { profile, rejectSubmits, retryAfterS, stepMs } = this.settings;
    // The model that takes this job, before this submit counts towards a swap.
    const instance = { base_url: this.baseUrl, model: await this.identify(route) };
    this.submits += 1;
    if (profile === 'orchd' && this.submits <= rejectSubmits) {
      throw new RejectedBeforeStart('The manager yielded the slot to another client.', retryAfterS);
    }

    const now = this.now();
    const memoryUntil = now + this.settings.memoryWaitMs;
    const cold = profile === 'orchd' && !this.loaded.has(route);
    const loadUntil = Math.max(memoryUntil, this.busyUntil) + (cold ? this.settings.loadMs : 0);
    const startAt = Math.max(loadUntil, this.busyUntil);
    const endAt = startAt + mockWire.steps * stepMs * mockWire.batch_count;
    this.accepted += 1;
    const yields = profile === 'orchd' && this.accepted <= this.settings.yieldJobs;
    if (!yields) this.busyUntil = endAt;
    this.loaded.add(route);

    this.sequence += 1;
    const id = `job_${now.toString(16)}_${String(this.sequence)}`;
    this.jobs.set(id, {
      id,
      route,
      wire: mockWire,
      submittedAt: now,
      startAt,
      endAt,
      memoryUntil,
      loadUntil,
      fails: unitFromSeed(mockWire.seed, 'fail') < this.settings.failureRate,
      yields,
      cancelledAt: null,
    });

    if (profile === 'sync') {
      // A synchronous backend answers when the images exist.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.max(0, endAt - now));
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted.'));
        });
      });
    }
    return { resumable: profile !== 'sync', instance, data: { id } };
  }

  status(handle: JobHandle): Promise<JobStatus> {
    const job = this.jobOf(handle);
    if (job === undefined || this.settings.profile === 'lost') {
      return Promise.resolve({ state: 'lost', reason: 'The backend does not know this job.' });
    }
    const now = this.now();
    if (job.cancelledAt !== null && job.cancelledAt <= now) {
      return Promise.resolve({ state: 'cancelled' });
    }
    if (job.yields && now >= job.memoryUntil) {
      return Promise.resolve({
        state: 'failed',
        started: false,
        retry_after_s: this.settings.retryAfterS,
        reason: 'The job timed out in the manager queue.',
      });
    }
    if (now < job.startAt) {
      return Promise.resolve({
        state: 'queued',
        ...(this.settings.profile === 'orchd'
          ? {
              waiting:
                now < job.memoryUntil
                  ? { reason: 'memory' as const, detail: 'Waiting for VRAM.' }
                  : now < job.loadUntil
                    ? { reason: 'loading' as const, detail: 'Loading the model.' }
                    : { reason: 'engine_queue' as const },
            }
          : {}),
      });
    }
    if (now < job.endAt) {
      const fraction = (now - job.startAt) / (job.endAt - job.startAt);
      const total = job.wire.steps;
      return Promise.resolve({
        state: 'running',
        progress:
          this.settings.profile === 'sdserver'
            ? { step: Math.min(total, Math.floor(fraction * total) + 1), total_steps: total }
            : { fraction },
      });
    }
    if (this.settings.profile === 'sdserver' && now > job.endAt + this.settings.retentionMs) {
      this.jobs.delete(job.id);
      return Promise.resolve({ state: 'lost', reason: 'The result was purged (410).' });
    }
    if (job.fails) {
      return Promise.resolve({
        state: 'failed',
        started: true,
        reason: 'The mock failed, as asked.',
      });
    }
    // sd-server returns the images with the final status.
    return Promise.resolve(
      this.settings.profile === 'sdserver'
        ? { state: 'done', result: this.resultOf(job) }
        : { state: 'done' },
    );
  }

  cancel(handle: JobHandle): Promise<void> {
    const job = this.jobOf(handle);
    if (job === undefined) return Promise.resolve();
    const now = this.now();
    const running = now >= job.startAt && now < job.endAt;
    if (now >= job.endAt) return Promise.resolve();
    if (this.settings.profile === 'sync' || (running && this.settings.profile === 'sdserver')) {
      return Promise.reject(new CancelRefused('The backend cannot cancel a running job (409).'));
    }
    job.cancelledAt = now;
    // A cancelled job frees the GPU at once; later jobs keep their times (a simplification).
    return Promise.resolve();
  }

  fetchResult(handle: JobHandle): Promise<FetchedResult> {
    const job = this.jobOf(handle);
    if (job === undefined) return Promise.reject(new Error('The backend does not know this job.'));
    if (this.now() < job.endAt) return Promise.reject(new Error('The job has not finished.'));
    return Promise.resolve(this.resultOf(job));
  }

  private resultOf(job: MockJob): FetchedResult {
    const { wire } = job;
    const outputs = Array.from({ length: wire.batch_count }, (_, index) => {
      const seed = wire.seed + index;
      const parameters =
        `${wire.prompt}\nNegative prompt: ${wire.negative_prompt}\n` +
        `Steps: ${String(wire.steps)}, Sampler: ${wire.sampler}, CFG scale: ${String(wire.cfg)}, ` +
        `Seed: ${String(seed)}, Size: ${String(wire.width)}x${String(wire.height)}, Generator: ${MOCK_GENERATOR}`;
      return {
        index,
        seed,
        bytes: encodePng(drawMockImage(wire, seed), wire.width, wire.height, { parameters }),
      };
    });
    return {
      outputs,
      metadata: { job_id: job.id, generator: MOCK_GENERATOR, seed: wire.seed, steps: wire.steps },
      generator: MOCK_GENERATOR,
    };
  }

  private jobOf(handle: JobHandle): MockJob | undefined {
    const data = handle.data;
    const id = isRecord(data) && typeof data['id'] === 'string' ? data['id'] : undefined;
    return id === undefined ? undefined : this.jobs.get(id);
  }

  private readWire(wire: WireRequest): MockWire {
    if (!isRecord(wire) || typeof wire['seed'] !== 'number' || typeof wire['prompt'] !== 'string') {
      throw new TypeError('Not a mock wire request.');
    }
    return wire as unknown as MockWire;
  }
}
