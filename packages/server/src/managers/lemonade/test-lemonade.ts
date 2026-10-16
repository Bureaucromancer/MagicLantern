// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * A fake Lemonade over `node:http`: `GET /api/v1/health` (and `/v1/health`)
 * reporting whatever children a test loads, in the shape of the fixture, with
 * an optional API key. Children are sd-server addresses, reported as
 * Lemonade does: the origin plus `/v1`.
 *
 * A test helper: never packed.
 */

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(
  new URL('../../../../../fixtures/lemonade/0c8169f/health.json', import.meta.url),
);

/** Lemonade's health as the fixture has it, a fresh copy. */
export function lemonadeHealth(): Record<string, unknown> {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
}

export interface LemonadeChild {
  readonly name: string;
  /** The child's origin, e.g. a fake sd-server's; reported with `/v1`. */
  readonly origin: string;
  readonly recipe?: string;
  readonly status?: string;
  readonly checkpoint?: string;
}

export class FakeLemonade {
  children: LemonadeChild[] = [];
  /** When set, requests without `Authorization: Bearer <key>` get 401. */
  apiKey: string | null = null;
  readonly received: { path: string; authorization: string | undefined }[] = [];
  private server: Server | null = null;
  private port = 0;

  static async start(): Promise<FakeLemonade> {
    const fake = new FakeLemonade();
    const server = createServer((request, response) => {
      fake.handle(request, response);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    fake.port = (server.address() as AddressInfo).port;
    fake.server = server;
    return fake;
  }

  get url(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

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

  /** The health document for the children loaded now. */
  health(): Record<string, unknown> {
    const document = lemonadeHealth();
    const llm = (document['all_models_loaded'] as Record<string, unknown>[])[0];
    document['all_models_loaded'] = [
      llm,
      ...this.children.map((child, i) => ({
        model_name: child.name,
        checkpoint: child.checkpoint ?? `example/${child.name}:${child.name}.safetensors`,
        type: 'image',
        device: 'gpu',
        backend_url: `${child.origin}/v1`,
        pid: 50000 + i,
        status: child.status ?? 'ready',
        backend_alive: true,
        backend_health: 'ready',
        loaded: true,
        pinned: false,
        recipe: child.recipe ?? 'sd-cpp',
        recipe_options: { 'sd-cpp_backend': 'vulkan' },
        is_busy: false,
        is_streaming: false,
        last_use: 1760500267456,
      })),
    ];
    return document;
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const authorization = request.headers.authorization;
    this.received.push({ path, authorization });
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (path !== '/api/v1/health' && path !== '/v1/health') {
      send(404, { error: 'not found' });
      return;
    }
    if (this.apiKey !== null && authorization !== `Bearer ${this.apiKey}`) {
      send(401, { error: 'unauthorized' });
      return;
    }
    send(200, this.health());
  }
}
