// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The backend kinds this daemon can add (A26): adapters, which serve their
 * own routes, and managers, which discover routes an adapter serves (L1).
 * Each has JSON Schema for its settings and secrets, which the add form
 * renders without naming the kind (rule 3), and a check that holds a
 * settings object to it.
 *
 * The mock (D6) is not one of them: it is served under `LANTERN_DEV=1` as a
 * development backend, never added.
 */

import type { BackendKindInfo } from '@bureaucromancer/lantern-schema';

import {
  identityOf,
  parseCapabilities,
  readSdcppSettings,
  SDCPP_KIND,
  SDCPP_SETTINGS_SCHEMA,
  SdcppAdapter,
  servesImages,
} from '../../adapters/sdcpp/index.js';
import {
  joinUrl,
  request,
  type Adapter,
  type FetchLike,
  type Manager,
  type ModelIdentity,
} from '../../adapters/shared/index.js';
import {
  isLemonadeHealth,
  LEMONADE_ADAPTER,
  LEMONADE_HEALTH_PATH,
  LEMONADE_SECRETS_SCHEMA,
  LEMONADE_SETTINGS_SCHEMA,
  LemonadeManager,
  readLemonadeSettings,
  routesFromHealth,
} from '../../managers/lemonade/index.js';

/** A model a probe found: its identity, and every name known for it. */
export interface ProbedModel {
  readonly identity: ModelIdentity;
  /** A manager's own name for it. */
  readonly managerRef?: string;
  /** Names a family guess can read (a checkpoint). */
  readonly hints: readonly string[];
}

/** What a probe found at a URL (L9). */
export type ProbeResult =
  | { readonly found: false; readonly url: string; readonly detail: string }
  | {
      readonly found: true;
      readonly url: string;
      readonly detail: string;
      readonly models: readonly ProbedModel[];
    };

/** How long one probe request may take: autodetect answers in a few seconds. */
export const PROBE_TIMEOUT_MS = 3000;

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An sd-server's capabilities at a URL, or why not. */
async function probeCapabilities(
  fetchImpl: FetchLike,
  baseUrl: string,
): Promise<{ identity: ModelIdentity; name: string } | string> {
  const url = joinUrl(baseUrl, '/sdcpp/v1/capabilities');
  try {
    const answer = await request(fetchImpl, url, { timeoutMs: PROBE_TIMEOUT_MS });
    if (answer.status !== 200) return `${url} answered ${String(answer.status)}.`;
    const capabilities = parseCapabilities(answer.body);
    const identity = identityOf(capabilities);
    if (!servesImages(capabilities) || identity === null) return `${url} serves no image model.`;
    return { identity, name: capabilities.model.name };
  } catch (error) {
    return failure(error);
  }
}

/** A kind, as the registry uses it. */
export interface BackendKindDefinition {
  readonly kind: string;
  readonly role: 'adapter' | 'manager';
  readonly name: string;
  readonly description: string;
  /** For a manager: the adapter kind that serves the routes it finds. */
  readonly adapterKind?: string;
  readonly settingsSchema: Readonly<Record<string, unknown>>;
  readonly secretsSchema: Readonly<Record<string, unknown>>;
  /** Where autodetect looks on this machine (A32). */
  readonly defaultUrls: readonly string[];
  /**
   * Holds settings to the kind's rules.
   *
   * @throws TypeError naming what is wrong
   */
  checkSettings(settings: unknown): void;
  /**
   * Holds secrets to the kind's rules.
   *
   * @throws TypeError naming what is wrong
   */
  checkSecrets(secrets: Readonly<Record<string, string>>): void;
  /** Looks for the kind at a URL, by path (L9). Nothing it sends causes a load (L3). */
  probe(fetchImpl: FetchLike, baseUrl: string): Promise<ProbeResult>;
}

/** How adapters and managers are built: a `fetch` to use, and a supplied capabilities document. */
export interface KindBuildOptions {
  readonly fetch?: FetchLike;
  /** A capabilities document a manager captured (L3); the sd.cpp adapter reads it instead. */
  readonly capabilities?: () => Promise<unknown>;
}

export interface BackendKinds {
  /** The `fetch` adapters, managers and probes use. */
  readonly fetch: FetchLike;
  list(): readonly BackendKindDefinition[];
  get(kind: string): BackendKindDefinition | undefined;
  /** An adapter of an adapter kind, not yet initialised. */
  adapter(kind: string, options?: KindBuildOptions): Adapter;
  /** A manager of a manager kind, not yet initialised. */
  manager(kind: string, options?: KindBuildOptions): Manager;
}

const NO_SECRETS: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

function noSecrets(kind: string, secrets: Readonly<Record<string, string>>): void {
  if (Object.keys(secrets).length > 0) throw new TypeError(`The ${kind} kind takes no secrets.`);
}

