// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The backend registry (Phase 5): backends, models and routes over the
 * install database, as the model catalog the resolver reads and the bindings
 * the engine dispatches through. It replaces Phase 4's startup lists.
 *
 * - **A route is one backend serving one model.** A standalone sd-server
 *   that restarts with another model retires its old route (down, kept for
 *   when the model returns) and gains one for the new model; a model
 *   Lemonade unloads retires its route and takes it back when it loads
 *   again, on whatever port. A queued job keeps its route, so it waits for
 *   its model rather than running on another (A12).
 * - **Models are matched by fingerprint (A26).** A model seen again is the
 *   same model; one never seen is registered with the family the person
 *   confirmed on the proposal card, else a sure enough guess, else the
 *   generic profile.
 * - **Config backends** are declarative: reconciled at every start, and
 *   tombstoned when they leave `lantern.json`. A tombstoned backend serves
 *   nothing, so its routes' queued jobs wait as `route_missing`.
 * - **Health** is polled per backend: an adapter's own (`GET /` for
 *   sd-server), a manager's discovery (Lemonade's health). Changes are
 *   published as `backend.health` (A31) and written through to the database,
 *   so a restart starts from what was last seen. Descriptors are re-read when
 *   a route appears, moves or returns, on a refresh, and when they grow old
 *   (LoRA lists change); never by sending work (L3).
 * - **Development backends** (`LANTERN_DEV=1`) live in memory only, with
 *   fixed ids, so a development data directory keeps no trace of them.
 *
 * Every write goes through this object, so its in-memory mirror is the truth
 * while the daemon runs.
 */

import type { DatabaseSync } from 'node:sqlite';

import type {
  BackendHealthEvent,
  BackendHealthReport,
  CreateBackendBody,
  FamilyGuess,
  GenerationMode,
  ModelFingerprint,
  ModelPatchBody,
  RouteDescriptor,
  RouteHealth,
  ValidationIssue,
} from '@bureaucromancer/lantern-schema';
import { checkRouteDescriptor } from '@bureaucromancer/lantern-schema';

import type {
  Adapter,
  BackendHealth,
  HealthReport,
  ManagedRoute,
  Manager,
  ModelIdentity,
} from '../../adapters/shared/index.js';
import { newId } from '../../ids.js';
import {
  BackendStore,
  canonicalText,
  type BackendRow,
  type ModelRow,
  type RouteRow,
  type StoreLog,
} from '../../store/index.js';
import {
  catalogEntry,
  type CatalogEntry,
  type CatalogModel,
  type ModelCatalog,
} from '../catalog/index.js';
import { descriptorDigest } from '../descriptor/index.js';
import type { BackendBindings, RouteBinding } from '../jobs/bindings.js';
import type { EventBus } from '../jobs/events.js';
import type { ProfileRegistry } from '../profiles/index.js';
import type { ResolverModel } from '../resolver/index.js';
import { GENERIC_FAMILY, guessFamily, trustworthy } from './guess.js';
import type { BackendKindDefinition, BackendKinds } from './kinds.js';

/** How often an adapter backend's health is checked. */
export const HEALTH_POLL_MS = 15_000;
/** How often a manager is asked, unless its settings say otherwise. */
export const MANAGER_POLL_MS = 5_000;
/** How old a descriptor may get before a poll re-reads it. */
export const DESCRIBE_EVERY_MS = 5 * 60_000;
/** How long a start waits for every backend's first answer. */
export const STARTUP_WAIT_MS = 5_000;
/** How long creating a backend waits for its first answer. */
export const CREATE_WAIT_MS = 10_000;
/** How long stopping waits for refreshes in flight. */
const STOP_WAIT_MS = 2_000;
/** How often an unchanged backend's `last_seen` is written down. */
const LAST_SEEN_WRITE_MS = 60_000;

/** A backend from `lantern.json`. */
export interface ConfigBackend {
  /** Stable: the database row and every job's route snapshot name it. */
  readonly id: string;
  readonly kind: string;
  readonly baseUrl: string;
  readonly name?: string;
  readonly settings?: Readonly<Record<string, unknown>>;
  /** Secret name to environment variable, so the file holds no secret. */
  readonly secretsFromEnv?: Readonly<Record<string, string>>;
  readonly resourceGroup?: string;
  readonly concurrency?: number;
}

/**
 * A model held in memory only, never written down: the development model
 * (`LANTERN_DEV=1`) with the mock backend serving it, or a test's model
 * with no backend at all.
 */
export interface FixedModel {
  readonly model: CatalogModel;
  /** The display name. */
  readonly name: string;
  /** The backend serving it, when one does; its one route is the model's. */
  readonly backend?: {
    readonly id: string;
    readonly kind: string;
    readonly name: string;
    readonly binding: RouteBinding;
  };
}

/** A config backend the registry cannot take: a usage error at startup. */
export class BackendConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendConfigError';
  }
}

export interface BackendRegistryOptions {
  /** `lantern.db`'s connection. */
  readonly db: DatabaseSync;
  readonly profiles: ProfileRegistry;
  readonly events: EventBus;
  readonly log: StoreLog;
  readonly kinds: BackendKinds;
  /** For config backends' `secretsFromEnv`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Epoch milliseconds; `Date.now` by default. */
  readonly now?: () => number;
  readonly healthMs?: number;
  readonly describeMs?: number;
  readonly startupWaitMs?: number;
  readonly createWaitMs?: number;
  /** Models in memory only: the development model, a test's. */
  readonly fixed?: readonly FixedModel[];
}

/** A backend while the daemon runs: its row, and what talks to it. */
interface BackendRuntime {
  row: BackendRow;
  readonly definition: BackendKindDefinition;
  /** An adapter kind's one adapter. */
  readonly adapter: Adapter | null;
  /** A manager kind's manager. */
  readonly manager: Manager | null;
  /** A manager's children, by base URL: one adapter per instance. */
  readonly children: Map<string, Adapter>;
  /** Capabilities a manager supplied, by base URL (L3). */
  readonly supplied: Map<string, unknown>;
  timer: NodeJS.Timeout | null;
  inflight: Promise<void> | null;
  readonly abort: AbortController;
  /** Why it could not be set up, when it could not. */
  broken: string | null;
  /** When its health was last written to the database. */
  written?: number;
}

/** What creating a backend answers. */
export type CreateOutcome =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly kind: 'invalid'; readonly issues: readonly ValidationIssue[] }
  | { readonly ok: false; readonly kind: 'conflict'; readonly message: string };

