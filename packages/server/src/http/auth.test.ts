// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { PassThrough } from 'node:stream';

import fastifyCookie from '@fastify/cookie';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import * as api from '@bureaucromancer/lantern-schema';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { generateSecret, hashPassword } from '../auth/password.js';
import { createAuthService } from '../auth/service.js';
import { SESSION_TTL_MS } from '../auth/session.js';
import type { CommandContext } from '../cli/args.js';
import { createSetPasswordCommand } from '../cli/commands/set-password.js';
import { registerSessionRoutes } from '../routes/session.js';
import {
  captureLog,
  fakeLibraries,
  testModelServices,
  makeTestApp,
  TEST_ORIGIN,
  type TestApp,
  type TestAppOptions,
} from '../test-app.js';
import { isPublicApiRoute, PUBLIC_API_ROUTES, registerAuthGate, routeKey } from './auth.js';

let servers: TestApp[] = [];

afterEach(async () => {
  for (const server of servers) await server.close();
  servers = [];
});

async function start(options: TestAppOptions = {}): Promise<TestApp> {
  const server = await makeTestApp(options);
  servers.push(server);
  return server;
}

const PASSWORD = 'correct horse battery staple';

/** Every API route contract. */
const apiContracts = Object.values(api as Record<string, unknown>).filter(
  (value): value is api.RouteContract =>
    typeof value === 'object' &&
    value !== null &&
    'method' in value &&
    'schema' in value &&
    (value as api.RouteContract).path.startsWith(api.API_V1_PREFIX),
);

const isPublicContract = (route: api.RouteContract): boolean =>
  PUBLIC_API_ROUTES.has(routeKey(route.method, route.path));

/** Every API route contract except the public session routes. */
const gatedContracts = apiContracts.filter((route) => !isPublicContract(route));

describe('auth mode none', () => {
  it('reports itself, and every request is authenticated', async () => {
    const { request } = await start();
    const response = await request({ method: 'GET', url: '/api/v1/session' });
    expect(response.json()).toEqual({ mode: 'none', authenticated: true });
  });

  it('serves the API without a session', async () => {
    const { request } = await start();
    const response = await request({ method: 'GET', url: '/api/v1/info' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ name: 'lantern', version: '0.0.0-test', apiVersion: 'v1' });
  });

  it('answers sign-in with 409 auth-disabled', async () => {
    const { signIn } = await start();
    const response = await signIn('anything');
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'auth-disabled' });
    expect(response.cookies).toEqual([]);
  });

  it('stays none when configured so, even with a password set', async () => {
    const { request } = await start({ password: PASSWORD, config: { auth: { mode: 'none' } } });
    expect((await request({ method: 'GET', url: '/api/v1/info' })).statusCode).toBe(200);
  });
});

