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
import type { DatabaseSync } from 'node:sqlite';

import type { LibraryStatus } from '@bureaucromancer/lantern-schema';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';

import { buildApp } from './app.js';
import { generateSecret, hashPassword } from './auth/password.js';
import { createAuthService } from './auth/service.js';
import type { AppRootResolution } from './config/app-root.js';
import { DEFAULT_CONFIG, type LanternConfig, type ResolvedConfig } from './config/schema.js';
import type { MachineNames } from './http/security.js';
import type { LanternApp } from './http/types.js';
import type { MockAdapter, MockSettings } from './adapters/mock/index.js';
import {
  BackendRegistry,
  createBackendKinds,
  type BackendKinds,
  type ConfigBackend,
  type FixedModel,
} from './engine/backends/index.js';
import { type CatalogModel, devBackend, devFixedModel } from './engine/catalog/index.js';
import { EventBus, JobEngine } from './engine/jobs/index.js';
import { builtinProfiles } from './engine/profiles/index.js';
import { createResolver, type SeedSource } from './engine/resolver/index.js';
import { loggerOptions, type LogDestination } from './logging.js';
import type { AppServices } from './services.js';
import { createValidator } from './validation/ajv.js';
import { newId } from './ids.js';
import { openInstallStore } from './store/install.js';
import { openLibraryRegistry } from './store/libraries.js';
import { readSecrets, writeSecrets } from './store/secrets.js';
import { memoryInstallDb, testBoot } from './store/test-store.js';
import type { InstallStore, LibraryRecord, LibraryRegistry, StoreLog } from './store/types.js';

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

/**
 * An in-memory registry, so HTTP tests of the routes that only list libraries
 * do not depend on the store's databases. Its libraries have no handle (as
 * if none had opened); tests of the library routes use {@link TestAppOptions.storage}.
 */
export function fakeLibraries(records: readonly LibraryRecord[] = []): LibraryRegistry {
  const all = [...records];
  return {
    list: () => [...all],
    get: (id) => all.find((record) => record.id === id),
    library: () => undefined,
    jobs: () => undefined,
    create: (name) => {
      const record = libraryRecord(newId('lib'), name);
      all.push(record);
      return Promise.resolve(record);
    },
    rename: (id, name) => {
      const index = all.findIndex((record) => record.id === id);
      const existing = all[index];
      if (existing === undefined) return Promise.resolve(undefined);
      const renamed = { ...existing, name };
      all[index] = renamed;
      return Promise.resolve(renamed);
    },
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

/**
 * The model services an app needs, around a backend registry: `models` are
 * held in memory with no backend (the resolver's view of them), `fixed`
 * models may bring a backend (the mock), and the registry's own rows live in
 * `db`, an install database in memory unless a test gives one.
 */
export function testModelServices(
  models: readonly CatalogModel[] = [],
  drawSeed?: SeedSource,
  engineDeps: {
    libraries?: LibraryRegistry;
    fixed?: readonly FixedModel[];
    db?: DatabaseSync;
    kinds?: BackendKinds;
  } = {},
): Pick<AppServices, 'models' | 'backends' | 'resolver' | 'engine' | 'events'> {
  const profiles = builtinProfiles();
  const events = new EventBus('boot_test');
  const registry = new BackendRegistry({
    db: engineDeps.db ?? memoryInstallDb(),
    profiles,
    events,
    log: silentStoreLog(),
    kinds: engineDeps.kinds ?? createBackendKinds(),
    fixed: [...models.map((model) => ({ model, name: model.id })), ...(engineDeps.fixed ?? [])],
    startupWaitMs: 2000,
    createWaitMs: 2000,
  });
  const resolver = createResolver({
    ajv: createValidator(),
    profiles,
    ...(drawSeed === undefined ? {} : { drawSeed }),
  });
  const engine = new JobEngine({
    libraries: engineDeps.libraries ?? fakeLibraries(),
    models: registry,
    resolver,
    bindings: registry,
    events,
    log: silentStoreLog(),
    pollMs: 2,
  });
  return { models: registry, backends: registry, resolver, engine, events };
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
  /** The models the catalog holds; none by default. */
  readonly models?: readonly CatalogModel[];
  /** Draws seeds; `crypto.randomInt` by default. */
  readonly drawSeed?: SeedSource;
  /** Captures log lines (JSON) at this level and above. */
  readonly log?: { readonly level: LanternConfig['log']['level']; readonly into: LogDestination };
  /** Epoch milliseconds, for session expiry. */
  readonly now?: () => number;
  /** Use this data directory instead of a fresh one (kept on close). */
  readonly dataDir?: string;
  /**
   * Open the real install database and library registry in the data
   * directory (a default library is created), instead of `libraries`. Closed
   * with the app.
   */
  readonly storage?: boolean;
  /**
   * Serve the development model on the mock adapter with these settings,
   * and start the engine (stopped with the app).
   */
  readonly mock?: MockSettings;
  /**
   * Starts the backend registry with these config backends and kinds (a
   * `fetch` to fake backends with). Without it the registry is not started.
   */
  readonly backends?: { readonly config?: readonly ConfigBackend[]; readonly kinds?: BackendKinds };
}

type RequestOptions = Omit<InjectOptions, 'cookies'> & {
  /** Send the cookie jar (default true). */
  readonly withCookies?: boolean;
};

export interface TestApp {
  readonly app: LanternApp;
  readonly dataDir: string;
  readonly services: Pick<AppServices, 'engine' | 'events' | 'models' | 'backends'>;
  /** The mock backend, with `mock`. */
  readonly adapter: MockAdapter | null;
  /** The registry the app serves. */
  readonly libraries: LibraryRegistry;
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

  let install: InstallStore | null = null;
  let libraries = options.libraries ?? fakeLibraries();
  if (options.storage === true) {
    install = await openInstallStore(dataDir, { boot: testBoot(), log: silentStoreLog() });
    libraries = await openLibraryRegistry(install, dataDir, { log: silentStoreLog() });
  }

  const fixed: FixedModel[] = [];
  let adapter: MockAdapter | null = null;
  if (options.mock !== undefined) {
    const backend = await devBackend({ stepMs: 1, ...options.mock });
    adapter = backend.adapter;
    fixed.push(devFixedModel(backend.binding, options.mock.profile));
  }
  const modelServices = testModelServices(options.models ?? [], options.drawSeed, {
    libraries,
    fixed,
    ...(install === null ? {} : { db: install.db }),
    ...(options.backends?.kinds === undefined ? {} : { kinds: options.backends.kinds }),
  });
  if (options.backends !== undefined) {
    await modelServices.backends.start({ config: options.backends.config ?? [] });
  }
  if (options.mock !== undefined || options.backends !== undefined) {
    await modelServices.engine.start();
  }

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
      libraries,
      ...modelServices,
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
    services: modelServices,
    adapter,
    libraries,
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
      await modelServices.engine.stop();
      await modelServices.backends.stop();
      if (install !== null) {
        libraries.close();
        install.close();
      }
      if (!borrowed) await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** A store log that says nothing. */
export function silentStoreLog(): StoreLog {
  const nothing = (): void => undefined;
  return { info: nothing, warn: nothing, error: nothing };
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
