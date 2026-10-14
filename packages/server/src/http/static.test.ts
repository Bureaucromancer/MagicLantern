// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { captureLog, makeTestApp, tempRoot, type TestApp } from '../test-app.js';
import { isReservedPath } from './static.js';

const SHELL = '<!doctype html><title>Lantern</title><div id="root"></div>';

let root: string;
let server: TestApp | null = null;

beforeEach(async () => {
  root = await tempRoot('lantern-app-');
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), SHELL);
  await writeFile(join(root, 'assets', 'index-abc123.js'), 'console.log(1);');
  await writeFile(join(root, '.env'), 'SECRET=1');
  // An operator-chosen root may hold anything; none of it may answer for /api.
  await mkdir(join(root, 'api', 'v1'), { recursive: true });
  await writeFile(join(root, 'api', 'v1', 'info'), 'from disk');
  await writeFile(join(root, 'api', 'secret.txt'), 'from disk');
  await mkdir(join(root, 'v1'));
  await writeFile(join(root, 'v1', 'models'), 'from disk');
});

afterEach(async () => {
  await server?.close();
  server = null;
  await rm(root, { recursive: true, force: true });
});

async function start(options: Parameters<typeof makeTestApp>[0] = {}): Promise<TestApp> {
  server = await makeTestApp({ appRoot: { kind: 'served', root, detected: false }, ...options });
  return server;
}

describe('isReservedPath', () => {
  it.each([
    '/api',
    '/api/',
    '/api/v1/info',
    '/%61pi/v1/info',
    '/API/v1/info',
    '/api%2Fv1',
    '/healthz',
    '/healthz/extra',
    '/v1',
    '/v1/models',
    '/api/v1/info?x=1',
  ])('reserves %s', (url) => {
    expect(isReservedPath(url)).toBe(true);
  });

  it.each([
    '/',
    '/index.html',
    '/assets/index.js',
    '/l/lib_x/generate',
    '/apiary',
    '/v10',
    '/%E0%A4%A',
  ])('leaves %s to the app', (url) => {
    expect(isReservedPath(url)).toBe(false);
  });
});

describe('serving the built app', () => {
  it('serves index.html at the root, revalidated on every load', async () => {
    const { request } = await start();
    const response = await request({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(SHELL);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it('caches hashed assets for a year', async () => {
    const { request } = await start();
    const response = await request({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it.each(['/l/lib_01JA2B3C4D5E6F7G8H9JKMNPQR/generate', '/login', '/deep/link?x=1'])(
    'answers the app shell for the client route %s',
    async (url) => {
      const { request } = await start();
      const response = await request({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(SHELL);
      expect(response.headers['cache-control']).toBe('no-cache');
    },
  );

  it('answers HEAD for a client route', async () => {
    const { request } = await start();
    expect((await request({ method: 'HEAD', url: '/login' })).statusCode).toBe(200);
  });

  it('serves the shell without a session in password mode', async () => {
    const { request } = await start({ password: 'pw' });
    expect((await request({ method: 'GET', url: '/' })).statusCode).toBe(200);
    expect((await request({ method: 'GET', url: '/login' })).statusCode).toBe(200);
  });

  it('answers a missing asset with 404, not the shell', async () => {
    const { request } = await start();
    const response = await request({ method: 'GET', url: '/assets/index-old999.js' });
    expect(response.statusCode).toBe(404);
  });

  it('falls back only for GET and HEAD', async () => {
    const { request } = await start();
    const response = await request({ method: 'DELETE', url: '/login' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not-found' });
  });

  it('does not serve dotfiles', async () => {
    const { request } = await start();
    const response = await request({ method: 'GET', url: '/.env' });
    expect(response.body).not.toContain('SECRET');
  });

  it.each([
    '/api/secret.txt',
    '/api/v1/nothing',
    '/%61pi/secret.txt',
    '/%61pi/v1/info',
    '/API/secret.txt',
    '/healthz/extra',
    '/v1/models',
  ])('never answers reserved %s from disk or with the shell', async (url) => {
    const { request } = await start();
    const response = await request({ method: 'GET', url });
    expect(response.body).not.toContain('from disk');
    expect(response.body).not.toBe(SHELL);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
  });

  it('routes /%61pi/v1/info to the API, not the file', async () => {
    const { request } = await start();
    const response = await request({ method: 'GET', url: '/%61pi/v1/info' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: 'lantern' });
  });

  // A rebuild empties dist under a running daemon. Fastify's answer from inside
  // the not-found handler was a plain-text '404 Not Found' and a warning.
  it('answers the JSON 404 for a client route while index.html is missing', async () => {
    const log = captureLog();
    const { request } = await start({ log: { level: 'warn', into: log } });
    expect((await request({ method: 'GET', url: '/login' })).statusCode).toBe(200);
    await rm(join(root, 'index.html'));

    const response = await request({ method: 'GET', url: '/login' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json()).toEqual({ error: 'not-found', message: 'No such route.' });
    const events = log.records.map((line) => line['event']);
    expect(events).toContain('app.shell-missing');

    await writeFile(join(root, 'index.html'), SHELL);
    expect((await request({ method: 'GET', url: '/login' })).body).toBe(SHELL);
  });

  it('keeps its own cache policy over the no-store every other answer gets', async () => {
    const { request } = await start();
    expect((await request({ method: 'GET', url: '/login' })).headers['cache-control']).toBe(
      'no-cache',
    );
    const missing = await request({ method: 'GET', url: '/assets/index-old999.js' });
    expect(missing.headers['cache-control']).toBe('no-store');
  });

  it('answers a malformed escape with the envelope, not the shell', async () => {
    const { request } = await start();
    const response = await request({ method: 'GET', url: '/l/%E0%A4%A/generate' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'bad-request' });
  });

  it('applies the Host check to static files too', async () => {
    const { request } = await start();
    const response = await request({ method: 'GET', url: '/', headers: { host: 'evil.example' } });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toBe(SHELL);
  });
});

describe('without a built app', () => {
  it('answers JSON 404 for every unknown path', async () => {
    server = await makeTestApp();
    const response = await server.request({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not-found', message: 'No such route.' });
  });
});