/** What changing a model answers. */
export type ModelPatchOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'missing' | 'fixed' }
  | { readonly ok: false; readonly kind: 'invalid'; readonly issues: readonly ValidationIssue[] };

/** A host's resource group: loopback names are one host (A12). */
export function defaultResourceGroup(baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return baseUrl;
  }
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) ? 'localhost' : host;
}

/** A base URL without its trailing slashes, so one address is one string. */
export function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored fingerprint, when it is one (L4). */
function fingerprintOf(value: unknown): ModelIdentity | undefined {
  if (!isRecord(value)) return undefined;
  if (value['kind'] === 'file' && typeof value['path'] === 'string') {
    return {
      kind: 'file',
      path: value['path'],
      stem: typeof value['stem'] === 'string' ? value['stem'] : '',
    };
  }
  if (
    value['kind'] === 'manager' &&
    typeof value['manager'] === 'string' &&
    typeof value['model_id'] === 'string' &&
    typeof value['definition_hash'] === 'string'
  ) {
    return {
      kind: 'manager',
      manager: value['manager'],
      model_id: value['model_id'],
      definition_hash: value['definition_hash'],
    };
  }
  return undefined;
}

/** A stored backend health report, when it is one. */
function healthOf(value: unknown): BackendHealthReport | null {
  if (!isRecord(value)) return null;
  const { status, load_state: loadState, detail } = value;
  if (status !== 'ok' && status !== 'degraded' && status !== 'down') return null;
  if (loadState !== 'loaded' && loadState !== 'cold' && loadState !== 'unknown') return null;
  return { status, load_state: loadState, ...(typeof detail === 'string' ? { detail } : {}) };
}

/** A route row's health as the resolver reads it. */
export function routeHealth(row: RouteRow): RouteHealth {
  return {
    status: row.health,
    load_state: row.loadState,
    ...(row.healthDetail === null ? {} : { detail: row.healthDetail }),
  };
}

function nameHints(identity: ModelIdentity, extra: readonly string[]): string[] {
  return identity.kind === 'file'
    ? [...extra, identity.stem, identity.path]
    : [...extra, identity.model_id];
}

function displayNameFor(identity: ModelIdentity, managerRef?: string): string {
  if (managerRef !== undefined && managerRef !== '') return managerRef;
  if (identity.kind === 'file') {
    if (identity.stem !== '') return identity.stem;
    const file = identity.path.split(/[/\\]/).at(-1);
    return file === undefined || file === '' ? identity.path : file;
  }
  return identity.model_id;
}

export class BackendRegistry implements ModelCatalog, BackendBindings {
  readonly #store: BackendStore;
  readonly #profiles: ProfileRegistry;
  readonly #events: EventBus;
  readonly #log: StoreLog;
  readonly #kinds: BackendKinds;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #now: () => number;
  readonly #healthMs: number;
  readonly #describeMs: number;
  readonly #startupWaitMs: number;
  readonly #createWaitMs: number;

  readonly #runtimes = new Map<string, BackendRuntime>();
  readonly #models = new Map<string, ModelRow>();
  readonly #routes = new Map<string, RouteRow>();
  /** Secrets read from the environment for config backends; never written down. */
  readonly #envSecrets = new Map<string, Record<string, string>>();
  /** In-memory models by model id. */
  readonly #fixed = new Map<string, FixedModel>();
  /** In-memory backends' health, by backend id. */
  readonly #fixedHealth = new Map<string, BackendHealthReport>();
  /** Catalog entries by model id, rebuilt when anything they read changes. */
  #entries: Map<string, CatalogEntry | null> | null = null;
  /** The last `backend.health` published per backend, to publish only changes. */
  readonly #published = new Map<string, string>();
  #started = false;
  #stopped = false;

