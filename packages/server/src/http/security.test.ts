// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { connect } from 'node:net';

import { Value } from '@sinclair/typebox/value';
import { ErrorBody } from '@bureaucromancer/lantern-schema';
import { afterEach, describe, expect, it } from 'vitest';

import { captureLog, makeTestApp, TEST_HOST, TEST_ORIGIN, type TestApp } from '../test-app.js';
import {
  allowedHostnames,
  allowedOriginSet,
  checkExposure,
  hasBody,
  hostnameOfHostHeader,
  isJsonContentType,
  isLoopbackHost,
  isWildcardHost,
  normalizeHostname,
  type MachineNames,
} from './security.js';

const MACHINE: MachineNames = {
  hostname: () => 'MyBox',
  interfaceAddresses: () => ['127.0.0.1', '192.168.1.20', '::1', 'fe80::1'],
};

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]'])(
    'counts %s as loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(['0.0.0.0', '::', '[::]', '192.168.1.20', 'mybox.lan', '128.0.0.1', '127.0.0.1.evil'])(
    'counts %s as exposed',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );

  // The same addresses spelled otherwise: Node binds each to loopback only.
  it.each([
    '0:0:0:0:0:0:0:1',
    '[0:0:0:0:0:0:0:1]',
    '::0:1',
    '0000::0001',
    '::ffff:127.0.0.1',
    '::FFFF:7F00:1',
    '[::ffff:127.255.255.255]',
  ])('counts %s as loopback, however it is spelled', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(['::ffff:128.0.0.1', '::ffff:192.168.1.20', '::2', 'fe80::1%en0', '127.1'])(
    'still counts %s as exposed',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

describe('isWildcardHost', () => {
  it('knows the IPv4 and IPv6 wildcards', () => {
    expect(isWildcardHost('0.0.0.0')).toBe(true);
    expect(isWildcardHost('::')).toBe(true);
    expect(isWildcardHost('[::]')).toBe(true);
    expect(isWildcardHost('127.0.0.1')).toBe(false);
  });

  // Each listens on every interface, as `::` does (the last on every IPv4 one).
  it.each(['0:0:0:0:0:0:0:0', '::0', '[0::0]', '::ffff:0.0.0.0'])(
    'knows %s for the wildcard it is',
    (host) => {
      expect(isWildcardHost(host)).toBe(true);
    },
  );
});

describe('normalizeHostname', () => {
  it.each([
    ['[::1]', '::1'],
    ['0:0:0:0:0:0:0:1', '::1'],
    ['::0', '::'],
    ['::ffff:127.0.0.1', '::ffff:7f00:1'],
    ['FE80::0001', 'fe80::1'],
    ['fe80::1%en0', 'fe80::1%en0'],
    ['LocalHost.', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
  ])('reads %s as %s', (name, normal) => {
    expect(normalizeHostname(name)).toBe(normal);
  });
});

describe('hostnameOfHostHeader', () => {
  it.each([
    ['localhost:7600', 'localhost'],
    ['LocalHost:7600', 'localhost'],
    ['localhost.:7600', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
    ['[::1]:7600', '::1'],
    ['[::1]', '::1'],
    ['[0:0:0:0:0:0:0:1]:7600', '::1'],
    ['[::ffff:127.0.0.1]:7600', '::ffff:7f00:1'],
    ['mybox.local', 'mybox.local'],
  ])('reads %s as %s', (header, hostname) => {
    expect(hostnameOfHostHeader(header)).toBe(hostname);
  });

  it.each([undefined, '', '::1', 'localhost:', 'localhost:x', '[::1', 'a:1:2', '[::1]x'])(
    'refuses %s',
    (header) => {
      expect(hostnameOfHostHeader(header)).toBeNull();
    },
  );
});

describe('allowedHostnames', () => {
  const config = { host: '127.0.0.1', allowedHosts: [], allowedOrigins: [] };

  it('is the loopback names for a loopback bind', () => {
    expect([...allowedHostnames(config, MACHINE)].sort()).toEqual([
      '127.0.0.1',
      '::1',
      'localhost',
    ]);
  });

  it('adds a specific bind address, and the extra hosts lowercased', () => {
    const names = allowedHostnames(
      { ...config, host: '192.168.1.20', allowedHosts: ['Lantern.Example.com'] },
      MACHINE,
    );
    expect(names.has('192.168.1.20')).toBe(true);
    expect(names.has('lantern.example.com')).toBe(true);
    expect(names.has('mybox')).toBe(false);
  });

  it("adds the machine's addresses and names for a wildcard bind", () => {
    const names = allowedHostnames({ ...config, host: '0.0.0.0' }, MACHINE);
    for (const name of ['192.168.1.20', 'fe80::1', 'mybox', 'mybox.local']) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it.each(['0:0:0:0:0:0:0:0', '::0', '::ffff:0.0.0.0'])(
    "adds the machine's addresses for the wildcard spelled %s",
    (host) => {
      const names = allowedHostnames({ ...config, host }, MACHINE);
      for (const name of ['192.168.1.20', 'fe80::1', 'mybox', 'mybox.local']) {
        expect(names.has(name), name).toBe(true);
      }
    },
  );

  it('holds a specific IPv6 bind in its canonical form', () => {
    const names = allowedHostnames({ ...config, host: '2001:DB8:0:0:0:0:0:1' }, MACHINE);
    expect(names.has('2001:db8::1')).toBe(true);
  });

  it('accepts both spellings when the OS reports a .local name', () => {
    const names = allowedHostnames(
      { ...config, host: '::' },
      { hostname: () => 'Eds-Mac.local', interfaceAddresses: () => [] },
    );
    expect(names.has('eds-mac.local')).toBe(true);
    expect(names.has('eds-mac')).toBe(true);
  });
});

describe('allowedOriginSet', () => {
  it('is each host on the listening port, over http and https', () => {
    const origins = allowedOriginSet(['localhost', '::1'], 7600, []);
    expect(origins).toEqual(
      new Set([
        'http://localhost:7600',
        'https://localhost:7600',
        'http://[::1]:7600',
        'https://[::1]:7600',
      ]),
    );
  });

  it("adds the default-port form a browser sends when the port is the scheme's default", () => {
    expect(allowedOriginSet(['localhost'], 80, []).has('http://localhost')).toBe(true);
    expect(allowedOriginSet(['localhost'], 443, []).has('https://localhost')).toBe(true);
    expect(allowedOriginSet(['localhost'], 7600, []).has('http://localhost')).toBe(false);
  });

  it('includes the extra origins', () => {
    expect(allowedOriginSet([], 7600, ['http://localhost:5173'])).toEqual(
      new Set(['http://localhost:5173']),
    );
  });
});

describe('isJsonContentType and hasBody', () => {
  it('accepts application/json with parameters, and nothing else', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('Application/JSON; charset=utf-8')).toBe(true);
    for (const type of [
      undefined,
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/merge-patch+json',
    ]) {
      expect(isJsonContentType(type), type).toBe(false);
    }
  });

  it("follows Fastify's rule for whether there is a body", () => {
    expect(hasBody({})).toBe(false);
    expect(hasBody({ 'content-length': '0' })).toBe(false);
    expect(hasBody({ 'content-length': '2' })).toBe(true);
    expect(hasBody({ 'transfer-encoding': 'chunked' })).toBe(true);
  });
});

describe('checkExposure (the loopback guard)', () => {
  it('allows loopback in every mode', () => {
    expect(checkExposure({ host: '127.0.0.1', mode: 'none', trustNetwork: false })).toEqual({
      kind: 'ok',
    });
    expect(checkExposure({ host: '::1', mode: 'none', trustNetwork: false }).kind).toBe('ok');
  });

  // Each was refused with "it is reachable beyond this machine", which was false.
  it.each(['0:0:0:0:0:0:0:1', '::ffff:127.0.0.1'])(
    'allows loopback spelled %s with auth mode none',
    (host) => {
      expect(checkExposure({ host, mode: 'none', trustNetwork: false }).kind).toBe('ok');
    },
  );

  it('refuses the all-zeros wildcard with auth mode none', () => {
    const verdict = checkExposure({ host: '0:0:0:0:0:0:0:0', mode: 'none', trustNetwork: false });
    expect(verdict.kind).toBe('refuse');
    expect(verdict.kind === 'refuse' && verdict.message).not.toContain('a host name counts');
  });

  it('allows any bind with a password', () => {
    expect(checkExposure({ host: '0.0.0.0', mode: 'password', trustNetwork: false }).kind).toBe(
      'ok',
    );
  });

  it.each(['0.0.0.0', '::', '192.168.1.20'])(
    'refuses %s with auth mode none, saying how to fix it',
    (host) => {
      const verdict = checkExposure({ host, mode: 'none', trustNetwork: false });
      expect(verdict.kind).toBe('refuse');
      if (verdict.kind !== 'refuse') return;
      expect(verdict.message).toContain(host);
      expect(verdict.message).toContain('lantern set-password');
      expect(verdict.message).toContain('trustNetwork');
    },
  );

  it('says why a host name counts as exposed', () => {
    const verdict = checkExposure({ host: 'mybox.lan', mode: 'none', trustNetwork: false });
    expect(verdict.kind === 'refuse' && verdict.message).toContain('a host name counts');
  });

  it('warns, with the fact in the sentence, when trustNetwork allows it', () => {
    const verdict = checkExposure({ host: '0.0.0.0', mode: 'none', trustNetwork: true });
    expect(verdict.kind).toBe('warn');
    expect(verdict.kind === 'warn' && verdict.message).toMatch(
      /^Listening on 0\.0\.0\.0 with no password because auth\.trustNetwork is set: anyone who can reach this port can use Lantern\.$/,
    );
  });
});

describe('the Host and Origin hooks', () => {
  let server: TestApp | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function start(options: Parameters<typeof makeTestApp>[0] = {}): Promise<TestApp> {
    server = await makeTestApp(options);
    return server;
  }

  it('answers an allowed host', async () => {
    const { request } = await start();
    const response = await request({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it.each(['127.0.0.1:7600', '[::1]:7600', 'LOCALHOST:7600', 'localhost'])(
    'accepts Host %s',
    async (host) => {
      const { request } = await start();
      expect(
        (await request({ method: 'GET', url: '/healthz', headers: { host } })).statusCode,
      ).toBe(200);
    },
  );

  // DNS rebinding: a page on attacker.example re-points its name at 127.0.0.1,
  // so the browser connects here while still sending its own Host.
  it.each(['/healthz', '/api/v1/session', '/api/v1/info', '/no/such/page'])(
    'refuses a foreign Host (DNS rebinding) on %s',
    async (url) => {
      const { request } = await start();
      const response = await request({
        method: 'GET',
        url,
        headers: { host: 'attacker.example:7600' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: 'forbidden-host' });
    },
  );

  // inject() always fills in a Host, so this one goes over a real socket:
  // HTTP/1.0 may omit the header, and Node passes such a request through.
  it('refuses a request with no Host at all', async () => {
    const { app } = await start();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port }, () => {
        socket.end('GET /healthz HTTP/1.0\r\n\r\n');
      });
      let received = '';
      socket.on('data', (chunk: Buffer) => (received += chunk.toString()));
      socket.on('end', () => {
        resolve(received);
      });
      socket.on('error', reject);
    });
    expect(reply).toMatch(/^HTTP\/1\.[01] 403/);
    expect(reply).toContain('forbidden-host');
  });

  it('accepts a configured extra host', async () => {
    const { request } = await start({ config: { allowedHosts: ['lantern.lan'] } });
    const response = await request({
      method: 'GET',
      url: '/healthz',
      headers: { host: 'lantern.lan:7600' },
    });
    expect(response.statusCode).toBe(200);
  });

  it.each(['0.0.0.0', '::', '0:0:0:0:0:0:0:0'])(
    "accepts the machine's names on a wildcard bind (%s) and nothing else",
    async (bind) => {
      const { request } = await start({ config: { host: bind }, machine: MACHINE });
      for (const host of ['192.168.1.20:7600', 'mybox:7600', 'mybox.local:7600']) {
        expect(
          (await request({ method: 'GET', url: '/healthz', headers: { host } })).statusCode,
          host,
        ).toBe(200);
      }
      const foreign = await request({
        method: 'GET',
        url: '/healthz',
        headers: { host: 'evil.example' },
      });
      expect(foreign.statusCode).toBe(403);
    },
  );

  it('accepts loopback Hosts however the address is spelled', async () => {
    const { request } = await start();
    for (const host of ['[0:0:0:0:0:0:0:1]:7600', '[::0:1]:7600']) {
      const response = await request({ method: 'GET', url: '/healthz', headers: { host } });
      expect(response.statusCode, host).toBe(200);
    }
  });

  it("accepts the machine's names on an IPv4 wildcard bind and nothing else", async () => {
    const { request } = await start({ config: { host: '0.0.0.0' }, machine: MACHINE });
    for (const host of ['192.168.1.20:7600', 'mybox:7600', 'mybox.local:7600']) {
      expect(
        (await request({ method: 'GET', url: '/healthz', headers: { host } })).statusCode,
        host,
      ).toBe(200);
    }
    const foreign = await request({
      method: 'GET',
      url: '/healthz',
      headers: { host: 'evil.example' },
    });
    expect(foreign.statusCode).toBe(403);
  });

  it('accepts a same-origin Origin', async () => {
    const { request } = await start();
    const response = await request({
      method: 'GET',
      url: '/api/v1/session',
      headers: { origin: TEST_ORIGIN },
    });
    expect(response.statusCode).toBe(200);
  });

  it.each([
    ['a cross-site page', 'https://evil.example'],
    ['another app on this machine (same site, other port)', 'http://localhost:8080'],
    ['a sandboxed frame or file:// page', 'null'],
    ['the Vite dev server when not configured', 'http://localhost:5173'],
  ])('refuses an Origin from %s', async (_label, origin) => {
    const { request } = await start();
    const response = await request({
      method: 'POST',
      url: '/api/v1/session',
      headers: { origin },
      payload: { password: 'x' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'forbidden-origin' });
  });

  it('accepts a configured extra origin', async () => {
    const { request } = await start({ config: { allowedOrigins: ['http://localhost:5173'] } });
    const response = await request({
      method: 'GET',
      url: '/api/v1/session',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses a cross-site request with no Origin (an <img> or no-cors fetch)', async () => {
    const { request } = await start();
    const response = await request({
      method: 'GET',
      url: '/api/v1/info',
      headers: {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-dest': 'image',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'forbidden-origin' });
  });

  it('refuses a cross-site frame', async () => {
    const { request } = await start();
    const response = await request({
      method: 'GET',
      url: '/',
      headers: {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'iframe',
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it('lets a link from another site open the app (a top-level navigation)', async () => {
    const { request } = await start();
    const response = await request({
      method: 'GET',
      url: '/healthz',
      headers: {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    });
    expect(response.statusCode).toBe(200);
  });

  it('allows an absent Origin from curl or the same origin', async () => {
    const { request } = await start();
    expect((await request({ method: 'GET', url: '/api/v1/info' })).statusCode).toBe(200);
    expect(
      (
        await request({
          method: 'GET',
          url: '/api/v1/info',
          headers: { 'sec-fetch-site': 'same-origin' },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('marks every answer nosniff, unframeable and unstorable, refusals included', async () => {
    const { request } = await start();
    for (const host of [TEST_HOST, 'evil.example']) {
      const response = await request({ method: 'GET', url: '/healthz', headers: { host } });
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const foreignOrigin = await request({
      method: 'GET',
      url: '/api/v1/info',
      headers: { origin: 'https://evil.example' },
    });
    expect(foreignOrigin.statusCode).toBe(403);
    expect(foreignOrigin.headers['cache-control']).toBe('no-store');
  });
});

// The router refuses a malformed escape before any hook runs, so these went
// out in Fastify's own shape with no Host check and no security headers.
describe('the checks on a URL the router cannot read', () => {
  let server: TestApp | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it.each(['/%ZZ', '/api/v1/%', '/%c0%ae%c0%ae/'])(
    'refuses a foreign Host for %s, with the headers',
    async (url) => {
      server = await makeTestApp();
      const response = await server.request({
        method: 'POST',
        url,
        headers: {
          host: 'attacker.example:7600',
          origin: 'https://attacker.example',
          'content-type': 'text/plain',
        },
        payload: 'x',
      });
      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(Value.Check(ErrorBody, body)).toBe(true);
      expect(body).toMatchObject({ error: 'forbidden-host' });
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );

  it('refuses a foreign Origin for one', async () => {
    server = await makeTestApp();
    const response = await server.request({
      method: 'GET',
      url: '/api/v1/%',
      headers: { origin: 'https://attacker.example' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'forbidden-origin' });
  });

  it('logs the refusal like any other', async () => {
    const log = captureLog();
    server = await makeTestApp({ log: { level: 'warn', into: log } });
    await server.request({ method: 'GET', url: '/%ZZ', headers: { host: 'evil.example' } });
    expect(log.records.map((line) => line['event'])).toContain('request.forbidden-host');
  });

  it('answers an allowed Host with the 400 envelope', async () => {
    server = await makeTestApp();
    const response = await server.request({
      method: 'GET',
      url: '/api/v1/%',
      headers: { origin: TEST_ORIGIN },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'bad-request',
      message: 'The request URL is not valid.',
    });
    expect(response.headers['x-frame-options']).toBe('DENY');
  });
});

describe('the JSON-only rule', () => {
  let server: TestApp | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  // A cross-site <form> can send these with no preflight; none may reach a handler.
  it.each([
    ['text/plain', '{"password":"x"}'],
    ['text/plain;charset=UTF-8', 'password=x'],
    ['application/x-www-form-urlencoded', 'password=x'],
    [
      'multipart/form-data; boundary=b',
      '--b\r\nContent-Disposition: form-data; name="password"\r\n\r\nx\r\n--b--\r\n',
    ],
  ])('answers 415 to a %s POST', async (type, body) => {
    server = await makeTestApp({ password: 'right' });
    const response = await server.request({
      method: 'POST',
      url: '/api/v1/session',
      headers: { 'content-type': type, origin: TEST_ORIGIN },
      payload: body,
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ error: 'unsupported-media-type' });
    expect(response.cookies).toEqual([]);
  });

  it('answers 415 to a body with no content type', async () => {
    server = await makeTestApp();
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers: { host: TEST_HOST },
      payload: Buffer.from('{"password":"x"}'),
    });
    expect(response.statusCode).toBe(415);
  });

  it('lets a bodiless state-changing request through', async () => {
    server = await makeTestApp();
    const response = await server.request({ method: 'DELETE', url: '/api/v1/session' });
    expect(response.statusCode).toBe(204);
  });
});
