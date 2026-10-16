// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * sd-server's job objects, read (SD3, SD4).
 *
 * - **States.** `queued` is waiting in sd-server's own queue (another client
 *   got there first; Lantern never queues more than one job per group);
 *   `generating` is running; `completed`, `failed` and `cancelled` are
 *   final. A failure is always after start: sd-server only fails a job it
 *   ran, and turns one away before start with a 429 at submit instead.
 * - **Progress** is steps, and only while a preview is on: the job carries
 *   `preview: {pass, step, total_steps, b64_json}` on builds that have native
 *   previews. Steps restart at each pass (a batch item, the hires pass).
 * - **Results** come with the final status, as base64 PNGs. Each carries a
 *   `parameters` tEXt chunk whose `SDCPP: {json}` section is the
 *   authoritative record: the seed that output used and the generator's
 *   version and commit, which no endpoint reports.
 * - **`backend_response`** keeps the job's own fields and each output's
 *   parsed metadata, never image bytes.
 */

import { readPngText } from '../shared/png-text.js';
import type { FetchedOutput, FetchedResult, JobProgress, JobStatus } from '../shared/types.js';

/** What the adapter keeps in a handle: the job id, and the seed and count it was sent. */
export interface SdcppJobData {
  readonly id: string;
  readonly seed: number;
  readonly batch_count: number;
}

/** sd-server's own record of an image (`parameters`, `SDCPP: {json}`). */
export interface SdcppImageMetadata {
  /** The parsed `SDCPP` JSON, when the image carried it. */
  readonly sdcpp: Readonly<Record<string, unknown>> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SDCPP_MARKER = 'SDCPP: ';

/**
 * The `SDCPP: {json}` section of an A1111-style `parameters` text. It is the
 * last field, and the prompt before it may contain anything, the marker
 * included, so each occurrence is tried from the first until the rest parses.
 */
export function parseSdcppSection(parameters: string): Record<string, unknown> | null {
  let at = parameters.indexOf(SDCPP_MARKER);
  while (at >= 0) {
    const rest = parameters.slice(at + SDCPP_MARKER.length).trim();
    if (rest.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(rest);
        if (isRecord(parsed)) return parsed;
      } catch {
        // Not this one: a prompt that mentions the marker.
      }
    }
    at = parameters.indexOf(SDCPP_MARKER, at + 1);
  }
  return null;
}

/** An image's `SDCPP` metadata, from its `parameters` chunk. */
export function readImageMetadata(bytes: Uint8Array): SdcppImageMetadata {
  const parameters = readPngText(bytes).find((entry) => entry.keyword === 'parameters');
  return { sdcpp: parameters === undefined ? null : parseSdcppSection(parameters.text) };
}

/** `stable-diffusion.cpp master-894-017cc8e (commit 017cc8e)`, from the metadata. */
export function generatorOf(sdcpp: Readonly<Record<string, unknown>> | null): string | undefined {
  const generator = sdcpp?.['generator'];
  if (!isRecord(generator)) return undefined;
  const name = typeof generator['name'] === 'string' ? generator['name'] : 'stable-diffusion.cpp';
  const version = typeof generator['version'] === 'string' ? generator['version'] : '';
  const commit = typeof generator['commit'] === 'string' ? generator['commit'] : '';
  if (version === '' && commit === '') return undefined;
  const base = version === '' ? name : `${name} ${version}`;
  return commit === '' || version.includes(commit) ? base : `${base} (commit ${commit})`;
}

function seedOf(sdcpp: Readonly<Record<string, unknown>> | null): number | null {
  const seed = sdcpp?.['seed'];
  return typeof seed === 'number' && Number.isSafeInteger(seed) && seed >= 0 ? seed : null;
}

/** The job's own fields, for `backend_response`: everything but the payloads. */
function jobFields(job: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of ['id', 'kind', 'status', 'created', 'started', 'completed', 'error']) {
    if (job[key] !== undefined) fields[key] = job[key];
  }
  return fields;
}

