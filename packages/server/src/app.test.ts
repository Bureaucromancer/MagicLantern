// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { lookup } from 'node:dns/promises';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { Agent, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp, closeApp, REQUEST_TIMEOUT_MS } from './app.js';
import { openApiStubConfig, openApiStubServices } from './http/openapi.js';
import { makeTestApp, TEST_HOST, type TestApp } from './test-app.js';

let server: TestApp | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function within<T>(promise: Promise<T>, ms: number): Promise<T | 'hung'> {
  return Promise.race([
    promise,
    new Promise<'hung'>((resolve) => {
      setTimeout(() => {
        resolve('hung');
      }, ms).unref();
    }),
  ]);
}

describe('buildApp', () => {
  it('reads neither services nor the data directory while registering routes', async () => {
    // The OpenAPI emitter builds the app this way; every stub throws if touched.
    const app = await buildApp(openApiStubServices(), {
      config: openApiStubConfig(),
      listenPort: 7600,
      appRoot: { kind: 'api-only', looked: '/nowhere' },
    });
    await app.ready();
    await app.close();
  });

  it('has no text/plain parser, so such a body never reaches a handler', async () => {
    server = await makeTestApp();
    expect(server.app.hasContentTypeParser('text/plain')).toBe(false);
    expect(server.app.hasContentTypeParser('application/json')).toBe(true);
  });

  // Fastify's default is 0, which replaces Node's own limit with none: a peer
  // could hold a connection forever by never finishing a body.
  it('limits how long a request may take to arrive', async () => {
    server = await makeTestApp();
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(server.app.server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
    // Node refuses a headers timeout longer than the request timeout.
    expect(server.app.server.headersTimeout).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS);
  });
});

interface Answer {
  readonly status: number;
  readonly connection: string | undefined;
}

/** A GET over a real socket, answered or cut off. */
function get(
  address: string,
  port: number,
  path: string,
  agent: Agent | false = false,
): Promise<Answer | 'cut off'> {
  return new Promise((resolve) => {
    const outgoing = httpRequest(
      { host: address, port, path, agent, headers: { host: TEST_HOST } },
      (incoming) => {
        incoming.resume();
        incoming.on('end', () => {
          resolve({ status: incoming.statusCode ?? 0, connection: incoming.headers.connection });
        });
      },
    );
    outgoing.on('error', () => {
      resolve('cut off');
    });
    outgoing.end();
  });
}

function listeningPort(app: TestApp['app']): { address: string; port: number } {
  const address = app.server.address();
  return typeof address === 'object' && address !== null
    ? { address: address.address, port: address.port }
    : { address: '', port: 0 };
}

/** A route that signals when it starts and answers once `release` is called (or never). */
function holdRoute(app: TestApp['app'], path: string) {
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished = false;
  app.get(path, async () => {
    started();
    await released;
    finished = true;
    return { ok: true };
  });
  return { running, release, isFinished: () => finished };
}

