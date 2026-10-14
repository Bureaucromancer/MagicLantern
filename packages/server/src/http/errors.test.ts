// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { connect, type Socket } from 'node:net';

import { Value } from '@sinclair/typebox/value';
import { ErrorBody, ErrorCodes } from '@bureaucromancer/lantern-schema';
import { afterEach, describe, expect, it } from 'vitest';

import {
  captureLog,
  makeTestApp,
  TEST_ORIGIN,
  type TestApp,
  type TestAppOptions,
} from '../test-app.js';
import { answerClientError, pathOfIssue, rawErrorResponse, unhandledShape } from './errors.js';

let server: TestApp | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(options: TestAppOptions = { password: 'right' }): Promise<TestApp> {
  server = await makeTestApp(options);
  return server;
}

function login(app: TestApp, payload: unknown) {
  return app.request({
    method: 'POST',
    url: '/api/v1/session',
    headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

describe('validation (rule 5: refused, never rewritten)', () => {
  it('answers an unknown field with 422 naming the field', async () => {
    const app = await start();
    const response = await login(app, { password: 'right', remember: true });
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(Value.Check(ErrorBody, body)).toBe(true);
    expect(body).toMatchObject({
      error: 'invalid',
      issues: [{ path: '/remember', message: 'is not a known field' }],
    });
    expect(body.message).toContain('/remember');
    // Refused, not stripped and then accepted.
    expect(response.cookies).toEqual([]);
  });

  it('names a missing field rather than its parent', async () => {
    const app = await start();
    const response = await login(app, {});
    expect(response.statusCode).toBe(422);
    expect(response.json().issues).toEqual([{ path: '/password', message: 'is required' }]);
  });

  it('refuses a wrong type instead of coercing it', async () => {
    const app = await start();
    const response = await login(app, { password: 12345 });
    expect(response.statusCode).toBe(422);
    expect(response.json().issues).toEqual([{ path: '/password', message: 'must be string' }]);
  });

  it('reports every issue at once', async () => {
    const app = await start();
    const response = await login(app, { password: 1, a: 1, b: 2 });
    expect(
      response
        .json()
        .issues.map((issue: { path: string }) => issue.path)
        .sort(),
    ).toEqual(['/a', '/b', '/password']);
  });

  // '' is RFC 6901's pointer to the whole document; '/' would be the key "".
  it.each([['right'], null, 'right'])('refuses a body that is not an object (%j)', async (body) => {
    const app = await start();
    const response = await login(app, body);
    expect(response.statusCode).toBe(422);
    expect(Value.Check(ErrorBody, response.json())).toBe(true);
    expect(response.json().issues[0].path).toBe('');
    expect(response.json().message).toBe('The body is not valid: the whole body must be object.');
  });

  it('escapes an unknown key into a JSON pointer that names it', async () => {
    const app = await start();
    const response = await login(app, { password: 'right', 'a/b': 1, 'x~y': 2 });
    expect(response.statusCode).toBe(422);
    expect(
      response
        .json()
        .issues.map((issue: { path: string }) => issue.path)
        .sort(),
    ).toEqual(['/a~1b', '/x~0y']);
  });

  it('answers malformed JSON with 400', async () => {
    const app = await start();
    const response = await app.request({
      method: 'POST',
      url: '/api/v1/session',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: '{"password":',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'bad-request' });
  });

  it('answers a body over the limit with 413', async () => {
    const app = await start();
    const response = await app.request({
      method: 'POST',
      url: '/api/v1/session',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ password: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: 'payload-too-large' });
  });
});

describe('not found', () => {
  it.each([
    ['GET', '/api/v1/nothing-here'],
    ['POST', '/api/v1/nothing-here'],
    ['GET', '/api/v2/info'],
    ['DELETE', '/somewhere'],
  ] as const)('answers %s %s with the JSON envelope', async (method, url) => {
    const app = await start({});
    const response = await app.request({ method, url });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json()).toEqual({ error: 'not-found', message: 'No such route.' });
  });

  it('still checks Host first', async () => {
    const app = await start({});
    const response = await app.request({
      method: 'GET',
      url: '/api/v1/nothing-here',
      headers: { host: 'evil.example' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('unexpected errors', () => {
  it('answers a generic 500 and logs the cause without the request', async () => {
    const log = captureLog();
    const app = await start({ log: { level: 'error', into: log } });
    app.app.get('/explode', () => {
      throw Object.assign(new Error('EACCES: permission denied, open /home/someone/secret'), {
        code: 'EACCES',
        prompt: 'a long private prompt',
      });
    });

    const response = await app.request({ method: 'GET', url: '/explode' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'internal', message: 'Internal error' });
    expect(response.body).not.toContain('/home/someone');

    const record = log.records.find((line) => line['event'] === 'request.failed');
    expect(record).toMatchObject({ type: 'Error', code: 'EACCES', msg: 'Unhandled error' });
    expect(JSON.stringify(record)).not.toContain('a long private prompt');
  });
});

describe('pathOfIssue', () => {
  it('joins the key Ajv keeps in params', () => {
    expect(pathOfIssue({ instancePath: '', params: { additionalProperty: 'x' } })).toBe('/x');
    expect(pathOfIssue({ instancePath: '/a', params: { missingProperty: 'b' } })).toBe('/a/b');
    expect(pathOfIssue({ instancePath: '/a/0', params: {} })).toBe('/a/0');
  });

  it("is '' for the whole body, as RFC 6901 has it", () => {
    expect(pathOfIssue({ instancePath: '', params: {} })).toBe('');
  });

  it('escapes the joined key as Ajv escapes its instancePath (~ before /)', () => {
    expect(pathOfIssue({ instancePath: '', params: { additionalProperty: 'a/b' } })).toBe('/a~1b');
    expect(pathOfIssue({ instancePath: '', params: { additionalProperty: 'x~y' } })).toBe('/x~0y');
    expect(pathOfIssue({ instancePath: '', params: { additionalProperty: '~1' } })).toBe('/~01');
    expect(pathOfIssue({ instancePath: '/a~1b', params: { missingProperty: 'z/w' } })).toBe(
      '/a~1b/z~1w',
    );
  });
});

describe('other 4xx errors', () => {
  it('shows a library 4xx error only its status wording, never its message', async () => {
    const app = await start({});
    app.app.get('/conflict', () => {
      throw Object.assign(new Error('EEXIST: /home/someone/library'), { statusCode: 409 });
    });
    const response = await app.request({ method: 'GET', url: '/conflict' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'bad-request', message: 'Conflict.' });
  });

  it("keeps the wording of Fastify's own errors and of http-errors marked expose", async () => {
    const app = await start({});
    app.app.get('/exposed', () => {
      throw Object.assign(new Error('Range Not Satisfiable'), { statusCode: 416, expose: true });
    });
    expect((await app.request({ method: 'GET', url: '/exposed' })).json()).toEqual({
      error: 'bad-request',
      message: 'Range Not Satisfiable',
    });
    const empty = await app.request({
      method: 'POST',
      url: '/api/v1/session',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: '',
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({
      error: 'bad-request',
      message: "Body cannot be empty when content-type is set to 'application/json'",
    });
  });
});

describe('a URL the router cannot read', () => {
  // find-my-way refuses these before any hook runs; Fastify's own answer was
  // {"error":"Bad Request","code":"FST_ERR_BAD_URL",...} with the path echoed.
  it.each(['/%ZZ', '/api/v1/%', '/%c0%ae%c0%ae/', '/api/v1/%E0%A4%A'])(
    'answers %s with the envelope and the headers every answer carries',
    async (url) => {
      const app = await start({});
      const response = await app.request({ method: 'GET', url });
      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(Value.Check(ErrorBody, body)).toBe(true);
      expect(body).toEqual({ error: 'bad-request', message: 'The request URL is not valid.' });
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );

  it('logs it, without the path', async () => {
    const log = captureLog();
    const app = await start({ log: { level: 'info', into: log } });
    await app.request({ method: 'GET', url: '/%ZZ<script>' });
    const record = log.records.find((line) => line['event'] === 'request.bad-url');
    expect(record).toMatchObject({ code: 'FST_ERR_BAD_URL' });
    expect(JSON.stringify(record)).not.toContain('script');
  });
});

describe('a request Node cannot read', () => {
  async function rawExchange(server: TestApp, request: string): Promise<string> {
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const address = server.app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port }, () => {
        socket.write(request);
      });
      let received = '';
      socket.on('data', (chunk: Buffer) => (received += chunk.toString()));
      socket.on('close', () => {
        resolve(received);
      });
      socket.on('error', reject);
    });
  }

  function bodyOf(raw: string): unknown {
    return JSON.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4));
  }

  // Fastify's own answer was {"error":"Bad Request","message":"Client Error"}.
  it('answers a malformed request line with the envelope and closes', async () => {
    const app = await start({});
    const raw = await rawExchange(app, 'GET api/v1/info HTTP/1.1\r\nHost: localhost\r\n\r\n');
    expect(raw).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    expect(raw).toMatch(/\r\nX-Content-Type-Options: nosniff\r\n/);
    expect(raw).toMatch(/\r\nX-Frame-Options: DENY\r\n/);
    expect(raw).toMatch(/\r\nConnection: close\r\n/);
    const body = bodyOf(raw);
    expect(Value.Check(ErrorBody, body)).toBe(true);
    expect(body).toEqual({ error: 'bad-request', message: 'The request could not be read.' });
  });

  function fakeSocket(httpMessage?: { headersSent: boolean }) {
    const written: string[] = [];
    let destroyed = false;
    const socket = {
      get destroyed() {
        return destroyed;
      },
      writable: true,
      _httpMessage: httpMessage ?? null,
      write(chunk: string) {
        written.push(chunk);
        return true;
      },
      destroy() {
        destroyed = true;
        return socket;
      },
    };
    return { socket: socket as unknown as Socket, written, isDestroyed: () => destroyed };
  }

  it('answers a request that took too long to arrive with 408', () => {
    const { socket, written, isDestroyed } = fakeSocket({ headersSent: false });
    answerClientError(
      Object.assign(new Error('timeout'), { code: 'ERR_HTTP_REQUEST_TIMEOUT' }),
      socket,
    );
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^HTTP\/1\.1 408 Request Timeout\r\n/);
    expect(bodyOf(written[0] ?? '')).toEqual({
      error: 'bad-request',
      message: 'The request took too long to arrive.',
    });
    expect(isDestroyed()).toBe(true);
  });

  it('writes nothing over an answer already under way, and still closes', () => {
    const { socket, written, isDestroyed } = fakeSocket({ headersSent: true });
    answerClientError(Object.assign(new Error('parse'), { code: 'HPE_INVALID_METHOD' }), socket);
    expect(written).toEqual([]);
    expect(isDestroyed()).toBe(true);
  });

  it('builds a well-formed response', () => {
    const raw = rawErrorResponse(431, ErrorCodes.badRequest, 'Too large.');
    const [head = '', body = ''] = raw.split('\r\n\r\n');
    expect(head.split('\r\n')[0]).toBe('HTTP/1.1 431 Request Header Fields Too Large');
    expect(head).toContain(`Content-Length: ${String(Buffer.byteLength(body))}`);
    expect(JSON.parse(body)).toEqual({ error: 'bad-request', message: 'Too large.' });
  });
});

describe('unhandledShape', () => {
  it('keeps type, message, code and stack, and nothing else', () => {
    const error = Object.assign(new TypeError('bad'), { code: 'E_X', body: 'secret' });
    const shape = unhandledShape(error);
    expect(Object.keys(shape).sort()).toEqual(['code', 'message', 'stack', 'type']);
    expect(shape).toMatchObject({ type: 'TypeError', message: 'bad', code: 'E_X' });
  });

  it('copes with a thrown non-error', () => {
    expect(unhandledShape('just a string')).toEqual({ message: 'just a string' });
  });
});
