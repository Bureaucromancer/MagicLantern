// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Builds the real app over a real temporary data directory and drives it with
 * `inject()`. Never a mocked filesystem, never a bound port.
 *
 * `inject()` sends `Host: localhost:80` unless told otherwise, which the Host
 * allowlist accepts by hostname but which is not the port the app thinks it
 * listens on; every request here carries {@link TEST_HOST} instead, so Origin
 * checks see a consistent same-origin pair.
 */

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LibraryStatus } from '@bureaucromancer/lantern-schema';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';

import { buildApp } from './app.js';
import { generateSecret, hashPassword } from './auth/password.js';
import { createAuthService } from './auth/service.js';
import type { AppRootResolution } from './config/app-root.js';
import { DEFAULT_CONFIG, type LanternConfig, type ResolvedConfig } from './config/schema.js';
import type { MachineNames } from './http/security.js';
import type { LanternApp } from './http/types.js';
import { loggerOptions, type LogDestination } from './logging.js';
import { readSecrets, writeSecrets } from './store/secrets.js';
import type { LibraryRecord, LibraryRegistry } from './store/types.js';

export const TEST_PORT = 7600;
export const TEST_HOST = `localhost:${String(TEST_PORT)}`;
export const TEST_ORIGIN = `http://localhost:${String(TEST_PORT)}`;
export const TEST_VERSION = '0.0.0-test';

/** A temporary directory, realpath'd: Windows runners hand out 8.3 aliases the server would expand. */
export async function tempRoot(prefix = 'lantern-test-'): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export interface ConfigOverrides extends Partial<Omit<LanternConfig, 'auth' | 'dataDir'>> {
  readonly auth?: Partial<LanternConfig['auth']>;
}

/** A resolved config over the defaults, logging silenced, for a given data directory. */
export function testConfig(dataDir: string, overrides: ConfigOverrides = {}): ResolvedConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  return {
    ...base,
    ...overrides,
    auth: { ...base.auth, ...overrides.auth },
    log: overrides.log ?? { level: 'silent' },
    dataDir,
    provenance: {
      path: join(dataDir, 'lantern.json'),
      fileFound: false,
      unknownKeys: [],
      envOverrodeFile: [],
      envApplied: [],
      dataDirDefaulted: false,
    },
  };
}

/** An in-memory registry, so HTTP tests do not depend on the store's databases. */
export function fakeLibraries(records: readonly LibraryRecord[] = []): LibraryRegistry {
  return {
    list: () => [...records],
    get: (id) => records.find((record) => record.id === id),
    close: () => undefined,
  };
}

export function libraryRecord(
  id: string,
  name: string,
  status: LibraryStatus = 'ok',
): LibraryRecord {
  return { id, name, path: `libraries/${id}`, status, schemaVersion: 1 };
}

/** Writes a password record the way `lantern set-password` does. */
export async function setPassword(dataDir: string, password: string): Promise<void> {
  const existing = await readSecrets(dataDir);
  await writeSecrets(dataDir, {
    sessionKey: existing?.sessionKey ?? generateSecret(),
    password: await hashPassword(password),
  });
}

export interface TestAppOptions {
  readonly config?: ConfigOverrides;
  /** Sets a password record in secrets.json before building. */
  readonly password?: string;
  /** Defaults to API only, so tests do not depend on whether the app has been built. */
  readonly appRoot?: AppRootResolution;
  readonly machine?: MachineNames;
  readonly libraries?: LibraryRegistry;
  /** Captures log lines (JSON) at this level and above. */
  readonly log?: { readonly level: LanternConfig['log']['level']; readonly into: LogDestination };
  /** Epoch milliseconds, for session expiry. */
  readonly now?: () => number;
  /** Use this data directory instead of a fresh one (kept on close). */
  readonly dataDir?: string;
}

type RequestOptions = Omit<InjectOptions, 'cookies'> & {
  /** Send the cookie jar (default true). */
  readonly withCookies?: boolean;
};

export interface TestApp {
  readonly app: LanternApp;
  readonly dataDir: string;
  /** Cookies the "browser" holds, by name. */
  readonly cookies: Map<string, string>;
  // Properties, not methods, so tests can destructure them.
  readonly request: (options: RequestOptions) => Promise<LightMyRequestResponse>;
  readonly signIn: (password: string) => Promise<LightMyRequestResponse>;
  readonly close: () => Promise<void>;
}

const API_ONLY: AppRootResolution = { kind: 'api-only', looked: '/nonexistent/app/dist' };

export async function makeTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const borrowed = options.dataDir !== undefined;
  const dataDir = options.dataDir ?? (await tempRoot());
  if (options.password !== undefined) await setPassword(dataDir, options.password);

  const config = testConfig(dataDir, options.config);
  const stored = await readSecrets(dataDir);
  const secrets = stored ?? { sessionKey: generateSecret() };
  if (stored === null) await writeSecrets(dataDir, secrets);

  const app = await buildApp(
    {
      version: TEST_VERSION,
      processId: 'proc_test',
      auth: createAuthService({
        setting: config.auth.mode,
        secrets,
        cookieSecure: config.auth.cookieSecure,
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
      libraries: options.libraries ?? fakeLibraries(),
    },
    {
      config,
      listenPort: TEST_PORT,
      appRoot: options.appRoot ?? API_ONLY,
      ...(options.log === undefined
        ? {}
        : { logger: loggerOptions(options.log.level, options.log.into) }),
      ...(options.machine === undefined ? {} : { machine: options.machine }),
    },
  );

  const cookies = new Map<string, string>();
  const request = async (requestOptions: RequestOptions): Promise<LightMyRequestResponse> => {
    const { withCookies = true, headers = {}, ...rest } = requestOptions;
    const response = await app.inject({
      ...rest,
      headers: { host: TEST_HOST, ...headers },
      ...(withCookies && cookies.size > 0 ? { cookies: Object.fromEntries(cookies) } : {}),
    });
    for (const cookie of response.cookies) {
      // A cleared cookie arrives expired; a browser drops it.
      const expires = cookie.expires instanceof Date ? cookie.expires.getTime() : undefined;
      if (cookie.maxAge === 0 || (expires !== undefined && expires <= Date.now())) {
        cookies.delete(cookie.name);
      } else {
        cookies.set(cookie.name, cookie.value);
      }
    }
    return response;
  };

  return {
    app,
    dataDir,
    cookies,
    request,
    signIn: (password) =>
      request({
        method: 'POST',
        url: '/api/v1/session',
        headers: { origin: TEST_ORIGIN },
        payload: { password },
      }),
    async close() {
      await app.close();
      if (!borrowed) await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Collects log lines as parsed JSON records. */
export function captureLog(): LogDestination & { readonly records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  return {
    records,
    write(line) {
      records.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
}
