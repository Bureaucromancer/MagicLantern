// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Test doubles for sd-server: the SD8 fixtures, and a fake instance over
 * `node:http` that behaves as the pinned build's native API does (job ids,
 * states, results inline with the final status, 404 and 410, 409 for a
 * running job's cancel, 429 when full), at an optional path prefix (L1). A
 * test can queue fixture answers ahead of its own behaviour, so a contract
 * test replays recorded exchanges and an engine test runs jobs end to end.
 *
 * A test helper: never packed.
 */

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

/** The build Lemonade pins, whose fixtures these are. */
export const PINNED_BUILD = 'master-894-017cc8e';

const FIXTURES = fileURLToPath(new URL('../../../../../fixtures/', import.meta.url));

/** A fixture file, parsed. */
export function readFixture(relative: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}${relative}`, 'utf8')) as unknown;
}

/** The pinned build's capabilities (SDXL on Vulkan), a fresh copy. */
export function pinnedCapabilities(): Record<string, unknown> {
  return readFixture(`sdcpp/${PINNED_BUILD}/capabilities.json`) as Record<string, unknown>;
}

export interface Exchange {
  readonly request: { readonly method: string; readonly path: string };
  readonly response: { readonly status: number; readonly body: unknown };
}

/** The pinned build's job exchanges, by name. */
export function pinnedExchanges(): Record<string, Exchange> {
  return readFixture(`sdcpp/${PINNED_BUILD}/jobs.json`) as Record<string, Exchange>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Capabilities as a later build reports them (master at `2988060`): native
 * previews (`features_by_mode.img_gen.preview`, `preview_modes`) and the VAE
 * tile sizes renamed to w and h. Derived from the pinned fixture, so the
 * difference is exactly what feature detection must notice.
 */
export function withPreviews(capabilities: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(capabilities);
  const features = copy['features_by_mode'];
  if (isRecord(features) && isRecord(features['img_gen'])) features['img_gen']['preview'] = true;
  copy['preview_modes'] = ['none', 'proj', 'tae', 'vae'];
  const defaults = copy['defaults_by_mode'];
  if (isRecord(defaults) && isRecord(defaults['img_gen'])) {
    const tiling = defaults['img_gen']['vae_tiling_params'];
    if (isRecord(tiling)) {
      defaults['img_gen']['vae_tiling_params'] = {
        enabled: tiling['enabled'],
        temporal_tiling: tiling['temporal_tiling'],
        tile_size_w: tiling['tile_size_x'],
        tile_size_h: tiling['tile_size_y'],
        target_overlap: tiling['target_overlap'],
        rel_size_w: tiling['rel_size_x'],
        rel_size_h: tiling['rel_size_y'],
        extra_tiling_args: tiling['extra_tiling_args'],
      };
    }
  }
  return copy;
}

/** Capabilities for another model on the same instance (port reuse, A26). */
export function withModel(
  capabilities: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const copy = structuredClone(capabilities);
  const file = path.split('/').at(-1) ?? path;
  copy['model'] = { name: file, stem: file.replace(/\.[^.]+$/, ''), path };
  return copy;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(data, crc32(head.subarray(4))), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * A PNG as sd-server writes one: RGB, with its `parameters` as a tEXt chunk
 * after IHDR, ending in `SDCPP: {json}`. The pixels follow the seed.
 */
export function sdserverPng(
  seed: number,
  sdcpp: Readonly<Record<string, unknown>>,
  size = 8,
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let state = (seed % 2 ** 31) + 1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size * 3; x += 1) {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      raw[y * (size * 3 + 1) + 1 + x] = state >>> 24;
    }
  }
  const prompt = typeof sdcpp['prompt'] === 'object' ? JSON.stringify(sdcpp['prompt']) : '';
  const parameters = `${prompt}\nSeed: ${String(seed)}, Version: stable-diffusion.cpp, SDCPP: ${JSON.stringify(sdcpp)}`;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk(
      'tEXt',
      Buffer.concat([Buffer.from('parameters\0', 'latin1'), Buffer.from(parameters, 'utf8')]),
    ),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The generator a fake instance reports in its images. */
export const FAKE_GENERATOR = {
  name: 'stable-diffusion.cpp',
  version: PINNED_BUILD,
  commit: '017cc8e',
};

interface FakeJob {
  readonly id: string;
  readonly body: Record<string, unknown>;
  readonly created: number;
  status: 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled';
  started: number | null;
  completed: number | null;
  /** Generating until released (a test holds it to look at it running). */
  held: boolean;
  fails: boolean;
}

export interface FakeSdServerOptions {
  /** A path the native API sits under, as through orchd's proxy (L1). */
  readonly prefix?: string;
  readonly capabilities?: Record<string, unknown>;
  /** Hold every job generating until `release`. */
  readonly hold?: boolean;
}

export interface ReceivedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly headers: IncomingMessage['headers'];
}

/** A fake sd-server. Jobs run one at a time, in the order they arrived. */
export class FakeSdServer {
  readonly received: ReceivedRequest[] = [];
  /** Answers to give before the fake's own behaviour, for the next matching requests. */
  readonly scripted: Exchange[] = [];
  capabilities: Record<string, unknown>;
  hold: boolean;
  /** The next submits to turn away with 429. */
  rejectSubmits = 0;
  /** Whether the next job fails as it ends. */
  failNext = false;
  private readonly prefix: string;
  private readonly jobs = new Map<string, FakeJob>();
  private readonly expired = new Set<string>();
  private sequence = 0;
  private server: Server | null = null;
  private port = 0;

  private constructor(options: FakeSdServerOptions) {
    this.prefix = (options.prefix ?? '').replace(/\/+$/, '');
    this.capabilities = options.capabilities ?? pinnedCapabilities();
    this.hold = options.hold ?? false;
  }

  static async start(options: FakeSdServerOptions = {}): Promise<FakeSdServer> {
    const fake = new FakeSdServer(options);
    await fake.listen();
    return fake;
  }

  /** The base URL an adapter is configured with: the origin and the prefix. */
  get url(): string {
    return `http://127.0.0.1:${String(this.port)}${this.prefix}`;
  }

  /** The address without the prefix, as Lemonade would report it (plus `/v1`). */
  get origin(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  private async listen(port = 0): Promise<void> {
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        resolve();
      });
    });
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
  }

  /** Stops answering; the port goes away. */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server === null) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  /** Comes back on the same port, having forgotten every job, as a restarted instance does. */
  async restart(capabilities?: Record<string, unknown>): Promise<void> {
    const port = this.port;
    await this.close();
    this.jobs.clear();
    this.expired.clear();
    if (capabilities !== undefined) this.capabilities = capabilities;
    await this.listen(port);
  }

  /** The submitted bodies, in order. */
  get submitted(): Record<string, unknown>[] {
    return this.received
      .filter((entry) => entry.method === 'POST' && entry.path.endsWith('/img_gen'))
      .map((entry) => entry.body as Record<string, unknown>);
  }

  /** Lets a held job finish. */
  release(id?: string): void {
    for (const job of this.jobs.values()) {
      if (id === undefined || job.id === id) job.held = false;
    }
    this.tick();
  }

  /** Purges a job's result, as ten minutes after its end does (410, then 404). */
  expire(id: string): void {
    this.jobs.delete(id);
    this.expired.add(id);
  }

  /** The ids of every job it has. */
  get jobIds(): string[] {
    return [...this.jobs.keys()];
  }

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** Moves jobs along: the first queued one starts when nothing generates; unheld ones finish. */
  private tick(): void {
    for (const job of this.jobs.values()) {
      if (job.status === 'generating' && !job.held) {
        job.status = job.fails ? 'failed' : 'completed';
        job.completed = this.now();
      }
    }
    const generating = [...this.jobs.values()].some((job) => job.status === 'generating');
    if (generating) return;
    const next = [...this.jobs.values()].find((job) => job.status === 'queued');
    if (next !== undefined) {
      next.status = 'generating';
      next.started = this.now();
      next.held = this.hold;
    }
  }

  private send(
    response: ServerResponse,
    status: number,
    body: unknown,
    type = 'application/json',
  ): void {
    response.writeHead(status, { 'content-type': type });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const part of request) chunks.push(part as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    let body: unknown = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const method = request.method ?? 'GET';
    const fullPath = (request.url ?? '/').split('?')[0] ?? '/';
    this.received.push({ method, path: fullPath, body, headers: request.headers });
    if (!fullPath.startsWith(this.prefix)) {
      this.send(response, 404, { error: 'not found' });
      return;
    }
    const path = fullPath.slice(this.prefix.length) || '/';

    const scriptedAt = this.scripted.findIndex(
      (exchange) => exchange.request.method === method && exchange.request.path === path,
    );
    if (scriptedAt >= 0) {
      const [exchange] = this.scripted.splice(scriptedAt, 1);
      if (exchange !== undefined) {
        this.send(response, exchange.response.status, exchange.response.body);
        return;
      }
    }

    this.tick();
    if (method === 'GET' && path === '/') {
      this.send(response, 200, '<!doctype html><title>sd-server</title>', 'text/html');
      return;
    }
    if (method === 'GET' && path === '/sdcpp/v1/capabilities') {
      this.send(response, 200, this.capabilities);
      return;
    }
    if (method === 'POST' && path === '/sdcpp/v1/img_gen') {
      this.submit(body, response);
      return;
    }
    const match = /^\/sdcpp\/v1\/jobs\/([A-Za-z0-9_-]+)(\/cancel)?$/.exec(path);
    if (match !== null) {
      const id = match[1] ?? '';
      const job = this.jobs.get(id);
      if (job === undefined) {
        if (this.expired.has(id)) this.send(response, 410, { error: 'job expired' });
        else this.send(response, 404, { error: 'job not found' });
        return;
      }
      if (match[2] === undefined && method === 'GET') {
        this.send(response, 200, this.jobJson(job));
        return;
      }
      if (match[2] !== undefined && method === 'POST') {
        if (job.status === 'queued') {
          job.status = 'cancelled';
          job.completed = this.now();
          this.send(response, 200, this.jobJson(job));
        } else if (job.status === 'generating') {
          this.send(response, 409, {
            error: 'job is currently generating and cannot be interrupted yet',
          });
        } else {
          this.send(response, 200, this.jobJson(job));
        }
        return;
      }
    }
    this.send(response, 404, { error: 'not found' });
  }

  private submit(body: unknown, response: ServerResponse): void {
    if (!isRecord(body)) {
      this.send(response, 400, { error: 'invalid json' });
      return;
    }
    if (this.rejectSubmits > 0) {
      this.rejectSubmits -= 1;
      this.send(response, 429, { error: 'job queue is full' });
      return;
    }
    if (typeof body['prompt'] !== 'string' || typeof body['seed'] !== 'number') {
      this.send(response, 400, { error: 'invalid generation parameters' });
      return;
    }
    this.sequence += 1;
    const created = this.now();
    const id = `job_${created.toString(16)}_${String(this.sequence).padStart(8, '0')}`;
    this.jobs.set(id, {
      id,
      body,
      created,
      status: 'queued',
      started: null,
      completed: null,
      held: this.hold,
      fails: this.failNext,
    });
    this.failNext = false;
    this.tick();
    this.send(response, 202, {
      id,
      kind: 'img_gen',
      status: 'queued',
      created,
      poll_url: `/sdcpp/v1/jobs/${id}`,
    });
  }

  private jobJson(job: FakeJob): Record<string, unknown> {
    const queue = [...this.jobs.values()].filter((other) => other.status === 'queued');
    const json: Record<string, unknown> = {
      id: job.id,
      kind: 'img_gen',
      status: job.status,
      created: job.created,
      started: job.started,
      completed: job.completed,
      queue_position: job.status === 'queued' ? queue.indexOf(job) + 1 : 0,
      result: null,
      error: null,
    };
    const preview = job.body['preview'];
    if (job.status === 'generating' && typeof preview === 'string' && preview !== 'none') {
      const params = job.body['sample_params'];
      const steps =
        isRecord(params) && typeof params['sample_steps'] === 'number'
          ? params['sample_steps']
          : 20;
      json['preview'] = {
        pass: 1,
        step: Math.min(7, steps),
        total_steps: steps,
        b64_json: sdserverPng(1, {}).toString('base64'),
      };
    }
    if (job.status === 'completed') {
      const seed = job.body['seed'] as number;
      const count = typeof job.body['batch_count'] === 'number' ? job.body['batch_count'] : 1;
      const model = isRecord(this.capabilities['model']) ? this.capabilities['model']['name'] : '';
      json['result'] = {
        output_format: 'png',
        images: Array.from({ length: count }, (_, index) => ({
          index,
          b64_json: sdserverPng(seed + index, {
            schema: 'sdcpp.image.params/v1',
            mode: 'img_gen',
            generator: FAKE_GENERATOR,
            seed: seed + index,
            width: job.body['width'],
            height: job.body['height'],
            prompt: { positive: job.body['prompt'], negative: job.body['negative_prompt'] },
            models: { model },
          }).toString('base64'),
        })),
      };
    }
    if (job.status === 'failed') {
      json['error'] = { code: 'generation_failed', message: 'generate_image returned no results' };
    }
    if (job.status === 'cancelled') {
      json['error'] = { code: 'cancelled', message: 'job cancelled by client' };
    }
    return json;
  }
}