export const SDCPP_DEFINITION: BackendKindDefinition = {
  kind: SDCPP_KIND,
  role: 'adapter',
  name: 'sd-server (stable-diffusion.cpp)',
  description:
    'One sd-server instance, reached through its native API (`/sdcpp/v1`). It serves one model, loaded when it started.',
  settingsSchema: SDCPP_SETTINGS_SCHEMA,
  secretsSchema: NO_SECRETS,
  defaultUrls: ['http://127.0.0.1:1234'],
  checkSettings(settings) {
    readSdcppSettings(settings);
  },
  checkSecrets(secrets) {
    noSecrets(SDCPP_KIND, secrets);
  },
  async probe(fetchImpl, baseUrl) {
    const url = joinUrl(baseUrl, '/sdcpp/v1/capabilities');
    const found = await probeCapabilities(fetchImpl, baseUrl);
    if (typeof found === 'string') return { found: false, url, detail: found };
    return {
      found: true,
      url,
      detail: `sd-server with ${found.name === '' ? 'a model' : found.name}`,
      models: [{ identity: found.identity, hints: [found.name] }],
    };
  },
};

export const LEMONADE_DEFINITION: BackendKindDefinition = {
  kind: 'lemonade',
  role: 'manager',
  name: 'Lemonade',
  description:
    'A Lemonade server. Each image model it loads runs as its own sd-server child, which Lantern finds through Lemonade and reaches directly; children listen on 127.0.0.1, so Lantern must run on the Lemonade host.',
  adapterKind: LEMONADE_ADAPTER,
  settingsSchema: LEMONADE_SETTINGS_SCHEMA,
  secretsSchema: LEMONADE_SECRETS_SCHEMA,
  defaultUrls: ['http://127.0.0.1:13305', 'http://127.0.0.1:8000'],
  checkSettings(settings) {
    readLemonadeSettings(settings);
  },
  checkSecrets(secrets) {
    for (const key of Object.keys(secrets)) {
      if (key !== 'apiKey') throw new TypeError(`Unknown Lemonade secret: ${key}.`);
    }
  },
  async probe(fetchImpl, baseUrl) {
    const url = joinUrl(baseUrl, LEMONADE_HEALTH_PATH);
    let body: unknown;
    try {
      const answer = await request(fetchImpl, url, { timeoutMs: PROBE_TIMEOUT_MS });
      if (answer.status !== 200) {
        return { found: false, url, detail: `${url} answered ${String(answer.status)}.` };
      }
      body = answer.body;
    } catch (error) {
      return { found: false, url, detail: failure(error) };
    }
    if (!isLemonadeHealth(body)) return { found: false, url, detail: `${url} is not Lemonade's.` };
    const models: ProbedModel[] = [];
    const missed: string[] = [];
    for (const route of routesFromHealth(body)) {
      if (route.health.status === 'down') continue;
      const found = await probeCapabilities(fetchImpl, route.base_url);
      if (typeof found === 'string') {
        missed.push(route.ref);
        continue;
      }
      const checkpoint = route.detail?.['checkpoint'];
      models.push({
        identity: found.identity,
        managerRef: route.ref,
        hints: [route.ref, typeof checkpoint === 'string' ? checkpoint : ''],
      });
    }
    const version =
      typeof body === 'object' &&
      body !== null &&
      typeof (body as Record<string, unknown>)['version'] === 'string'
        ? ` ${String((body as Record<string, unknown>)['version'])}`
        : '';
    const loaded =
      models.length === 0
        ? 'no image model loaded'
        : `${String(models.length)} image model${models.length === 1 ? '' : 's'} loaded`;
    return {
      found: true,
      url,
      detail: `Lemonade${version}, ${loaded}${missed.length === 0 ? '' : ` (not answering yet: ${missed.join(', ')})`}`,
      models,
    };
  },
};

/** The kinds a daemon offers. */
export function createBackendKinds(options: { readonly fetch?: FetchLike } = {}): BackendKinds {
  const definitions = [SDCPP_DEFINITION, LEMONADE_DEFINITION];
  const byKind = new Map(definitions.map((definition) => [definition.kind, definition]));
  const shared: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    fetch: shared,
    list: () => definitions,
    get: (kind) => byKind.get(kind),
    adapter(kind, build = {}) {
      if (kind !== SDCPP_KIND) throw new Error(`${kind} is not an adapter kind.`);
      return new SdcppAdapter({
        fetch: build.fetch ?? shared,
        ...(build.capabilities === undefined ? {} : { capabilities: build.capabilities }),
      });
    },
    manager(kind, build = {}) {
      if (kind !== LEMONADE_DEFINITION.kind) throw new Error(`${kind} is not a manager kind.`);
      return new LemonadeManager({ fetch: build.fetch ?? shared });
    },
  };
}

/** A kind as `GET /backend-kinds` answers it. */
export function kindInfo(definition: BackendKindDefinition): BackendKindInfo {
  return {
    kind: definition.kind,
    role: definition.role,
    name: definition.name,
    description: definition.description,
    ...(definition.adapterKind === undefined ? {} : { adapter_kind: definition.adapterKind }),
    settings_schema: { ...definition.settingsSchema },
    secrets_schema: { ...definition.secretsSchema },
    default_urls: [...definition.defaultUrls],
  };
}
