// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The `lemonade` manager kind (SD6, L1): discovers the sd-server children
 * Lemonade runs, one per loaded image model, from `GET /api/v1/health`.
 *
 * - **What it reports.** Each loaded model whose recipe is `sd-cpp` becomes a
 *   route keyed by Lemonade's model name, served by the sd.cpp adapter at the
 *   child's base URL and nothing else, so orchd's kind can take the same
 *   shape. Lemonade reports a child's address as `http://127.0.0.1:<port>/v1`
 *   (the OpenAI-style root); the native API is at the port's root, so the
 *   `/v1` is dropped.
 * - **Load and unload.** A model that unloads drops out of the report; the
 *   registry retires its route (L2: Lemonade retires, orchd keeps it cold),
 *   and the same model loaded again, on any port, takes its route back.
 *   Lemonade hands each child the first free port from 8001, so a port can
 *   answer for another model after a reload: the engine's identity check
 *   catches that (A26).
 * - **Liveness** comes from Lemonade, never from the child: a child Lemonade
 *   reports as loading, evicting or exited is not up.
 * - **Reach.** Lemonade binds its children to 127.0.0.1 on its own machine,
 *   so they work only from there (D5): Lantern runs on the Lemonade host.
 * - **Nothing here loads a model** (L3): Lemonade's health route reports, it
 *   never loads, and Lantern never calls Lemonade's load or unload.
 */

import { errorText, joinUrl, request, type FetchLike } from '../../adapters/shared/http.js';
import type {
  AdapterConfig,
  HealthReport,
  ManagedRoute,
  Manager,
  ManagerReport,
} from '../../adapters/shared/types.js';

/** The adapter kind that serves Lemonade's image children. */
export const LEMONADE_ADAPTER = 'sdcpp';

/** Lemonade's recipe for sd-server children. */
export const SDCPP_RECIPE = 'sd-cpp';

/** Where Lemonade reports what it has loaded. `/v1/health` answers too on newer releases. */
export const LEMONADE_HEALTH_PATH = '/api/v1/health';

/** Model states in which a child serves (Lemonade's `ModelState`). */
const SERVING: ReadonlySet<string> = new Set(['ready', 'in_use']);
/** States on the way out: the child is about to go. */
const LEAVING: ReadonlySet<string> = new Set(['downsizing', 'downsized', 'evicting', 'unloaded']);
/** `backend_health` values that mean the child process is gone. */
const DEAD: ReadonlySet<string> = new Set(['stopped', 'exited', 'watchdog_reset']);

export interface LemonadeSettings {
  /** How often to ask Lemonade what is loaded, in milliseconds. */
  readonly pollMs: number;
  /** Milliseconds before a health request is abandoned. */
  readonly timeoutMs: number;
}

export const LEMONADE_DEFAULT_SETTINGS: LemonadeSettings = { pollMs: 5000, timeoutMs: 10_000 };

export const LEMONADE_SETTINGS_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pollMs: {
      type: 'integer',
      minimum: 1000,
      maximum: 600_000,
      default: LEMONADE_DEFAULT_SETTINGS.pollMs,
      title: 'Poll interval (ms)',
      description: 'How often to ask Lemonade which image models are loaded.',
    },
    timeoutMs: {
      type: 'integer',
      minimum: 1000,
      maximum: 600_000,
      default: LEMONADE_DEFAULT_SETTINGS.timeoutMs,
      title: 'Request timeout (ms)',
    },
  },
};

export const LEMONADE_SECRETS_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    apiKey: {
      type: 'string',
      minLength: 1,
      title: 'API key',
      description: "Lemonade's `LEMONADE_API_KEY`, when it is set. Sent as a bearer token.",
    },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function interval(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1000 || value > 600_000) {
    throw new TypeError(`${name} must be an integer from 1000 to 600000.`);
  }
  return value;
}

/**
 * Settings with their defaults applied.
 *
 * @throws TypeError naming the first setting that is wrong
 */
export function readLemonadeSettings(settings: unknown): LemonadeSettings {
  if (!isRecord(settings)) throw new TypeError('The Lemonade settings must be an object.');
  for (const key of Object.keys(settings)) {
    if (!(key in LEMONADE_DEFAULT_SETTINGS)) {
      throw new TypeError(`Unknown Lemonade setting: ${key}.`);
    }
  }
  return {
    pollMs: interval(settings['pollMs'], 'pollMs', LEMONADE_DEFAULT_SETTINGS.pollMs),
    timeoutMs: interval(settings['timeoutMs'], 'timeoutMs', LEMONADE_DEFAULT_SETTINGS.timeoutMs),
  };
}

/**
 * The sd-server base URL behind a child's `backend_url`: its `/v1` dropped.
 * Null when it is not an http(s) URL.
 */
