// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `GET /api/v1/events` (A31): the event bus as server-sent events.
 *
 * Each event is `id`, `event` and one `data` line of JSON. A reconnect with
 * `Last-Event-ID` first replays what was missed, or sends `reset` when that
 * id is unknown. A comment every {@link KEEPALIVE_MS} keeps proxies from
 * timing the stream out, and `X-Accel-Buffering: no` keeps nginx from holding
 * it back. Streams are ended when the daemon starts shutting down, so they do
 * not hold `app.close()` open.
 */

import type { ServerResponse } from 'node:http';

import { EventsRoute } from '@bureaucromancer/lantern-schema';

import type { StampedEvent } from '../engine/jobs/index.js';
import type { LanternApp } from '../http/types.js';

export const KEEPALIVE_MS = 15_000;

function frame(event: StampedEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export function registerEventRoutes(app: LanternApp, options: { keepaliveMs?: number } = {}): void {
  const keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;
  const open = new Set<ServerResponse>();
  app.addHook('preClose', (done) => {
    for (const response of open) response.end();
    open.clear();
    done();
  });

  app.route({
    method: EventsRoute.method,
    url: EventsRoute.url,
    schema: EventsRoute.schema,
    handler: (request, reply) => {
      const { events } = request.server.services;
      const raw = reply.raw;
      // Headers the hooks set so far (nosniff, no-store) go out with the stream.
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) raw.setHeader(name, value);
      }
      raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
      raw.setHeader('cache-control', 'no-store');
      raw.setHeader('x-accel-buffering', 'no');
      raw.setHeader('connection', 'keep-alive');
      reply.hijack();
      raw.writeHead(200);
      open.add(raw);

      const lastId = request.headers['last-event-id'];
      if (typeof lastId === 'string' && lastId !== '') {
        const missed = events.since(lastId);
        if (missed === 'reset') {
          raw.write(`event: reset\ndata: {}\n\n`);
        } else {
          for (const event of missed) raw.write(frame(event));
        }
      } else {
        // A first comment, so a client knows the stream is open.
        raw.write(': connected\n\n');
      }

      const unsubscribe = events.subscribe((event) => {
        raw.write(frame(event));
      });
      const keepalive = setInterval(() => {
        raw.write(': keepalive\n\n');
      }, keepaliveMs);
      keepalive.unref();
      const close = (): void => {
        clearInterval(keepalive);
        unsubscribe();
        open.delete(raw);
      };
      raw.on('close', close);
      request.raw.on('close', close);
    },
  });
}
