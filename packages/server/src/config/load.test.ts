// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tempRoot } from '../test-app.js';
import { CONFIG_ENVIRONMENT, loadConfig, parseOrigin, type LoadConfigOptions } from './load.js';
import { ConfigError, ConfigSchema, DEFAULT_CONFIG } from './schema.js';

let root: string;
let configPath: string;

beforeEach(async () => {
  root = await tempRoot('lantern-config-');
  configPath = join(root, 'etc', 'lantern.json');
  await mkdir(join(root, 'etc'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Loads with an explicit, empty-by-default environment: never the test runner's. */
function load(options: Partial<LoadConfigOptions> = {}) {
  return loadConfig({
    path: configPath,
    env: {},
    platform: 'linux',
    homedir: join(root, 'home'),
    cwd: root,
    ...options,
  });
}

async function writeConfig(document: unknown): Promise<void> {
  await writeFile(configPath, typeof document === 'string' ? document : JSON.stringify(document));
}

function errorOf(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('loadConfig without a file', () => {
  it('is the defaults, with the platform data directory', () => {
    const config = load();
    const { dataDir, provenance, ...rest } = config;
    expect({ ...rest, dataDir: null }).toEqual(DEFAULT_CONFIG);
    expect(dataDir).toBe(join(root, 'home', '.local', 'share', 'lantern'));
    expect(provenance).toEqual({
      path: configPath,
      fileFound: false,
      unknownKeys: [],
      envOverrodeFile: [],
      envApplied: [],
      dataDirDefaulted: true,
    });
  });

  it('binds loopback with no password', () => {
    const config = load();
    expect(config.host).toBe('127.0.0.1');
    expect(config.auth).toEqual({ mode: null, trustNetwork: false, cookieSecure: false });
  });

  it('finds the file at the platform default when nothing names one', async () => {
    const home = join(root, 'home');
    await mkdir(join(home, '.config', 'lantern'), { recursive: true });
    await writeFile(
      join(home, '.config', 'lantern', 'lantern.json'),
      JSON.stringify({ port: 9000 }),
    );
    const config = loadConfig({ env: {}, platform: 'linux', homedir: home, cwd: root });
    expect(config.port).toBe(9000);
    expect(config.provenance.path).toBe(join(home, '.config', 'lantern', 'lantern.json'));
  });

  it('takes LANTERN_CONFIG when --config is absent, relative to the working directory', async () => {
    await writeFile(join(root, 'custom.json'), JSON.stringify({ port: 9100 }));
    const config = load({ path: undefined, env: { LANTERN_CONFIG: 'custom.json' } });
    expect(config.port).toBe(9100);
    expect(config.provenance.path).toBe(join(root, 'custom.json'));
  });

  it('leaves DEFAULT_CONFIG untouched', () => {
    const config = load();
    config.allowedHosts.push('x');
    expect(DEFAULT_CONFIG.allowedHosts).toEqual([]);
  });
});

describe('loadConfig with a file', () => {
  it('fills what the file leaves out from the defaults', async () => {
    await writeConfig({ port: 8000, auth: { trustNetwork: true } });
    const config = load();
    expect(config.port).toBe(8000);
    expect(config.auth).toEqual({ mode: null, trustNetwork: true, cookieSecure: false });
    expect(config.provenance.fileFound).toBe(true);
  });

  it('resolves a relative dataDir and appRoot against the file’s directory', async () => {
    await writeConfig({ dataDir: 'data', appRoot: '../app' });
    const config = load();
    expect(config.dataDir).toBe(join(root, 'etc', 'data'));
    expect(config.appRoot).toBe(join(root, 'app'));
    expect(config.provenance.dataDirDefaulted).toBe(false);
  });

  it('reports unknown keys rather than refusing them', async () => {
    await writeConfig({ port: 8000, fromTheFuture: 1, auth: { mode: 'none', proxy: true } });
    expect(load().provenance.unknownKeys).toEqual(['fromTheFuture', 'auth.proxy']);
  });

  it('reads a file that starts with a byte-order mark', async () => {
    // What Windows PowerShell 5 `Set-Content -Encoding UTF8` writes.
    await writeFile(
      configPath,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"port": 8000}')]),
    );
    expect(load().port).toBe(8000);
  });

  it('still refuses a byte-order mark anywhere but the start', async () => {
    await writeConfig('{"port": 8000}﻿');
    expect(errorOf(() => load()).message).toContain('it is not JSON');
  });

  it('keeps an IPv6 bind address bare, so listen() can use it', async () => {
    await writeConfig({ host: '[::1]', allowedHosts: ['[::1]'] });
    const config = load();
    expect(config.host).toBe('::1');
    expect(config.allowedHosts).toEqual(['[::1]']);
    await writeConfig({ host: '::1' });
    expect(load().host).toBe('::1');
  });

  it('normalizes allowed origins and hosts', async () => {
    await writeConfig({
      allowedOrigins: ['HTTP://LocalHost:5173/', 'https://lantern.example.com:443'],
      allowedHosts: ['Lantern.LAN'],
    });
    const config = load();
    expect(config.allowedOrigins).toEqual(['http://localhost:5173', 'https://lantern.example.com']);
    expect(config.allowedHosts).toEqual(['lantern.lan']);
  });

  it.each([
    ['not JSON', '{"port": 8000', /is not JSON/],
    ['not an object', '[1, 2]', /the top level must be an object/],
    ['a port out of range', { port: 70000 }, /^port must be <= 65535$/],
    ['a port as a string', { port: '8000' }, /^port must be integer$/],
    [
      'an unknown auth mode',
      { auth: { mode: 'proxy' } },
      /^auth\.mode must be "none", "password" or null$/,
    ],
    ['a dataDir number', { dataDir: 5 }, /^dataDir must be a string or null$/],
    [
      'an unknown log level',
      { log: { level: 'loud' } },
      /^log\.level must be "fatal", .* or "silent"$/,
    ],
    ['auth as a string', { auth: 'none' }, /^auth must be object$/],
    [
      'an allowed host with a port',
      { allowedHosts: ['lantern.lan:7600'] },
      /^allowedHosts\[0\] must be a host name without a port$/,
    ],
    [
      'an allowed host with a scheme',
      { allowedHosts: ['http://x'] },
      /^allowedHosts\[0\] must be a host name, without a scheme or path$/,
    ],
    [
      'an allowed origin with a path',
      { allowedOrigins: ['http://localhost:5173/app'] },
      /^allowedOrigins\[0\] must be an origin/,
    ],
    [
      'an allowed origin without a scheme',
      { allowedOrigins: ['localhost:5173'] },
      /^allowedOrigins\[0\] must be an origin/,
    ],
    [
      'a bind address with a port',
      { host: '127.0.0.1:7600' },
      /^host must be a host name without a port$/,
    ],
    [
      'a bracketed IPv6 bind address with a port',
      { host: '[::1]:7600' },
      /^host must be a host name without a port$/,
    ],
    [
      'a bracketed host name',
      { host: '[localhost]' },
      /^host must be a host name; only an IPv6 address goes in brackets$/,
    ],
    [
      'a bracketed IPv4 address',
      { host: '[127.0.0.1]' },
      /^host must be a host name; only an IPv6 address goes in brackets$/,
    ],
    [
      'a bracketed allowed host name',
      { allowedHosts: ['[lantern.lan]'] },
      /^allowedHosts\[0\] must be a host name; only an IPv6 address goes in brackets$/,
    ],
  ])('refuses %s, naming the file and the key', async (_label, document, issue) => {
    await writeConfig(document);
    const error = errorOf(() => load());
    expect(error.message.startsWith(`${configPath} is not valid: `)).toBe(true);
    expect(
      error.issues.some((text) => issue.test(text)),
      error.issues.join(' | '),
    ).toBe(true);
  });
});

describe('loadConfig with the environment', () => {
  it('overrides the file and says which variables did', async () => {
    await writeConfig({ host: '127.0.0.1', port: 8000 });
    const config = load({
      env: { LANTERN_PORT: '9000', LANTERN_LOG_LEVEL: 'debug', LANTERN_HOST: '127.0.0.2' },
    });
    expect(config.port).toBe(9000);
    expect(config.host).toBe('127.0.0.2');
    expect(config.log.level).toBe('debug');
    expect(config.provenance.envOverrodeFile).toEqual(['LANTERN_HOST', 'LANTERN_PORT']);
    expect(config.provenance.envApplied).toEqual(['LANTERN_LOG_LEVEL']);
  });

  it('reads every documented variable', () => {
    const config = load({
      env: {
        LANTERN_HOST: '0.0.0.0',
        LANTERN_PORT: '0',
        LANTERN_DATA_DIR: 'data',
        LANTERN_APP_ROOT: '/srv/app',
        LANTERN_AUTH_MODE: 'password',
        LANTERN_TRUST_NETWORK: '1',
        LANTERN_COOKIE_SECURE: 'TRUE',
        LANTERN_ALLOWED_HOSTS: 'a.lan, b.lan,,',
        LANTERN_ALLOWED_ORIGINS: 'http://localhost:5173',
        LANTERN_LOG_LEVEL: 'warn',
      },
    });
    expect(config).toMatchObject({
      host: '0.0.0.0',
      port: 0,
      dataDir: join(root, 'data'),
      appRoot: '/srv/app',
      auth: { mode: 'password', trustNetwork: true, cookieSecure: true },
      allowedHosts: ['a.lan', 'b.lan'],
      allowedOrigins: ['http://localhost:5173'],
      log: { level: 'warn' },
    });
  });

  it('treats an empty variable as unset', async () => {
    await writeConfig({ port: 8000 });
    const config = load({ env: { LANTERN_PORT: '', LANTERN_HOST: '' } });
    expect(config.port).toBe(8000);
    expect(config.provenance.envApplied).toEqual([]);
  });

  it('reads false for 0 and false', () => {
    expect(load({ env: { LANTERN_TRUST_NETWORK: '0' } }).auth.trustNetwork).toBe(false);
    expect(load({ env: { LANTERN_COOKIE_SECURE: 'False' } }).auth.cookieSecure).toBe(false);
  });

  it.each([
    [{ LANTERN_PORT: 'x' }, 'LANTERN_PORT must be integer'],
    [{ LANTERN_PORT: '8000.5' }, 'LANTERN_PORT must be integer'],
    [{ LANTERN_PORT: ' 8000' }, 'LANTERN_PORT must be integer'],
    [{ LANTERN_PORT: '70000' }, 'LANTERN_PORT must be <= 65535'],
    [{ LANTERN_TRUST_NETWORK: 'yes' }, 'LANTERN_TRUST_NETWORK must be boolean'],
    [
      { LANTERN_AUTH_MODE: 'open' },
      'LANTERN_AUTH_MODE must be "none" or "password" (unset it to leave auth.mode to the config file or the default)',
    ],
    [{ LANTERN_HOST: '[localhost]' }, 'LANTERN_HOST must be a host name; only an IPv6 address'],
    [{ LANTERN_LOG_LEVEL: 'verbose' }, 'LANTERN_LOG_LEVEL must be "fatal",'],
    [{ LANTERN_ALLOWED_ORIGINS: 'http://ok:1,nope' }, 'LANTERN_ALLOWED_ORIGINS must be an origin'],
    [
      { LANTERN_ALLOWED_HOSTS: 'host:80' },
      'LANTERN_ALLOWED_HOSTS must be a host name without a port',
    ],
  ])('refuses %j, naming the variable', (env, issue) => {
    const error = errorOf(() => load({ env }));
    expect(error.message.startsWith('the environment is not valid: ')).toBe(true);
    expect(error.message).toContain(issue);
  });

  it('blames the environment, not the file, when only the variable is bad', async () => {
    await writeConfig({ port: 8000 });
    expect(errorOf(() => load({ env: { LANTERN_PORT: 'x' } })).message).not.toContain(configPath);
  });

  // No variable can be null, so the message must not offer it: an operator
  // who typed LANTERN_AUTH_MODE=null was doing what it said.
  it('does not offer null for a variable, which cannot be null', async () => {
    await writeConfig({ auth: { mode: 'password' } });
    const message = errorOf(() => load({ env: { LANTERN_AUTH_MODE: 'null' } })).message;
    expect(message).toContain('LANTERN_AUTH_MODE must be "none" or "password"');
    expect(message).not.toContain('or null');
  });

  it('keeps null in the file’s message, where it can be written', async () => {
    await writeConfig({ auth: { mode: 'open' } });
    expect(errorOf(() => load()).issues).toEqual(['auth.mode must be "none", "password" or null']);
  });

  it('takes an IPv6 bind address from the environment with or without brackets', () => {
    expect(load({ env: { LANTERN_HOST: '[::1]' } }).host).toBe('::1');
    expect(load({ env: { LANTERN_HOST: '::1' } }).host).toBe('::1');
  });
});

describe('the data directory', () => {
  it('takes --data over LANTERN_DATA_DIR over the file', async () => {
    await writeConfig({ dataDir: '/from/file' });
    expect(load().dataDir).toBe('/from/file');
    expect(load({ env: { LANTERN_DATA_DIR: '/from/env' } }).dataDir).toBe('/from/env');
    expect(load({ env: { LANTERN_DATA_DIR: '/from/env' }, dataDir: 'flag' }).dataDir).toBe(
      join(root, 'flag'),
    );
  });

  // The startup log reads these lists; with --data, LANTERN_DATA_DIR decided nothing.
  it('does not report LANTERN_DATA_DIR as applied when --data outranks it', async () => {
    const env = { LANTERN_DATA_DIR: '/from/env', LANTERN_PORT: '9000' };
    await writeConfig({ dataDir: '/from/file', port: 8000 });
    expect(load({ env }).provenance.envOverrodeFile).toEqual(['LANTERN_PORT', 'LANTERN_DATA_DIR']);
    const flagged = load({ env, dataDir: 'flag' }).provenance;
    expect(flagged.envOverrodeFile).toEqual(['LANTERN_PORT']);
    expect(flagged.envApplied).toEqual([]);

    await writeConfig({});
    expect(load({ env, dataDir: 'flag' }).provenance).toMatchObject({
      envOverrodeFile: [],
      envApplied: ['LANTERN_PORT'],
      dataDirDefaulted: false,
    });
  });

  it('defaults per platform', () => {
    expect(load({ platform: 'darwin' }).dataDir).toBe(
      join(root, 'home', 'Library', 'Application Support', 'Lantern'),
    );
    expect(load({ env: { XDG_DATA_HOME: '/xdg' } }).dataDir).toBe('/xdg/lantern');
  });
});

describe('CONFIG_ENVIRONMENT', () => {
  it('maps every variable to a key the schema has, with the schema’s type', () => {
    const kindOf: Record<string, string> = {
      string: 'string',
      integer: 'integer',
      boolean: 'boolean',
      array: 'list',
    };
    for (const [variable, { key, kind }] of Object.entries(CONFIG_ENVIRONMENT)) {
      let node: unknown = ConfigSchema;
      for (const part of key.split('.')) {
        node = (node as { properties: Record<string, unknown> }).properties[part];
      }
      expect(node, variable).toBeDefined();
      const schema = node as { type?: string; anyOf?: { type?: string }[] };
      const types = schema.anyOf?.map((member) => member.type) ?? [schema.type];
      // Nullable strings and literal unions are strings in the environment.
      const expected = types.includes('array')
        ? 'list'
        : (kindOf[types.find((type) => type !== 'null' && type !== undefined) ?? 'string'] ??
          'string');
      expect(kind, variable).toBe(expected);
    }
  });
});

describe('parseOrigin', () => {
  it.each([
    ['http://localhost:5173', 'http://localhost:5173'],
    ['http://localhost:5173/', 'http://localhost:5173'],
    ['https://example.com:443', 'https://example.com'],
    ['http://[::1]:7600', 'http://[::1]:7600'],
  ])('reads %s as %s', (value, origin) => {
    expect(parseOrigin(value)).toBe(origin);
  });

  it.each([
    'localhost',
    'ftp://x',
    'http://x/path',
    'http://x?',
    'http://u:p@x',
    'http://x#y',
    'null',
  ])('refuses %s', (value) => {
    expect(parseOrigin(value)).toBeNull();
  });
});