describe('the public routes', () => {
  // A new method on the session path (changing the password, say) must be a
  // decision to make public, not a side effect of sharing the path.
  it('are exactly GET, POST and DELETE /api/v1/session', () => {
    const publicContracts = apiContracts
      .filter(isPublicContract)
      .map((route) => routeKey(route.method, route.path));
    expect(publicContracts.sort()).toEqual([...PUBLIC_API_ROUTES].sort());
    expect([...PUBLIC_API_ROUTES].sort()).toEqual([
      'DELETE /api/v1/session',
      'GET /api/v1/session',
      'POST /api/v1/session',
    ]);
  });

  it.each([
    ['GET', '/api/v1/session', true],
    ['HEAD', '/api/v1/session', true],
    ['POST', '/api/v1/session', true],
    ['DELETE', '/api/v1/session', true],
    ['PUT', '/api/v1/session', false],
    ['PATCH', '/api/v1/session', false],
    ['GET', '/api/v1/info', false],
    ['GET', undefined, false],
  ] as const)('%s %s public: %s', (method, url, expected) => {
    expect(isPublicApiRoute({ method, routeOptions: { url } as never })).toBe(expected);
  });

  it('gate another method registered on the session path', async () => {
    const sessionKey = generateSecret();
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    app.decorate('services', {
      version: '0.0.0-test',
      processId: 'proc_test',
      auth: createAuthService({
        setting: 'password',
        secrets: { sessionKey, password: await hashPassword(PASSWORD) },
        cookieSecure: false,
      }),
      libraries: fakeLibraries(),
      ...testModelServices(),
    });
    await app.register(fastifyCookie);
    await app.register(
      (plugin, _options, done) => {
        registerAuthGate(plugin);
        registerSessionRoutes(plugin);
        plugin.put('/session', () => ({ reached: true }));
        plugin.patch('/session', () => ({ reached: true }));
        done();
      },
      { prefix: api.API_V1_PREFIX },
    );
    try {
      for (const method of ['PUT', 'PATCH'] as const) {
        for (const url of ['/api/v1/session', '/api/v1/%73ession']) {
          const response = await app.inject({ method, url });
          expect(response.statusCode, `${method} ${url}`).toBe(401);
          expect(response.json()).toEqual({ error: 'unauthenticated', message: 'Sign in first.' });
        }
      }
      expect((await app.inject({ method: 'GET', url: '/api/v1/session' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'HEAD', url: '/api/v1/session' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'DELETE', url: '/api/v1/session' })).statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });
});

describe('caching', () => {
  // A shared cache in front (a TLS proxy) must never replay a gated answer.
  it('marks every API answer no-store, signed in or not', async () => {
    const server = await start({ password: PASSWORD });
    const contracts = apiContracts
      .filter((route) => server.app.hasRoute({ method: route.method, url: route.path }))
      // Signing out last, so every other route is asked while still signed in.
      .sort((a, b) => Number(a.method === 'DELETE') - Number(b.method === 'DELETE'));
    expect(contracts.length).toBeGreaterThan(3);
    const check = async (label: string) => {
      for (const route of contracts) {
        const response = await server.request({
          method: route.method,
          url: route.path,
          headers: { origin: TEST_ORIGIN },
          ...(route.method === 'POST' ? { payload: { password: 'wrong' } } : {}),
        });
        expect(response.headers['cache-control'], `${label} ${route.method} ${route.path}`).toBe(
          'no-store',
        );
      }
    };
    await check('signed out');
    const signIn = await server.signIn(PASSWORD);
    expect(signIn.headers['cache-control']).toBe('no-store');
    expect(String(signIn.headers['set-cookie'])).toContain('lantern_session=');
    await check('signed in');
  });
});

describe('auth mode password', () => {
  it('is the mode when a password exists and the config says null', async () => {
    const { request } = await start({ password: PASSWORD });
    const response = await request({ method: 'GET', url: '/api/v1/session' });
    expect(response.json()).toEqual({ mode: 'password', authenticated: false });
  });

  it('refuses the API without a session', async () => {
    const { request } = await start({ password: PASSWORD });
    const response = await request({ method: 'GET', url: '/api/v1/info' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthenticated', message: 'Sign in first.' });
  });

  it('refuses every gated route that is registered', async () => {
    const { app, request } = await start({ password: PASSWORD });
    expect(gatedContracts.map((route) => route.path)).toContain('/api/v1/info');
    for (const route of gatedContracts) {
      if (!app.hasRoute({ method: route.method, url: route.path })) continue;
      const response = await request({ method: route.method, url: route.path });
      expect(response.statusCode, `${route.method} ${route.path}`).toBe(401);
    }
  });

  // The router decodes before it matches, so these are /api/v1/info to it. A
  // check on the raw URL would wave them through (StoryEngine's /%61pi hole).
  it.each([
    '/%61pi/v1/info',
    '/api/v1/%69nfo',
    '/%61%70%69/v1/info',
    '/api/v1/info?x=/api/v1/session',
  ])('gates %s as the route it matches', async (url) => {
    const { request } = await start({ password: PASSWORD });
    const response = await request({ method: 'GET', url });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('gates HEAD as well as GET', async () => {
    const { request } = await start({ password: PASSWORD });
    expect((await request({ method: 'HEAD', url: '/api/v1/info' })).statusCode).toBe(401);
  });

  it('keeps /healthz and the session routes public', async () => {
    const { request } = await start({ password: PASSWORD });
    expect((await request({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await request({ method: 'GET', url: '/api/v1/session' })).statusCode).toBe(200);
    expect((await request({ method: 'DELETE', url: '/api/v1/session' })).statusCode).toBe(204);
  });

  it('logs a wrong password with the address it came from, and never the password', async () => {
    const log = captureLog();
    const { signIn } = await start({ password: PASSWORD, log: { level: 'warn', into: log } });
    await signIn('hunter2-guess');
    const record = log.records.find((line) => line['event'] === 'auth.sign-in-failed');
    expect(record).toMatchObject({ level: 40, ip: '127.0.0.1' });
    expect(JSON.stringify(log.records)).not.toContain('hunter2-guess');

    await signIn(PASSWORD);
    expect(log.records.filter((line) => line['event'] === 'auth.sign-in-failed')).toHaveLength(1);
  });

  it('answers a wrong password with one 401', async () => {
    const { signIn } = await start({ password: PASSWORD });
    for (const attempt of ['wrong', '', PASSWORD.toUpperCase(), `${PASSWORD} `]) {
      const response = await signIn(attempt);
      expect(response.statusCode, attempt).toBe(401);
      expect(response.json()).toEqual({
        error: 'invalid-credentials',
        message: 'That password is not right.',
      });
      expect(response.cookies).toEqual([]);
    }
  });

  it('signs in with the right password and sets a strict, HttpOnly cookie', async () => {
    const { signIn, request } = await start({ password: PASSWORD });
    const response = await signIn(PASSWORD);
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');

    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toMatch(/^lantern_session=[^;]+;/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain(`Max-Age=${String(SESSION_TTL_MS / 1000)}`);
    expect(setCookie).not.toContain('Secure');

    expect((await request({ method: 'GET', url: '/api/v1/info' })).statusCode).toBe(200);
    expect((await request({ method: 'GET', url: '/api/v1/session' })).json()).toEqual({
      mode: 'password',
      authenticated: true,
    });
  });

  it('marks the cookie Secure only when cookieSecure says so', async () => {
    const { signIn } = await start({
      password: PASSWORD,
      config: { auth: { cookieSecure: true } },
    });
    expect(String((await signIn(PASSWORD)).headers['set-cookie'])).toContain('Secure');
  });

  it('signs out by clearing the cookie', async () => {
    const { signIn, request, cookies } = await start({ password: PASSWORD });
    await signIn(PASSWORD);
    const token = cookies.get('lantern_session');
    expect(token).toBeDefined();

    const response = await request({ method: 'DELETE', url: '/api/v1/session' });
    expect(response.statusCode).toBe(204);
    expect(String(response.headers['set-cookie'])).toMatch(
      /lantern_session=;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)/,
    );
    expect(cookies.has('lantern_session')).toBe(false);
  });

  describe('a tampered cookie', () => {
    async function signedIn(): Promise<{ server: TestApp; token: string }> {
      const server = await start({ password: PASSWORD });
      await server.signIn(PASSWORD);
      const token = server.cookies.get('lantern_session');
      if (token === undefined) throw new Error('no session cookie');
      return { server, token };
    }

    function withToken(server: TestApp, token: string) {
      return server.request({
        method: 'GET',
        url: '/api/v1/info',
        withCookies: false,
        headers: { cookie: `lantern_session=${token}` },
      });
    }

    it('is refused when its signature is altered', async () => {
      const { server, token } = await signedIn();
      const last = token.at(-1) === 'A' ? 'B' : 'A';
      const response = await withToken(server, `${token.slice(0, -1)}${last}`);
      expect(response.statusCode).toBe(401);
    });

    it('is refused when its payload is extended under the old signature', async () => {
      const { server, token } = await signedIn();
      const [body = '', signature = ''] = token.split('.');
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
      const forged = Buffer.from(
        JSON.stringify({ ...payload, exp: Date.now() + 10 * SESSION_TTL_MS }),
      ).toString('base64url');
      expect((await withToken(server, `${forged}.${signature}`)).statusCode).toBe(401);
    });

    it.each(['', 'garbage', '.', 'a.b.c', 'eyJ2IjoxfQ.'])(
      'is refused when it is %j',
      async (token) => {
        const { server } = await signedIn();
        expect((await withToken(server, token)).statusCode).toBe(401);
      },
    );

    it('is refused when another install signed it', async () => {
      const { server, token } = await signedIn();
      const other = await start({ password: PASSWORD });
      expect((await withToken(other, token)).statusCode).toBe(401);
      expect((await withToken(server, token)).statusCode).toBe(200);
    });
  });

  it('refuses a session once it expires', async () => {
    let now = Date.UTC(2026, 9, 1);
    const server = await start({ password: PASSWORD, now: () => now });
    await server.signIn(PASSWORD);
    expect((await server.request({ method: 'GET', url: '/api/v1/info' })).statusCode).toBe(200);
    now += SESSION_TTL_MS;
    expect((await server.request({ method: 'GET', url: '/api/v1/info' })).statusCode).toBe(401);
  });

  it('signs everyone out when the password is changed with lantern set-password', async () => {
    const first = await start({ password: PASSWORD });
    await first.signIn(PASSWORD);
    const oldToken = first.cookies.get('lantern_session');
    expect(oldToken).toBeDefined();

    const stdin = new PassThrough();
    stdin.end('a new password\n');
    const output = new PassThrough();
    const setPassword = createSetPasswordCommand(() => ({ release: () => undefined }));
    const context: CommandContext = {
      args: {
        command: 'set-password',
        dataDir: first.dataDir,
        configPath: `${first.dataDir}/none.json`,
        clear: false,
      },
      env: {},
      pid: 1,
      platform: process.platform,
      homedir: first.dataDir,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: output,
      stderr: output,
    };
    expect(await setPassword(context)).toBe(0);

    // The next start reads the new record; the old cookie no longer verifies.
    const second = await start({ dataDir: first.dataDir });
    const stale = await second.request({
      method: 'GET',
      url: '/api/v1/info',
      headers: { cookie: `lantern_session=${oldToken ?? ''}` },
    });
    expect(stale.statusCode).toBe(401);
    expect((await second.signIn(PASSWORD)).statusCode).toBe(401);
    expect((await second.signIn('a new password')).statusCode).toBe(204);
    expect((await second.request({ method: 'GET', url: '/api/v1/info' })).statusCode).toBe(200);
  });

  it('keeps sessions across a restart when nothing changed', async () => {
    const first = await start({ password: PASSWORD });
    await first.signIn(PASSWORD);
    const token = first.cookies.get('lantern_session') ?? '';
    const second = await start({ dataDir: first.dataDir });
    const response = await second.request({
      method: 'GET',
      url: '/api/v1/info',
      headers: { cookie: `lantern_session=${token}`, origin: TEST_ORIGIN },
    });
    expect(response.statusCode).toBe(200);
  });
});
