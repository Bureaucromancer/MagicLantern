// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `lantern serve` (the default command).
 *
 * Startup: resolve config (and the app root, so a bad one fails before any
 * file is touched) → loopback guard, read-only (a non-loopback bind with auth
 * mode none refuses unless `auth.trustNetwork`, which warns on every start) →
 * writable data dir → instance lock (kept referenced for the process's life)
 * → auth under the lock: secrets, `LANTERN_PASSWORD`, the effective mode and
 * the guard again, authoritatively → install store and lease, heartbeat
 * started at once (the lease is only a cross-host guard while it is fresh,
 * and opening libraries can snapshot them) → libraries → build app → listen →
 * one line saying where to open the UI (the daemon's port when the app is
 * served, and Vite's too when a development run serves an earlier build;
 * else that it is not built and `pnpm dev` serves it on 5173).
 *
 * Shutdown, single-flight on SIGINT/SIGTERM: close the app (10 s backstop,
 * then closeAllConnections), stop the heartbeat, close libraries, close the
 * install store, release the lock, exit 0. The handlers stay installed until
 * then, and the first signal decides the outcome:
 *
 * - A repeat within {@link SIGNAL_REPEAT_GRACE_MS} is the same stop delivered
 *   twice and is ignored. A terminal's Ctrl-C reaches the whole process
 *   group, and a runner in it (`pnpm start`, `tsx watch` under `pnpm dev`)
 *   relays it to the daemon again; dying on that copy would leave the stores
 *   open and the lease held on every routine Ctrl-C.
 * - A later SIGINT is a person's second Ctrl-C: a force quit, by re-raising
 *   it with the handlers removed.
 * - A later SIGTERM is ignored: a supervisor that wants it over sends
 *   SIGKILL, and the backstop already bounds the wait.
 */

import { hostname } from 'node:os';

import { buildApp, CLOSE_BACKSTOP_MS, closeApp } from '../../app.js';
import { createAuthService } from '../../auth/service.js';
import {
  DETECTED_APP_ROOT,
  resolveAppRoot,
  type AppRootResolution,
} from '../../config/app-root.js';
import type { ResolvedConfig } from '../../config/schema.js';
import { DEV_MODEL_ID, isDevMode, startupModelCatalog } from '../../engine/catalog/index.js';
import { builtinProfiles } from '../../engine/profiles/index.js';
import { createResolver } from '../../engine/resolver/index.js';
import { unhandledShape } from '../../http/errors.js';
import { isWildcardHost, normalizeHostname } from '../../http/security.js';
import type { LanternApp } from '../../http/types.js';
import { newId } from '../../ids.js';
import { consoleStoreLog, deferredStoreLog, loggerOptions, storeLogFrom } from '../../logging.js';
import { readMachineBootId } from '../../store/boot.js';
import { openInstallStore } from '../../store/install.js';
import { LEASE_HEARTBEAT_MS } from '../../store/lease.js';
import { openLibraryRegistry } from '../../store/libraries.js';
import { acquireInstanceLock } from '../../store/lock.js';
import type {
  BootIdentity,
  InstallStore,
  InstanceLock,
  LibraryRegistry,
  StoreLog,
} from '../../store/types.js';
import { UsageError, type Command, type CommandContext } from '../args.js';
import { checkAuthBeforeStart, prepareAuth, type PreparedAuth } from '../auth-setup.js';
import { holdDataDir, loadCommandConfig } from '../startup.js';
import { createValidator } from '../../validation/ajv.js';
import { readServerVersion } from '../version.js';

/** The store calls serve makes, injectable so the command is testable on its own. */
export interface ServeStore {
  acquireInstanceLock(dataDir: string): InstanceLock;
  readMachineBootId(platform: NodeJS.Platform): Promise<string>;
  openInstallStore(
    dataDir: string,
    deps: { boot: BootIdentity; log: StoreLog },
  ): Promise<InstallStore>;
  openLibraryRegistry(
    install: InstallStore,
    dataDir: string,
    deps: { log: StoreLog },
  ): Promise<LibraryRegistry>;
}

export const STORE: ServeStore = {
  acquireInstanceLock,
  readMachineBootId,
  openInstallStore,
  openLibraryRegistry,
};

/** Where `pnpm dev` serves the app (Vite, strictPort). */
export const VITE_DEV_ADDRESS = 'http://localhost:5173';

/** How long after the first signal a repeat is still that signal delivered twice. */
export const SIGNAL_REPEAT_GRACE_MS = 1_000;

export interface ServeOptions {
  readonly store?: ServeStore;
  readonly closeBackstopMs?: number;
  readonly heartbeatMs?: number;
  /** Where `appRoot: null` looks for a build; the app package's dist by default. */
  readonly detectedAppRoot?: string;
  /** {@link SIGNAL_REPEAT_GRACE_MS} by default. */
  readonly signalRepeatGraceMs?: number;
}

/** A thing to close on shutdown (or on a failed start), in reverse order of opening. */
interface Closer {
  readonly name: string;
  readonly close: () => void | Promise<void>;
}

/** Where `appRoot` was set, for the error if it holds no build. */
function appRootSource(config: ResolvedConfig): string {
  const { envApplied, envOverrodeFile, path } = config.provenance;
  return [...envApplied, ...envOverrodeFile].includes('LANTERN_APP_ROOT')
    ? 'LANTERN_APP_ROOT'
    : path;
}

function urlHost(host: string): string {
  const bare = normalizeHostname(host);
  return bare.includes(':') ? `[${bare}]` : bare;
}

function boundPort(app: LanternApp, fallback: number): number {
  const address = app.server.address();
  return typeof address === 'object' && address !== null ? address.port : fallback;
}

/** A listen failure the operator can fix, as one sentence; anything else is rethrown. */
function describeListenError(error: unknown, host: string, port: number): Error {
  const code = (error as NodeJS.ErrnoException).code;
  const where = `${host}:${String(port)}`;
  switch (code) {
    case 'EADDRINUSE':
      return new UsageError(
        `Port ${String(port)} on ${host} is already in use. Stop whatever holds it, or choose another port (port in lantern.json, or LANTERN_PORT).`,
      );
    case 'EACCES':
      return new UsageError(
        `Not allowed to listen on ${where} (ports below 1024 need privileges).`,
      );
    case 'EADDRNOTAVAIL':
      return new UsageError(
        `Cannot listen on ${host}: it is not an address of this machine. Check host in lantern.json or LANTERN_HOST.`,
      );
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new UsageError(
        `Cannot listen on ${host}: the name does not resolve to an address. Check host in lantern.json or LANTERN_HOST.`,
      );
    default:
      return error instanceof Error ? error : new Error(String(error));
  }
}

export function logStartup(
  log: LanternApp['log'],
  config: ResolvedConfig,
  auth: PreparedAuth,
  appRoot: AppRootResolution,
): void {
  const { provenance } = config;
  if (provenance.fileFound) {
    log.info(
      { event: 'config.loaded', configPath: provenance.path },
      `Read the config from ${provenance.path}`,
    );
  } else {
    log.info(
      { event: 'config.missing', configPath: provenance.path },
      `No config file at ${provenance.path}; using the defaults`,
    );
  }
  if (provenance.unknownKeys.length > 0) {
    log.warn(
      { event: 'config.unknown-keys', unknownKeys: provenance.unknownKeys },
      `The config has keys this version does not know, which do nothing: ${provenance.unknownKeys.join(', ')}`,
    );
  }
  if (provenance.envApplied.length > 0) {
    log.info(
      { event: 'config.environment', variables: provenance.envApplied },
      `Config from the environment: ${provenance.envApplied.join(', ')}`,
    );
  }
  if (provenance.envOverrodeFile.length > 0) {
    log.info(
      { event: 'config.environment-overrode-file', variables: provenance.envOverrodeFile },
      `The environment overrode the config file for: ${provenance.envOverrodeFile.join(', ')}`,
    );
  }
  log.info(
    { event: 'data-dir', dataDir: config.dataDir, defaulted: provenance.dataDirDefaulted },
    `Data directory: ${config.dataDir}`,
  );
  log.info({ event: 'auth.mode', mode: auth.mode }, `Auth mode: ${auth.mode}`);
  if (auth.envPassword === 'stored') {
    log.info(
      { event: 'auth.env-password' },
      'Stored the password from LANTERN_PASSWORD; sessions from an earlier password are signed out',
    );
  }
  if (auth.exposureWarning !== null) {
    log.warn({ event: 'auth.trust-network', host: config.host }, auth.exposureWarning);
  }
  if (appRoot.kind === 'served') {
    log.info({ event: 'app.root', appRoot: appRoot.root }, `Serving the app from ${appRoot.root}`);
  } else {
    log.info(
      { event: 'app.not-built', looked: appRoot.looked },
      `No built app at ${appRoot.looked}; serving the API only`,
    );
  }
}

/**
 * The line a person reads first: where to point a browser.
 *
 * A development run (`pnpm dev` allowlists Vite's origin) that auto-detected
 * a build serves whatever `pnpm build` last produced, without the edits since
 * and without hot reload, so the line names Vite's address as well.
 */
function logOpenLine(
  log: LanternApp['log'],
  config: Pick<ResolvedConfig, 'host' | 'allowedOrigins'>,
  port: number,
  appRoot: AppRootResolution,
): void {
  if (appRoot.kind === 'served') {
    // A wildcard bind is reachable as localhost from this machine.
    const host = isWildcardHost(config.host) ? 'localhost' : urlHost(config.host);
    const address = `http://${host}:${String(port)}`;
    if (appRoot.detected && config.allowedOrigins.includes(VITE_DEV_ADDRESS)) {
      log.info(
        { event: 'open', open: address, dev: VITE_DEV_ADDRESS },
        `Open ${VITE_DEV_ADDRESS} (\`pnpm dev\`) for the app as you edit it; ${address} serves the build from the last \`pnpm build\``,
      );
      return;
    }
    log.info({ event: 'open', open: address }, `Open ${address} in a browser to use Lantern`);
    return;
  }
  log.info(
    { event: 'open', open: VITE_DEV_ADDRESS },
    `The app is not built, so this daemon serves only the API. For the UI in development, run \`pnpm dev\` and open ${VITE_DEV_ADDRESS}; to serve it from here, run \`pnpm build\` first`,
  );
}

export function createServeCommand(options: ServeOptions = {}): Command {
  const store = options.store ?? STORE;
  const backstopMs = options.closeBackstopMs ?? CLOSE_BACKSTOP_MS;
  const heartbeatMs = options.heartbeatMs ?? LEASE_HEARTBEAT_MS;
  const detectedAppRoot = options.detectedAppRoot ?? DETECTED_APP_ROOT;
  const signalRepeatGraceMs = options.signalRepeatGraceMs ?? SIGNAL_REPEAT_GRACE_MS;

  return async (context: CommandContext): Promise<number> => {
    const config = loadCommandConfig(context);
    const appRoot = resolveAppRoot(config.appRoot, appRootSource(config), detectedAppRoot);
    const envPassword = nonEmpty(context.env['LANTERN_PASSWORD']);
    await checkAuthBeforeStart({ config, envPassword });

    const closers: Closer[] = [];
    const closeAll = async (log: (closer: Closer, error: unknown) => void): Promise<boolean> => {
      let clean = true;
      for (const closer of closers.splice(0).reverse()) {
        try {
          await closer.close();
        } catch (error) {
          clean = false;
          log(closer, error);
        }
      }
      return clean;
    };

    const storeLog = deferredStoreLog();
    let app: LanternApp | null = null;
    try {
      const lock = await holdDataDir(config, context, (dir) => store.acquireInstanceLock(dir));
      closers.push({
        name: 'instance lock',
        close: () => {
          lock.release();
        },
      });

      const auth = await prepareAuth({ config, envPassword });

      const processId = newId('proc');
      const boot: BootIdentity = {
        machineBootId: await store.readMachineBootId(context.platform),
        hostname: hostname(),
        pid: context.pid,
        processId,
      };
      const install = await store.openInstallStore(config.dataDir, { boot, log: storeLog });
      closers.push({
        name: 'install store',
        close: () => {
          install.close();
        },
      });

      // From the moment the lease is taken: opening libraries can snapshot and
      // migrate them, and a lease left to go stale meanwhile lets a daemon on
      // another host (where the OS lock does not reach) take it over.
      const heartbeat = setInterval(() => {
        try {
          install.heartbeat();
        } catch (error) {
          storeLog.error('Could not refresh the data-directory lease', {
            event: 'lease.heartbeat-failed',
            ...unhandledShape(error),
          });
        }
      }, heartbeatMs);
      heartbeat.unref();
      const heartbeatCloser: Closer = {
        name: 'heartbeat',
        close: () => {
          clearInterval(heartbeat);
        },
      };
      closers.push(heartbeatCloser);

      const libraries = await store.openLibraryRegistry(install, config.dataDir, { log: storeLog });
      // Before the heartbeat in the list, so it is closed after the heartbeat
      // stops: the closers run in reverse (app, heartbeat, libraries, install, lock).
      closers.splice(closers.indexOf(heartbeatCloser), 0, {
        name: 'libraries',
        close: () => {
          libraries.close();
        },
      });

      // Profiles load (and are validated) here, so a bad built-in fails the start.
      const profiles = builtinProfiles();
      const builtApp = await buildApp(
        {
          version: readServerVersion(),
          processId,
          auth: createAuthService({
            setting: config.auth.mode,
            secrets: auth.secrets,
            cookieSecure: config.auth.cookieSecure,
          }),
          libraries,
          // Phase 5 replaces the in-memory catalog with the install database.
          models: startupModelCatalog(context.env, profiles),
          resolver: createResolver({ ajv: createValidator(), profiles }),
        },
        {
          config,
          listenPort: config.port,
          logger: loggerOptions(config.log.level, context.stdout),
          appRoot,
        },
      );
      app = builtApp;
      storeLog.attach(storeLogFrom(builtApp.log));
      closers.push({ name: 'app', close: () => closeApp(builtApp, backstopMs) });
      logStartup(builtApp.log, config, auth, appRoot);
      if (isDevMode(context.env)) {
        builtApp.log.warn(
          { event: 'dev-mode', models: [DEV_MODEL_ID] },
          'LANTERN_DEV=1: serving the development model catalog (one mock route)',
        );
      }

      try {
        await builtApp.listen({ host: config.host, port: config.port });
      } catch (error) {
        throw describeListenError(error, config.host, config.port);
      }

      const port = boundPort(builtApp, config.port);
      const address = `http://${urlHost(config.host)}:${String(port)}`;
      builtApp.log.info(
        { event: 'listening', address, version: readServerVersion(), processId, pid: context.pid },
        `Lantern ${readServerVersion()} is listening on ${address}`,
      );
      logOpenLine(builtApp.log, config, port, appRoot);
    } catch (error) {
      const failed = app;
      await closeAll((closer, closeError) => {
        failed?.log.error(
          { event: 'startup.cleanup-failed', closing: closer.name, ...unhandledShape(closeError) },
          `Could not close the ${closer.name} after a failed start`,
        );
      });
      // Store lines from before the logger existed would otherwise vanish with the failure.
      storeLog.drain(consoleStoreLog(context.stderr));
      throw error;
    }

    const running = app;
    return await new Promise<number>((resolve) => {
      // When the first signal arrived; null until then.
      let stoppingSince: number | null = null;
      const signals = context.signals;
      const detach = (): void => {
        signals?.off('SIGINT', onInterrupt);
        signals?.off('SIGTERM', onTerminate);
      };
      const stop = (signal: 'SIGINT' | 'SIGTERM'): void => {
        const now = Date.now();
        if (stoppingSince !== null) {
          const late = now - stoppingSince >= signalRepeatGraceMs;
          if (late && signal === 'SIGINT') {
            running.log.warn(
              { event: 'shutdown.forced', signal },
              `Received ${signal} again; quitting without finishing the shutdown`,
            );
            detach();
            signals?.kill(context.pid, signal);
            return;
          }
          const repeated = { event: 'shutdown.repeated', signal };
          const message = `Received ${signal} again; already shutting down`;
          if (late) running.log.info(repeated, message);
          else running.log.debug(repeated, message);
          return;
        }
        stoppingSince = now;
        running.log.info({ event: 'shutdown', signal }, `Received ${signal}; shutting down`);
        void closeAll((closer, error) => {
          running.log.error(
            { event: 'shutdown.close-failed', closing: closer.name, ...unhandledShape(error) },
            `Could not close the ${closer.name}`,
          );
        }).then((clean) => {
          detach();
          running.log.info({ event: 'stopped' }, 'Stopped');
          resolve(clean ? 0 : 1);
        });
      };
      const onInterrupt = (): void => {
        stop('SIGINT');
      };
      const onTerminate = (): void => {
        stop('SIGTERM');
      };
      // `on`, not `once`: with no listener left, a repeat would get the default
      // handler and kill the process mid-shutdown.
      signals?.on('SIGINT', onInterrupt);
      signals?.on('SIGTERM', onTerminate);
    });
  };
}

/** An empty variable is unset (compose forwards an unset host variable as ''). */
function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

export const runServe: Command = createServeCommand();