/**
 * The outputs of a completed job.
 *
 * @throws Error when it carries no image that decodes
 */
export function resultOf(job: Record<string, unknown>, data: SdcppJobData): FetchedResult {
  const result = isRecord(job['result']) ? job['result'] : {};
  const images = Array.isArray(result['images']) ? result['images'] : [];
  const outputs: FetchedOutput[] = [];
  const described: Record<string, unknown>[] = [];
  let generator: string | undefined;

  images.forEach((image: unknown, position) => {
    if (!isRecord(image) || typeof image['b64_json'] !== 'string') return;
    const bytes = new Uint8Array(Buffer.from(image['b64_json'], 'base64'));
    if (bytes.length === 0) return;
    const index =
      typeof image['index'] === 'number' && Number.isInteger(image['index'])
        ? image['index']
        : position;
    const { sdcpp } = readImageMetadata(bytes);
    generator ??= generatorOf(sdcpp);
    // The image's own record is authoritative; seed + k is the rule it follows (A1).
    const seed = seedOf(sdcpp) ?? data.seed + index;
    outputs.push({ index, bytes, seed });
    described.push({ index, bytes: bytes.length, seed, ...(sdcpp === null ? {} : { sdcpp }) });
  });
  if (outputs.length === 0) throw new Error(`sd-server's job ${data.id} completed with no images.`);

  return {
    outputs,
    metadata: {
      job: jobFields(job),
      output_format: typeof result['output_format'] === 'string' ? result['output_format'] : 'png',
      images: described,
    },
    ...(generator === undefined ? {} : { generator }),
  };
}

function progressOf(job: Record<string, unknown>): JobProgress | undefined {
  const preview = job['preview'];
  if (!isRecord(preview)) return undefined;
  const step = preview['step'];
  const total = preview['total_steps'];
  const progress: { step?: number; total_steps?: number; preview?: string } = {};
  if (typeof step === 'number' && Number.isInteger(step) && step >= 0) progress.step = step;
  if (typeof total === 'number' && Number.isInteger(total) && total > 0)
    progress.total_steps = total;
  if (typeof preview['b64_json'] === 'string' && preview['b64_json'] !== '') {
    progress.preview = `data:image/png;base64,${preview['b64_json']}`;
  }
  return Object.keys(progress).length === 0 ? undefined : progress;
}

function errorOf(job: Record<string, unknown>): string | undefined {
  const error = job['error'];
  if (!isRecord(error)) return undefined;
  const message = typeof error['message'] === 'string' ? error['message'] : '';
  const code = typeof error['code'] === 'string' ? error['code'] : '';
  if (message === '' && code === '') return undefined;
  return message === '' ? code : message;
}

/**
 * A job object as a normalised status.
 *
 * @throws Error when it is not a job object
 */
export function statusOf(job: unknown, data: SdcppJobData): JobStatus {
  const status = isRecord(job) ? job['status'] : undefined;
  if (!isRecord(job) || typeof status !== 'string') {
    throw new Error(`sd-server answered for job ${data.id} with something that is not a job.`);
  }
  switch (status) {
    case 'queued': {
      const position = job['queue_position'];
      return {
        state: 'queued',
        waiting: {
          reason: 'engine_queue',
          detail: 'Waiting in sd-server’s own queue.',
          ...(typeof position === 'number' && Number.isInteger(position) && position > 0
            ? { queue_position: position }
            : {}),
        },
      };
    }
    case 'generating': {
      const progress = progressOf(job);
      return { state: 'running', ...(progress === undefined ? {} : { progress }) };
    }
    case 'completed':
      return { state: 'done', result: resultOf(job, data) };
    case 'failed': {
      const reason = errorOf(job);
      return { state: 'failed', started: true, ...(reason === undefined ? {} : { reason }) };
    }
    case 'cancelled':
      return { state: 'cancelled' };
    default:
      throw new Error(`sd-server reported job ${data.id} in an unknown state, "${status}".`);
  }
}