  constructor(options: BackendRegistryOptions) {
    this.#store = new BackendStore(options.db);
    this.#profiles = options.profiles;
    this.#events = options.events;
    this.#log = options.log;
    this.#kinds = options.kinds;
    this.#env = options.env ?? {};
    this.#now = options.now ?? Date.now;
    this.#healthMs = options.healthMs ?? HEALTH_POLL_MS;
    this.#describeMs = options.describeMs ?? DESCRIBE_EVERY_MS;
    this.#startupWaitMs = options.startupWaitMs ?? STARTUP_WAIT_MS;
    this.#createWaitMs = options.createWaitMs ?? CREATE_WAIT_MS;
    for (const fixed of options.fixed ?? []) this.#fixed.set(fixed.model.id, fixed);
    // What the last run knew, so models resolve before their backends answer.
    for (const model of this.#store.models()) this.#models.set(model.id, model);
    for (const route of this.#store.routes()) this.#routes.set(route.id, route);
  }

  /** The in-memory backends, with the model each serves. */
  private fixedBackends(): (FixedModel & { backend: NonNullable<FixedModel['backend']> })[] {
    return [...this.#fixed.values()].flatMap((fixed) =>
      fixed.backend === undefined ? [] : [{ ...fixed, backend: fixed.backend }],
    );
  }

  get profiles(): ProfileRegistry {
    return this.#profiles;
  }

  get kinds(): BackendKinds {
    return this.#kinds;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Loads the registry, reconciles the config backends, sets every active
   * backend up and waits (a few seconds at most) for their first answers,
   * then keeps polling.
   *
   * @throws BackendConfigError for a config backend that cannot be taken
   */
  async start(input: { config?: readonly ConfigBackend[] } = {}): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.reconcile(input.config ?? []);

    for (const row of this.#store.backends()) {
      if (row.status === 'active') await this.setUp(row);
    }
    this.invalidate();
    const first = [...this.#runtimes.values()].map((runtime) => this.refresh(runtime, false));
    await Promise.race([
      Promise.allSettled(first),
      new Promise((resolve) => {
        setTimeout(resolve, this.#startupWaitMs).unref();
      }),
    ]);
    for (const runtime of this.#runtimes.values()) this.schedule(runtime);
    await this.pollFixed();
  }

  /** Stops polling; aborts what is in flight. */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const runtime of this.#runtimes.values()) {
      if (runtime.timer !== null) clearTimeout(runtime.timer);
      runtime.timer = null;
      runtime.abort.abort(new Error('Lantern is stopping.'));
    }
    // A backend that hangs rather than refuses must not hold the shutdown for
    // its whole timeout: what a late refresh writes after the database closes
    // fails, quietly, and changes nothing.
    await Promise.race([
      Promise.allSettled(
        [...this.#runtimes.values()].flatMap((runtime) =>
          runtime.inflight === null ? [] : [runtime.inflight],
        ),
      ),
      new Promise((resolve) => {
        setTimeout(resolve, STOP_WAIT_MS).unref();
      }),
    ]);
  }

  /** Brings `lantern.json`'s backends into the database, tombstoning those it dropped. */
  private reconcile(config: readonly ConfigBackend[]): void {
    const now = this.#now();
    const seen = new Set<string>();
    for (const entry of config) {
      if (seen.has(entry.id)) {
        throw new BackendConfigError(`lantern.json lists the backend "${entry.id}" twice.`);
      }
      seen.add(entry.id);
      const definition = this.#kinds.get(entry.kind);
      if (definition === undefined) {
        throw new BackendConfigError(
          `lantern.json's backend "${entry.id}" has the kind "${entry.kind}", which this Lantern does not know (it knows ${this.#kinds
            .list()
            .map((kind) => kind.kind)
            .join(', ')}).`,
        );
      }
      const secrets: Record<string, string> = {};
      for (const [name, variable] of Object.entries(entry.secretsFromEnv ?? {})) {
        const value = this.#env[variable];
        if (value === undefined || value === '') {
          throw new BackendConfigError(
            `lantern.json's backend "${entry.id}" reads its ${name} from ${variable}, which is not set.`,
          );
        }
        secrets[name] = value;
      }
      try {
        definition.checkSettings(entry.settings ?? {});
        definition.checkSecrets(secrets);
      } catch (error) {
        throw new BackendConfigError(
          `lantern.json's backend "${entry.id}" is not valid: ${errorMessage(error)}`,
        );
      }
      this.#envSecrets.set(entry.id, secrets);
      const baseUrl = normaliseBaseUrl(entry.baseUrl);
      const fields = {
        kind: entry.kind,
        name: entry.name ?? `${definition.name} at ${baseUrl}`,
        baseUrl,
        settings: { ...entry.settings },
        resourceGroup: entry.resourceGroup ?? defaultResourceGroup(baseUrl),
        concurrency: entry.concurrency ?? 1,
        status: 'active' as const,
        updatedAt: now,
      };
      const existing = this.#store.backend(entry.id);
      if (existing === undefined) {
        this.#store.insertBackend({
          id: entry.id,
          ...fields,
          secrets: null,
          source: 'config',
          health: null,
          lastSeen: null,
          createdAt: now,
        });
        this.#log.info('Registered a backend from lantern.json.', {
          backend: entry.id,
          kind: entry.kind,
        });
      } else if (existing.source !== 'config') {
        throw new BackendConfigError(
          `lantern.json's backend id "${entry.id}" is taken by a backend added in the app; choose another id.`,
        );
      } else {
        this.#store.updateBackend(entry.id, fields);
      }
    }
    for (const row of this.#store.backends()) {
      if (row.source !== 'config' || row.status !== 'active' || seen.has(row.id)) continue;
      this.#store.updateBackend(row.id, { status: 'tombstoned', updatedAt: now });
      this.#log.info('A backend left lantern.json; it is tombstoned and serves nothing.', {
        backend: row.id,
      });
    }
  }

  /** Builds and initialises what talks to a backend. A failure leaves it broken, not absent. */
  private async setUp(row: BackendRow): Promise<BackendRuntime | null> {
    const definition = this.#kinds.get(row.kind);
    if (definition === undefined) {
      this.#log.warn('A registered backend has a kind this Lantern does not know.', {
        backend: row.id,
        kind: row.kind,
      });
      return null;
    }
    const runtime: BackendRuntime = {
      row,
      definition,
      adapter: definition.role === 'adapter' ? this.#kinds.adapter(row.kind) : null,
      manager: definition.role === 'manager' ? this.#kinds.manager(row.kind) : null,
      children: new Map(),
      supplied: new Map(),
      timer: null,
      inflight: null,
      abort: new AbortController(),
      broken: null,
    };
    const config = {
      backendId: row.id,
      baseUrl: row.baseUrl,
      settings: row.settings,
      ...this.secretsFor(row),
    };
    try {
      await (runtime.adapter ?? runtime.manager)?.init(config);
    } catch (error) {
      runtime.broken = errorMessage(error);
      this.#log.error('A backend could not be set up.', { backend: row.id, error: runtime.broken });
    }
    this.#runtimes.set(row.id, runtime);
    return runtime;
  }

  private secretsFor(row: BackendRow): { secrets?: Readonly<Record<string, string>> } {
    const secrets = row.source === 'config' ? this.#envSecrets.get(row.id) : row.secrets;
    return secrets === undefined || secrets === null || Object.keys(secrets).length === 0
      ? {}
      : { secrets };
  }

  private schedule(runtime: BackendRuntime): void {
    if (this.#stopped || runtime.timer !== null) return;
    const pollMs = runtime.row.settings['pollMs'];
    const ms =
      runtime.manager === null
        ? this.#healthMs
        : typeof pollMs === 'number' && pollMs > 0
          ? pollMs
          : MANAGER_POLL_MS;
    runtime.timer = setTimeout(() => {
      runtime.timer = null;
      void this.refresh(runtime, false).finally(() => {
        this.schedule(runtime);
      });
    }, ms);
    runtime.timer.unref();
  }

  // -------------------------------------------------------------------------
  // Refresh
  // -------------------------------------------------------------------------

  /**
   * Asks a backend what it serves, one refresh at a time: a forced one
   * waits for the one in flight, then re-reads every descriptor.
   */
  private refresh(runtime: BackendRuntime, describe: boolean): Promise<void> {
    const previous = runtime.inflight;
    if (previous !== null && !describe) return previous;
    const run = (async () => {
      if (previous !== null) await previous.catch(() => undefined);
      try {
        if (runtime.broken !== null) {
          this.setBackendHealth(runtime, {
            status: 'down',
            load_state: 'unknown',
            detail: runtime.broken,
          });
        } else if (runtime.manager !== null) {
          await this.refreshManaged(runtime, runtime.manager, describe);
        } else if (runtime.adapter !== null) {
          await this.refreshStandalone(runtime, runtime.adapter, describe);
        }
      } catch (error) {
        if (!runtime.abort.signal.aborted) {
          this.#log.warn('A backend could not be refreshed.', {
            backend: runtime.row.id,
            error: errorMessage(error),
          });
        }
      } finally {
        this.publish(runtime.row.id);
      }
    })();
    runtime.inflight = run;
    void run.finally(() => {
      if (runtime.inflight === run) runtime.inflight = null;
    });
    return run;
  }

  /** An adapter kind: its health, then the model it serves, then (when due) its descriptor. */
  private async refreshStandalone(
    runtime: BackendRuntime,
    adapter: Adapter,
    describe: boolean,
  ): Promise<void> {
    const { row } = runtime;
    const health = await adapter.health();
    this.setBackendHealth(runtime, health);
    const active = this.routesOf(row.id).filter((route) => route.retiredAt === null);
    if (health.status === 'down') {
      for (const route of active) this.setRouteHealth(route, health);
      return;
    }

    let identity: ModelIdentity | null;
    try {
      identity = await adapter.identify(active[0]?.id ?? row.id);
    } catch (error) {
      const detail = `It did not say which model it serves: ${errorMessage(error)}`;
      this.setBackendHealth(runtime, { status: 'degraded', load_state: 'unknown', detail });
      for (const route of active) {
        this.setRouteHealth(route, { status: 'degraded', load_state: 'unknown', detail });
      }
      return;
    }
    if (identity === null) {
      this.setBackendHealth(runtime, {
        status: 'degraded',
        load_state: 'unknown',
        detail: 'It reports no model.',
      });
      for (const route of active) this.retire(route, 'The backend reports no model.');
      return;
    }

    const model = this.modelFor(identity, []);
    const route = this.routeFor(runtime, model, row.baseUrl, undefined);
    for (const other of active) {
      if (other.id !== route.id) this.retire(other, 'The backend now serves another model.');
    }
    await this.describeIfDue(runtime, adapter, route, describe);
    this.setRouteHealth(this.#routes.get(route.id) ?? route, health);
  }

  /** A manager kind: what it reports, each child identified and described, the rest retired. */
  private async refreshManaged(
    runtime: BackendRuntime,
    manager: Manager,
    describe: boolean,
  ): Promise<void> {
    const { row } = runtime;
    const report = await manager.discover(runtime.abort.signal);
    this.setBackendHealth(runtime, report.health);
    if (report.health.status === 'down') {
      for (const route of this.routesOf(row.id)) {
        if (route.retiredAt === null) this.setRouteHealth(route, report.health);
      }
      return;
    }

    const kept = new Set<string>();
    for (const managed of report.routes) {
      const known = this.routesOf(row.id).find(
        (route) => route.managerRef === managed.ref && route.retiredAt === null,
      );
      if (managed.health.status === 'down') {
        if (known !== undefined) {
          kept.add(known.id);
          this.setRouteHealth(known, managed.health);
        }
        continue;
      }
      const adapter = await this.childAdapter(runtime, managed);
      let identity: ModelIdentity | null;
      try {
        identity = managed.identity ?? (await adapter.identify(known?.id ?? managed.ref));
      } catch (error) {
        // A child that has not started answering yet: wait for the next poll.
        if (known !== undefined) {
          kept.add(known.id);
          this.setRouteHealth(known, {
            status: 'degraded',
            load_state: managed.health.load_state,
            detail: `The instance does not answer yet: ${errorMessage(error)}`,
          });
        }
        continue;
      }
      if (identity === null) continue;
      const hints = [
        managed.ref,
        typeof managed.detail?.['checkpoint'] === 'string' ? managed.detail['checkpoint'] : '',
      ];
      const model = this.modelFor(identity, hints, managed.ref);
      const route = this.routeFor(runtime, model, managed.base_url, managed.ref);
      kept.add(route.id);
      try {
        await this.describeIfDue(runtime, adapter, route, describe);
      } catch (error) {
        // One child that cannot be described must not stop the others being seen.
        this.#log.warn('A route’s capabilities could not be read.', {
          backend: row.id,
          route: route.id,
          error: errorMessage(error),
        });
        this.setRouteHealth(this.#routes.get(route.id) ?? route, {
          status: 'degraded',
          load_state: managed.health.load_state,
          detail: `Its capabilities could not be read: ${errorMessage(error)}`,
        });
        continue;
      }
      this.setRouteHealth(this.#routes.get(route.id) ?? route, managed.health);
    }
    for (const route of this.routesOf(row.id)) {
      if (route.retiredAt === null && !kept.has(route.id)) {
        this.retire(route, `${runtime.definition.name} no longer has the model loaded.`);
      }
    }
  }

  /** The adapter for a manager's child: one per base URL, initialised once. */
  private async childAdapter(runtime: BackendRuntime, managed: ManagedRoute): Promise<Adapter> {
    if (managed.capabilities !== undefined)
      runtime.supplied.set(managed.base_url, managed.capabilities);
    const existing = runtime.children.get(managed.base_url);
    if (existing !== undefined) return existing;
    const supplied = runtime.supplied.has(managed.base_url)
      ? { capabilities: () => Promise.resolve(runtime.supplied.get(managed.base_url)) }
      : {};
    const adapter = this.#kinds.adapter(managed.adapter, supplied);
    await adapter.init({ backendId: runtime.row.id, baseUrl: managed.base_url, settings: {} });
    runtime.children.set(managed.base_url, adapter);
    return adapter;
  }

  /** The adapter serving a route now: the backend's own, or the child at the route's address. */
  private adapterOf(runtime: BackendRuntime, route: RouteRow): Adapter | null {
    if (runtime.adapter !== null) return runtime.adapter;
    const existing = runtime.children.get(route.baseUrl);
    if (existing !== undefined) return existing;
    // A route known from the last run whose child has not been seen yet:
    // bound at its last address, so a resumed job can check its instance.
    const adapter = this.#kinds.adapter(route.adapterKind);
    void adapter.init({ backendId: runtime.row.id, baseUrl: route.baseUrl, settings: {} });
    runtime.children.set(route.baseUrl, adapter);
    return adapter;
  }

  /** Re-reads a route's descriptor when it is new, moved, back, forced, or old. */
  private async describeIfDue(
    runtime: BackendRuntime,
    adapter: Adapter,
    route: RouteRow,
    force: boolean,
  ): Promise<void> {
    const due =
      force ||
      route.descriptor === null ||
      route.descriptorFetchedAt === null ||
      this.#now() - route.descriptorFetchedAt >= this.#describeMs;
    if (!due) return;
    const [described] = await adapter.describe();
    if (described === undefined) throw new Error('The backend described no route.');
    const descriptor: RouteDescriptor = { ...described, route: route.id };
    const issues = checkRouteDescriptor(descriptor);
    if (issues.length > 0) {
      throw new Error(
        `The backend's descriptor breaks a rule: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
      );
    }
    this.updateRoute(route.id, {
      descriptor,
      descriptorDigest: descriptorDigest(descriptor),
      descriptorFetchedAt: this.#now(),
    });
    this.#log.info('Read a route’s capabilities.', {
      backend: runtime.row.id,
      route: route.id,
      modes: Object.keys(descriptor.modes),
    });
  }

  // -------------------------------------------------------------------------
  // Rows
  // -------------------------------------------------------------------------

  private routesOf(backendId: string): RouteRow[] {
    return [...this.#routes.values()].filter((route) => route.backendId === backendId);
  }

  /**
   * The model with this identity (A26), registered when it is new: with the
   * profile a person confirmed, a sure enough guess, or the generic one.
   */
  private modelFor(
    identity: ModelIdentity,
    hints: readonly string[],
    managerRef?: string,
  ): ModelRow {
    const fingerprint = canonicalText(identity);
    for (const model of this.#models.values()) {
      if (canonicalText(model.fingerprint) === fingerprint) return model;
    }
    const guess = guessFamily(nameHints(identity, hints), this.#profiles);
    const sure = trustworthy(guess);
    const now = this.#now();
    const model: ModelRow = {
      id: newId('mdl'),
      displayName: displayNameFor(identity, managerRef),
      family: sure ? guess.family : GENERIC_FAMILY,
      variant: sure ? (guess.variant ?? null) : null,
      fingerprint: identity,
      profileOverrides: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#store.insertModel(model);
    this.#models.set(model.id, model);
    this.invalidate();
    this.#log.info('Registered a model a backend serves.', {
      model: model.id,
      name: model.displayName,
      family: model.family,
      confidence: guess.confidence,
    });
    return model;
  }

  /** The route for a backend and a model: the one it had (brought back), or a new one. */
  private routeFor(
    runtime: BackendRuntime,
    model: ModelRow,
    baseUrl: string,
    managerRef: string | undefined,
  ): RouteRow {
    const existing = this.routesOf(runtime.row.id).find((route) => route.modelId === model.id);
    const now = this.#now();
    if (existing !== undefined) {
      const moved = existing.baseUrl !== baseUrl;
      if (existing.retiredAt !== null || moved || existing.managerRef !== (managerRef ?? null)) {
        this.updateRoute(existing.id, {
          retiredAt: null,
          baseUrl,
          managerRef: managerRef ?? null,
          // A route back from retirement, or at a new address, is read again.
          ...(existing.retiredAt !== null || moved ? { descriptorFetchedAt: null } : {}),
        });
        if (existing.retiredAt !== null) {
          this.#log.info('A route is back.', { route: existing.id, model: model.id, baseUrl });
        }
      }
      return this.#routes.get(existing.id) ?? existing;
    }
    const route: RouteRow = {
      id: newId('rt'),
      modelId: model.id,
      backendId: runtime.row.id,
      adapterKind: runtime.definition.adapterKind ?? runtime.row.kind,
      managerRef: managerRef ?? null,
      baseUrl,
      priority: 0,
      cost: null,
      health: 'ok',
      loadState: 'unknown',
      healthDetail: null,
      retiredAt: null,
      descriptor: null,
      descriptorDigest: null,
      descriptorFetchedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#store.insertRoute(route);
    this.#routes.set(route.id, route);
    this.invalidate();
    this.#log.info('Registered a route.', {
      route: route.id,
      backend: runtime.row.id,
      model: model.id,
    });
    return route;
  }

  private updateRoute(id: string, patch: Partial<RouteRow>): void {
    const current = this.#routes.get(id);
    if (current === undefined) return;
    const next = { ...current, ...patch, updatedAt: this.#now() };
    this.#store.updateRoute(id, { ...patch, updatedAt: next.updatedAt });
    this.#routes.set(id, next);
    this.invalidate();
  }

  private retire(route: RouteRow, detail: string): void {
    if (route.retiredAt !== null) return;
    this.updateRoute(route.id, {
      retiredAt: this.#now(),
      health: 'down',
      loadState: 'cold',
      healthDetail: detail,
    });
    this.#log.info('Retired a route.', { route: route.id, reason: detail });
  }

  private setRouteHealth(route: RouteRow, health: HealthReport): void {
    const detail = health.detail ?? null;
    if (
      route.health === health.status &&
      route.loadState === health.load_state &&
      route.healthDetail === detail
    ) {
      return;
    }
    this.updateRoute(route.id, {
      health: health.status,
      loadState: health.load_state,
      healthDetail: detail,
    });
  }

  private setBackendHealth(runtime: BackendRuntime, health: BackendHealth): void {
    const report: BackendHealthReport = {
      status: health.status,
      load_state: health.load_state,
      ...(health.detail === undefined ? {} : { detail: health.detail }),
    };
    const now = this.#now();
    const up = health.status !== 'down';
    const changed = canonicalText(runtime.row.health) !== canonicalText(report);
    const patch: Partial<BackendRow> = { health: report, ...(up ? { lastSeen: now } : {}) };
    runtime.row = { ...runtime.row, ...patch };
    // Written through when it changed, and `last_seen` once a minute at most.
    const stale = up && (runtime.written ?? 0) + LAST_SEEN_WRITE_MS <= now;
    if (!changed && !stale) return;
    runtime.written = now;
    this.#store.updateBackend(runtime.row.id, { ...patch, updatedAt: now });
  }

  /** Publishes `backend.health` when what a client would see changed (A31). */
  private publish(backendId: string): void {
    const data = this.healthEvent(backendId);
    if (data === undefined) return;
    const text = canonicalText(data);
    if (this.#published.get(backendId) === text) return;
    this.#published.set(backendId, text);
    this.#events.publish({
      type: 'backend.health',
      data: data as unknown as Record<string, unknown>,
    });
  }

  /** The `backend.health` event for a backend. */
  healthEvent(backendId: string): BackendHealthEvent | undefined {
    const fixed = this.fixedBackends().find((entry) => entry.backend.id === backendId);
    if (fixed !== undefined) {
      return {
        backend: backendId,
        health: this.#fixedHealth.get(backendId) ?? null,
        routes: fixed.model.routes.map((route) => ({
          id: route.id,
          model_id: fixed.model.id,
          status: 'active',
          health: route.health,
        })),
      };
    }
    const runtime = this.#runtimes.get(backendId);
    const row = runtime?.row ?? this.#store.backend(backendId);
    if (row === undefined) return undefined;
    return {
      backend: backendId,
      health: healthOf(row.health),
      routes: this.routesOf(backendId).map((route) => ({
        id: route.id,
        model_id: route.modelId,
        status: route.retiredAt === null ? 'active' : 'retired',
        health: routeHealth(route),
      })),
    };
  }

  /** The in-memory backends' health: asked at start and on a refresh, as their adapters answer. */
  private async pollFixed(): Promise<void> {
    for (const { backend } of this.fixedBackends()) {
      try {
        const health = await backend.binding.adapter.health();
        this.#fixedHealth.set(backend.id, {
          status: health.status,
          load_state: health.load_state,
          ...(health.detail === undefined ? {} : { detail: health.detail }),
        });
      } catch {
        this.#fixedHealth.set(backend.id, { status: 'down', load_state: 'unknown' });
      }
      this.publish(backend.id);
    }
  }

  // -------------------------------------------------------------------------
  // The catalog (ModelCatalog)
  // -------------------------------------------------------------------------

  private invalidate(): void {
    this.#entries = null;
  }

  private entries(): Map<string, CatalogEntry | null> {
    if (this.#entries !== null) return this.#entries;
    const entries = new Map<string, CatalogEntry | null>();
    for (const fixed of this.#fixed.values()) {
      entries.set(fixed.model.id, catalogEntry(fixed.model, this.#profiles));
    }
    for (const model of this.#models.values()) {
      const catalogModel = this.catalogModel(model);
      try {
        entries.set(model.id, catalogEntry(catalogModel, this.#profiles));
      } catch (error) {
        // A family a newer build named, or a descriptor that no longer merges.
        this.#log.warn('A model cannot be used as it is registered.', {
          model: model.id,
          error: errorMessage(error),
        });
        entries.set(model.id, null);
      }
    }
    this.#entries = entries;
    return entries;
  }

  /** A model row and its usable routes, as the catalog merges them. */
  private catalogModel(model: ModelRow): CatalogModel {
    const fingerprint = fingerprintOf(model.fingerprint);
    return {
      id: model.id,
      family: model.family,
      ...(model.variant === null ? {} : { variant: model.variant }),
      ...(isRecord(model.profileOverrides)
        ? {
            profile_overrides: model.profileOverrides,
          }
        : {}),
      routes: [...this.#routes.values()]
        .filter((route) => route.modelId === model.id)
        .filter((route) => this.#runtimes.get(route.backendId)?.row.status === 'active')
        .flatMap((route) =>
          isRecord(route.descriptor)
            ? [
                {
                  id: route.id,
                  backend_kind: route.adapterKind,
                  priority: route.priority,
                  health: routeHealth(route),
                  describe: route.descriptor as RouteDescriptor,
                  ...(fingerprint === undefined ? {} : { fingerprint }),
                },
              ]
            : [],
        ),
    };
  }

  get(id: string): ResolverModel | undefined {
    return this.entries().get(id)?.model;
  }

  list(): readonly ResolverModel[] {
    return [...this.entries().values()].flatMap((entry) => (entry === null ? [] : [entry.model]));
  }

  // -------------------------------------------------------------------------
  // Bindings (BackendBindings)
  // -------------------------------------------------------------------------

  binding(routeId: string): RouteBinding | undefined {
    for (const { backend } of this.fixedBackends()) {
      if (backend.binding.routeId === routeId) return backend.binding;
    }
    const route = this.#routes.get(routeId);
    if (route === undefined) return undefined;
    const runtime = this.#runtimes.get(route.backendId);
    if (runtime?.row.status !== 'active' || runtime.broken !== null) return undefined;
    const adapter = this.adapterOf(runtime, route);
    if (adapter === null) return undefined;
    return {
      routeId,
      backendId: runtime.row.id,
      backendKind: route.adapterKind,
      ...(runtime.manager === null || route.managerRef === null
        ? {}
        : { manager: { kind: runtime.row.kind, ref: route.managerRef } }),
      baseUrl: route.baseUrl,
      adapter,
      resourceGroup: runtime.row.resourceGroup,
      concurrency: runtime.row.concurrency,
    };
  }

  concurrency(group: string): number {
    let least = Number.POSITIVE_INFINITY;
    for (const runtime of this.#runtimes.values()) {
      if (runtime.row.resourceGroup === group && runtime.row.status === 'active') {
        least = Math.min(least, runtime.row.concurrency);
      }
    }
    for (const { backend } of this.fixedBackends()) {
      if (backend.binding.resourceGroup === group) {
        least = Math.min(least, backend.binding.concurrency);
      }
    }
    return Number.isFinite(least) ? Math.max(1, least) : 1;
  }

  all(): readonly RouteBinding[] {
    const bindings = this.fixedBackends().map(({ backend }) => backend.binding);
    for (const route of this.#routes.values()) {
      const binding = this.binding(route.id);
      if (binding !== undefined) bindings.push(binding);
    }
    return bindings;
  }

  // -------------------------------------------------------------------------
  // What the API reads
  // -------------------------------------------------------------------------

  /** Every backend, in-memory ones as rows too, with what is known of each. */
  backendViews(): BackendView[] {
    const views: BackendView[] = [];
    for (const fixed of this.fixedBackends()) {
      const { backend } = fixed;
      views.push({
        id: backend.id,
        kind: backend.kind,
        role: 'adapter',
        name: backend.name,
        baseUrl: backend.binding.baseUrl,
        source: 'dev',
        status: 'active',
        resourceGroup: backend.binding.resourceGroup,
        concurrency: backend.binding.concurrency,
        settings: {},
        secrets: [],
        health: this.#fixedHealth.get(backend.id) ?? null,
        lastSeen: null,
        routes: fixed.model.routes.map((route) => ({
          id: route.id,
          modelId: fixed.model.id,
          modelName: fixed.name,
          adapterKind: route.backend_kind,
          managerRef: null,
          baseUrl: backend.binding.baseUrl,
          status: 'active',
          health: route.health,
          priority: route.priority,
          descriptorFetchedAt: null,
        })),
      });
    }
    const rows = this.#store.backends();
    for (const row of rows) {
      const runtime = this.#runtimes.get(row.id);
      const current = runtime?.row ?? row;
      const definition = this.#kinds.get(current.kind);
      const secrets =
        current.source === 'config' ? this.#envSecrets.get(current.id) : current.secrets;
      views.push({
        id: current.id,
        kind: current.kind,
        role: definition?.role ?? 'adapter',
        name: current.name,
        baseUrl: current.baseUrl,
        source: current.source,
        status: current.status,
        resourceGroup: current.resourceGroup,
        concurrency: current.concurrency,
        settings: current.settings,
        secrets: Object.keys(secrets ?? {}),
        health: healthOf(current.health),
        lastSeen: current.lastSeen,
        routes: this.routesOf(current.id).map((route) => ({
          id: route.id,
          modelId: route.modelId,
          modelName: this.#models.get(route.modelId)?.displayName ?? route.modelId,
          adapterKind: route.adapterKind,
          managerRef: route.managerRef,
          baseUrl: route.baseUrl,
          status: route.retiredAt === null ? 'active' : 'retired',
          health: routeHealth(route),
          priority: route.priority,
          descriptorFetchedAt: route.descriptorFetchedAt,
        })),
      });
    }
    return views.sort(
      (a, b) =>
        (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1) ||
        a.name.localeCompare(b.name) ||
        (a.id < b.id ? -1 : 1),
    );
  }

  backendView(id: string): BackendView | undefined {
    return this.backendViews().find((view) => view.id === id);
  }

  /** Every model, in-memory ones included, with its profile and every route. */
  modelViews(): ModelView[] {
    const entries = this.entries();
    const views = [
      ...[...this.#fixed.values()].map((fixed) =>
        this.viewOf(
          {
            id: fixed.model.id,
            displayName: fixed.name,
            family: fixed.model.family,
            variant: fixed.model.variant ?? null,
            fingerprint: fixed.model.routes[0]?.fingerprint ?? null,
            fixed: true,
          },
          entries.get(fixed.model.id) ?? null,
        ),
      ),
      ...[...this.#models.values()].map((model) =>
        this.viewOf(
          {
            id: model.id,
            displayName: model.displayName,
            family: model.family,
            variant: model.variant,
            fingerprint: fingerprintOf(model.fingerprint) ?? null,
            fixed: false,
          },
          entries.get(model.id) ?? null,
        ),
      ),
    ];
    return views.sort(
      (a, b) => a.displayName.localeCompare(b.displayName) || (a.id < b.id ? -1 : 1),
    );
  }

  /** One model, as {@link modelViews} has it. */
  modelView(id: string): ModelView | undefined {
    return this.modelViews().find((view) => view.id === id);
  }

  private viewOf(
    model: Pick<ModelView, 'id' | 'displayName' | 'family' | 'variant' | 'fingerprint' | 'fixed'>,
    entry: CatalogEntry | null,
  ): ModelView {
    const resolved = this.#profiles.resolve(model.family, model.variant ?? undefined);
    const routes: ModelRouteView[] = (entry?.model.routes ?? []).map((candidate) => {
      const row = this.#routes.get(candidate.id);
      const fixed = this.fixedBackends().find(
        (entry) => entry.backend.binding.routeId === candidate.id,
      )?.backend;
      const backendId = row?.backendId ?? fixed?.id ?? '';
      return {
        id: candidate.id,
        backendId,
        backendName: this.#runtimes.get(backendId)?.row.name ?? fixed?.name ?? backendId,
        adapterKind: candidate.backend_kind,
        status: row?.retiredAt == null ? 'active' : 'retired',
        health: candidate.health,
        priority: candidate.priority,
        modes: Object.keys(candidate.descriptor.modes) as GenerationMode[],
        descriptor: candidate.descriptor,
        descriptorDigest: candidate.descriptor_digest ?? descriptorDigest(candidate.descriptor),
      };
    });
    return {
      ...model,
      profile:
        resolved === undefined
          ? null
          : {
              family: resolved.family,
              name: resolved.name,
              ...(resolved.variant === undefined ? {} : { variant: resolved.variant.id }),
            },
      modes: [...new Set(routes.flatMap((route) => route.modes))],
      routes,
    };
  }

  /** The model registered with this fingerprint, if any (A26). */
  modelByFingerprint(fingerprint: ModelIdentity): string | undefined {
    const text = canonicalText(fingerprint);
    for (const model of this.#models.values()) {
      if (canonicalText(model.fingerprint) === text) return model.id;
    }
    return undefined;
  }

  /** The active backend of this kind at this address, if any. */
  registeredAt(kind: string, baseUrl: string): string | undefined {
    const wanted = normaliseBaseUrl(baseUrl);
    for (const runtime of this.#runtimes.values()) {
      if (
        runtime.row.status === 'active' &&
        runtime.row.kind === kind &&
        runtime.row.baseUrl === wanted
      ) {
        return runtime.row.id;
      }
    }
    return undefined;
  }

  /** A family guess for names, for the proposal card. */
  guess(identity: ModelIdentity, hints: readonly string[]): FamilyGuess {
    return guessFamily(nameHints(identity, hints), this.#profiles);
  }

  // -------------------------------------------------------------------------
  // Changes from the API
  // -------------------------------------------------------------------------

  /** Whether a family (and variant) names a loaded profile, as an issue when it does not. */
  private profileIssues(
    family: string,
    variant: string | undefined,
    at: string,
  ): ValidationIssue[] {
    const profile = this.#profiles.family(family);
    if (profile === undefined) {
      return [{ path: `${at}/family`, message: `is not a loaded profile (\`${family}\`)` }];
    }
    if (variant !== undefined && profile.variants?.some((v) => v.id === variant) !== true) {
      return [{ path: `${at}/variant`, message: `is not a variant of ${profile.name}` }];
    }
    return [];
  }

  /**
   * Adds a backend from the API (A26): records the confirmed models first, so
   * the first refresh finds them, then waits a few seconds for it to answer.
   */
  async create(body: CreateBackendBody): Promise<CreateOutcome> {
    const definition = this.#kinds.get(body.kind);
    if (definition === undefined) {
      return {
        ok: false,
        kind: 'invalid',
        issues: [{ path: '/kind', message: `is not a backend kind this Lantern knows` }],
      };
    }
    for (const [path, check] of [
      [
        '/settings',
        () => {
          definition.checkSettings(body.settings ?? {});
        },
      ],
      [
        '/secrets',
        () => {
          definition.checkSecrets(body.secrets ?? {});
        },
      ],
    ] as const) {
      try {
        check();
      } catch (error) {
        return { ok: false, kind: 'invalid', issues: [{ path, message: errorMessage(error) }] };
      }
    }
    const issues = (body.models ?? []).flatMap((model, i) =>
      this.profileIssues(model.family, model.variant, `/models/${String(i)}`),
    );
    if (issues.length > 0) return { ok: false, kind: 'invalid', issues };
    const baseUrl = normaliseBaseUrl(body.base_url);
    const taken = this.registeredAt(body.kind, baseUrl);
    if (taken !== undefined) {
      return {
        ok: false,
        kind: 'conflict',
        message: `A ${definition.name} backend is already registered at ${baseUrl} (${taken}).`,
      };
    }

    const now = this.#now();
    const row: BackendRow = {
      id: newId('be'),
      kind: body.kind,
      name: body.name ?? `${definition.name} at ${baseUrl}`,
      baseUrl,
      settings: { ...body.settings },
      secrets:
        body.secrets === undefined || Object.keys(body.secrets).length === 0
          ? null
          : { ...body.secrets },
      resourceGroup: body.resource_group ?? defaultResourceGroup(baseUrl),
      concurrency: body.concurrency ?? 1,
      source: 'ui',
      status: 'active',
      health: null,
      lastSeen: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#store.transaction(() => {
      this.#store.insertBackend(row);
      for (const confirmed of body.models ?? []) this.confirmModel(confirmed, now);
    });
    this.#log.info('Added a backend.', { backend: row.id, kind: row.kind, baseUrl });
    const runtime = await this.setUp(row);
    this.invalidate();
    if (runtime !== null) {
      await Promise.race([
        this.refresh(runtime, true),
        new Promise((resolve) => {
          setTimeout(resolve, this.#createWaitMs).unref();
        }),
      ]);
      this.schedule(runtime);
    }
    return { ok: true, id: row.id };
  }

  /** A proposal card's choices for one model: recorded, or applied to the model it already is. */
  private confirmModel(
    confirmed: NonNullable<CreateBackendBody['models']>[number],
    now: number,
  ): void {
    const identity = fingerprintOf(confirmed.fingerprint);
    if (identity === undefined) return;
    const existing = this.modelByFingerprint(identity);
    const fields = {
      family: confirmed.family,
      variant: confirmed.variant ?? null,
      ...(confirmed.display_name === undefined ? {} : { displayName: confirmed.display_name }),
      updatedAt: now,
    };
    if (existing !== undefined) {
      this.#store.updateModel(existing, fields);
      const current = this.#models.get(existing);
      if (current !== undefined) this.#models.set(existing, { ...current, ...fields });
      return;
    }
    const model: ModelRow = {
      id: newId('mdl'),
      displayName: confirmed.display_name ?? displayNameFor(identity),
      family: confirmed.family,
      variant: confirmed.variant ?? null,
      fingerprint: identity,
      profileOverrides: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#store.insertModel(model);
    this.#models.set(model.id, model);
  }

  /** Asks a backend again, re-reading every descriptor; resolves when it has answered. */
  async refreshNow(id: string): Promise<'ok' | 'missing' | 'tombstoned'> {
    if (this.fixedBackends().some((entry) => entry.backend.id === id)) {
      await this.pollFixed();
      return 'ok';
    }
    const runtime = this.#runtimes.get(id);
    if (runtime === undefined) {
      const row = this.#store.backend(id);
      if (row === undefined) return 'missing';
      return row.status === 'tombstoned' ? 'tombstoned' : 'missing';
    }
    if (runtime.row.status === 'tombstoned') return 'tombstoned';
    await this.refresh(runtime, true);
    return 'ok';
  }

  /** Renames a model or changes its profile (A26). */
  updateModel(id: string, patch: ModelPatchBody): ModelPatchOutcome {
    if (this.#fixed.has(id)) return { ok: false, kind: 'fixed' };
    const current = this.#models.get(id);
    if (current === undefined) return { ok: false, kind: 'missing' };
    const family = patch.family ?? current.family;
    const variant =
      patch.variant === undefined
        ? patch.family === undefined
          ? current.variant
          : null
        : patch.variant;
    const issues = this.profileIssues(family, variant ?? undefined, '');
    if (issues.length > 0) return { ok: false, kind: 'invalid', issues };
    const fields: Partial<ModelRow> = {
      family,
      variant,
      ...(patch.display_name === undefined ? {} : { displayName: patch.display_name }),
      updatedAt: this.#now(),
    };
    this.#store.updateModel(id, fields);
    this.#models.set(id, { ...current, ...fields });
    this.invalidate();
    return { ok: true };
  }
}

/** A backend, as the API layer maps it to the wire. */
export interface BackendView {
  readonly id: string;
  readonly kind: string;
  readonly role: 'adapter' | 'manager';
  readonly name: string;
  readonly baseUrl: string;
  readonly source: 'config' | 'ui' | 'dev';
  readonly status: 'active' | 'tombstoned';
  readonly resourceGroup: string;
  readonly concurrency: number;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly secrets: readonly string[];
  readonly health: BackendHealthReport | null;
  readonly lastSeen: number | null;
  readonly routes: readonly {
    readonly id: string;
    readonly modelId: string;
    readonly modelName: string;
    readonly adapterKind: string;
    readonly managerRef: string | null;
    readonly baseUrl: string;
    readonly status: 'active' | 'retired';
    readonly health: RouteHealth;
    readonly priority: number;
    readonly descriptorFetchedAt: number | null;
  }[];
}

export interface ModelRouteView {
  readonly id: string;
  readonly backendId: string;
  readonly backendName: string;
  readonly adapterKind: string;
  readonly status: 'active' | 'retired';
  readonly health: RouteHealth;
  readonly priority: number;
  readonly modes: readonly GenerationMode[];
  /** The effective descriptor: describe() with the profile layered over (A6). */
  readonly descriptor: RouteDescriptor;
  readonly descriptorDigest: string;
}

export interface ModelView {
  readonly id: string;
  readonly displayName: string;
  readonly family: string;
  readonly variant: string | null;
  readonly profile: {
    readonly family: string;
    readonly name: string;
    readonly variant?: string;
  } | null;
  readonly fingerprint: ModelFingerprint | null;
  readonly modes: readonly GenerationMode[];
  readonly routes: readonly ModelRouteView[];
  /** Held in memory only (the development model): it cannot be changed. */
  readonly fixed: boolean;
}