export function childBaseUrl(backendUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(backendUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${url.origin}${path}`;
}

/** A child's health, from what Lemonade says of it. */
function childHealth(entry: Record<string, unknown>): HealthReport {
  const state = typeof entry['status'] === 'string' ? entry['status'] : undefined;
  const process = typeof entry['backend_health'] === 'string' ? entry['backend_health'] : undefined;
  if (entry['backend_alive'] === false || (process !== undefined && DEAD.has(process))) {
    return {
      status: 'down',
      load_state: 'unknown',
      detail: `Lemonade reports the child ${process ?? 'dead'}.`,
    };
  }
  if (state === 'loading') {
    return { status: 'degraded', load_state: 'cold', detail: 'Lemonade is loading the model.' };
  }
  if (state !== undefined && LEAVING.has(state)) {
    return {
      status: 'down',
      load_state: 'cold',
      detail: `Lemonade is unloading the model (${state}).`,
    };
  }
  if (state !== undefined && !SERVING.has(state)) {
    return { status: 'degraded', load_state: 'unknown', detail: `Lemonade reports "${state}".` };
  }
  return { status: 'ok', load_state: 'loaded' };
}

/**
 * The image routes in a health document: each loaded `sd-cpp` model with a
 * usable address, in Lemonade's order.
 */
export function routesFromHealth(document: unknown): ManagedRoute[] {
  if (!isRecord(document)) return [];
  const loaded = document['all_models_loaded'];
  if (!Array.isArray(loaded)) return [];
  const routes: ManagedRoute[] = [];
  const seen = new Set<string>();
  for (const entry of loaded) {
    if (!isRecord(entry) || entry['recipe'] !== SDCPP_RECIPE) continue;
    const name = entry['model_name'];
    const backendUrl = entry['backend_url'];
    if (typeof name !== 'string' || name === '' || seen.has(name)) continue;
    if (typeof backendUrl !== 'string') continue;
    const base = childBaseUrl(backendUrl);
    if (base === null) continue;
    seen.add(name);
    const detail: Record<string, unknown> = {};
    for (const key of ['checkpoint', 'device', 'is_busy', 'pinned', 'status', 'pid']) {
      if (entry[key] !== undefined) detail[key] = entry[key];
    }
    routes.push({
      ref: name,
      adapter: LEMONADE_ADAPTER,
      base_url: base,
      health: childHealth(entry),
      detail,
    });
  }
  return routes;
}

export interface LemonadeManagerOptions {
  readonly fetch?: FetchLike;
}

export class LemonadeManager implements Manager {
  private config: AdapterConfig | null = null;
  private settings: LemonadeSettings = LEMONADE_DEFAULT_SETTINGS;
  private readonly fetchImpl: FetchLike;

  constructor(options: LemonadeManagerOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  init(config: AdapterConfig): Promise<void> {
    try {
      this.settings = readLemonadeSettings(config.settings);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.config = config;
    return Promise.resolve();
  }

  /** How often the registry should ask. */
  get pollMs(): number {
    return this.settings.pollMs;
  }

  async discover(signal?: AbortSignal): Promise<ManagerReport> {
    if (this.config === null) throw new Error('The Lemonade manager was used before init.');
    const url = joinUrl(this.config.baseUrl, LEMONADE_HEALTH_PATH);
    const apiKey = this.config.secrets?.['apiKey'];
    let answer;
    try {
      answer = await request(this.fetchImpl, url, {
        timeoutMs: this.settings.timeoutMs,
        ...(apiKey === undefined ? {} : { headers: { authorization: `Bearer ${apiKey}` } }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      return {
        health: {
          status: 'down',
          load_state: 'unknown',
          detail: error instanceof Error ? error.message : String(error),
        },
        routes: [],
      };
    }
    if (answer.status === 401 || answer.status === 403) {
      return {
        health: {
          status: 'down',
          load_state: 'unknown',
          detail: `Lemonade refused the request (${String(answer.status)}): check the API key.`,
        },
        routes: [],
      };
    }
    if (answer.status !== 200 || !isRecord(answer.body)) {
      const text = errorText(answer.body);
      return {
        health: {
          status: 'down',
          load_state: 'unknown',
          detail: `Lemonade answered ${String(answer.status)}${text === undefined ? '' : `: ${text}`}.`,
        },
        routes: [],
      };
    }
    const routes = routesFromHealth(answer.body);
    return {
      health: {
        status: 'ok',
        load_state: routes.some((route) => route.health.load_state === 'loaded')
          ? 'loaded'
          : 'cold',
        ...(typeof answer.body['version'] === 'string'
          ? { detail: `Lemonade ${answer.body['version']}` }
          : {}),
      },
      routes,
    };
  }
}

/** Whether a health document is Lemonade's (for autodetect, L9). */
export function isLemonadeHealth(document: unknown): boolean {
  return (
    isRecord(document) &&
    document['status'] === 'ok' &&
    (Array.isArray(document['all_models_loaded']) || 'model_loaded' in document)
  );
}