describe('closeApp', () => {
  // Over a real socket, because inject never holds a connection open.
  it('ends a request still running once the backstop runs out', async () => {
    server = await makeTestApp();
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    // Never answers on its own: only the backstop can end it.
    server.app.get('/hold', async () => {
      started();
      await new Promise<never>(() => undefined);
    });
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const address = server.app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const answered = new Promise<'answered' | 'cut off'>((resolve) => {
      const outgoing = httpRequest(
        { host: '127.0.0.1', port, path: '/hold', agent: false, headers: { host: TEST_HOST } },
        (incoming) => {
          incoming.resume();
          incoming.on('end', () => {
            resolve('answered');
          });
        },
      );
      outgoing.on('error', () => {
        resolve('cut off');
      });
      outgoing.end();
    });
    await running;

    // Closed here rather than by afterEach: the close is what is under test.
    const { app, dataDir } = server;
    server = null;
    expect(await within(closeApp(app, 100), 3_000)).toBeUndefined();
    expect(await answered).toBe('cut off');
    await rm(dataDir, { recursive: true, force: true });
  });

  // A browser keeps its connection alive. The answer to a request in flight at
  // shutdown used to leave it open, so closing waited out the whole backstop.
  it('ends a keep-alive connection with the request in flight on it', async () => {
    server = await makeTestApp();
    const hold = holdRoute(server.app, '/slow');
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = listeningPort(server.app);
    const agent = new Agent({ keepAlive: true });
    try {
      const answer = get('127.0.0.1', port, '/slow', agent);
      await hold.running;
      const { app, dataDir } = server;
      server = null;
      const closing = closeApp(app, 10_000);
      setTimeout(hold.release, 100).unref();
      expect(await within(closing, 3_000)).toBeUndefined();
      expect(hold.isFinished()).toBe(true);
      expect(await answer).toEqual({ status: 200, connection: 'close' });
      await rm(dataDir, { recursive: true, force: true });
    } finally {
      agent.destroy();
    }
  });

  // Fastify runs no onResponse for a request whose client went away first; it
  // must still leave the in-flight set, or shutdown would wait out the backstop.
  it('does not wait on a request whose client has gone', async () => {
    server = await makeTestApp();
    const hold = holdRoute(server.app, '/slow');
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = listeningPort(server.app);
    const outgoing = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/slow',
      agent: false,
      headers: { host: TEST_HOST },
    });
    outgoing.on('error', () => undefined);
    outgoing.end();
    await hold.running;
    outgoing.destroy();

    const { app, dataDir } = server;
    server = null;
    expect(await within(closeApp(app, 10_000), 3_000)).toBeUndefined();
    hold.release();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('copes with an injected request still in flight at the backstop', async () => {
    server = await makeTestApp();
    const hold = holdRoute(server.app, '/slow');
    const injected = server.app.inject({
      method: 'GET',
      url: '/slow',
      headers: { host: TEST_HOST },
    });
    await hold.running;
    const { app, dataDir } = server;
    server = null;
    expect(await within(closeApp(app, 100), 3_000)).toBeUndefined();
    hold.release();
    await injected;
    await rm(dataDir, { recursive: true, force: true });
  });

  // Fastify's own answer here (`return503OnClosing`) skips every hook and is not the envelope.
  it('turns away a request that arrives while closing, in the envelope', async () => {
    server = await makeTestApp();
    const hold = holdRoute(server.app, '/slow');
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = listeningPort(server.app);
    const held = get('127.0.0.1', port, '/slow');
    await hold.running;

    // Headers begun before shutdown and finished after it began.
    const late = connect(port, '127.0.0.1');
    await once(late, 'connect');
    let raw = '';
    late.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    const ended = once(late, 'close');
    late.write(`GET /healthz HTTP/1.1\r\nHost: ${TEST_HOST}\r\n`);
    // Until the server has read them, the connection counts as idle and close ends it.
    await delay(200);

    const { app, dataDir } = server;
    server = null;
    const closing = closeApp(app, 10_000);
    await delay(100);
    late.write('\r\n');
    await within(ended, 3_000);
    hold.release();
    expect(await within(closing, 3_000)).toBeUndefined();
    expect(await held).toEqual({ status: 200, connection: 'close' });

    const [head = '', body = ''] = raw.split('\r\n\r\n');
    const headers = head.toLowerCase();
    expect(head).toMatch(/^HTTP\/1\.1 503 /);
    expect(headers).toContain('connection: close');
    expect(headers).toContain('x-content-type-options: nosniff');
    expect(headers).toContain('cache-control: no-store');
    expect(JSON.parse(body)).toEqual({
      error: 'unavailable',
      message: 'Lantern is shutting down; try again once it is back.',
    });
    await rm(dataDir, { recursive: true, force: true });
  });

  it('resolves at once with nothing in flight, after injected requests too', async () => {
    server = await makeTestApp();
    await server.request({ method: 'GET', url: '/healthz' });
    const { app, dataDir } = server;
    server = null;
    expect(await within(closeApp(app, 10_000), 1_000)).toBeUndefined();
    await rm(dataDir, { recursive: true, force: true });
  });
});

// `localhost` usually resolves to both ::1 and 127.0.0.1, and Fastify then
// listens with one server per address. `app.server` is only the first.
const localhostAddresses = [
  ...new Set((await lookup('localhost', { all: true })).map((entry) => entry.address)),
];

describe.skipIf(localhostAddresses.length < 2)('closeApp on a bind to several addresses', () => {
  async function listenOnLocalhost() {
    server = await makeTestApp({ config: { host: 'localhost' } });
    const hold = holdRoute(server.app, '/slow');
    await server.app.listen({ host: 'localhost', port: 0 });
    const { address: primary, port } = listeningPort(server.app);
    const other = localhostAddresses.find((address) => address !== primary) ?? '';
    return { hold, other, port };
  }

  it('waits for a request on an address other than app.server', async () => {
    const { hold, other, port } = await listenOnLocalhost();
    const agent = new Agent({ keepAlive: true });
    try {
      const answer = get(other, port, '/slow', agent);
      await hold.running;
      const { app, dataDir } = server!;
      server = null;
      let finishedAtClose: boolean | null = null;
      const closing = closeApp(app, 10_000).then(() => {
        finishedAtClose = hold.isFinished();
      });
      setTimeout(hold.release, 200).unref();
      expect(await within(closing, 3_000)).toBeUndefined();
      // The stores close after this resolves; the handler must be done by then.
      expect(finishedAtClose).toBe(true);
      expect(await answer).toEqual({ status: 200, connection: 'close' });
      await rm(dataDir, { recursive: true, force: true });
    } finally {
      agent.destroy();
    }
  });

  it('ends a request on another address once the backstop runs out', async () => {
    const { hold, other, port } = await listenOnLocalhost();
    const answer = get(other, port, '/slow');
    await hold.running;
    const { app, dataDir } = server!;
    server = null;
    expect(await within(closeApp(app, 100), 3_000)).toBeUndefined();
    expect(await within(answer, 1_000)).toBe('cut off');
    hold.release();
    await rm(dataDir, { recursive: true, force: true });
  });
});
