// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The OpenAPI spec, generated from the route schemas (rule 1, SK5).
 *
 * `registerOpenApi` registers @fastify/swagger and must be awaited before any
 * route is registered: the plugin collects routes through an `onRoute` hook,
 * so a route added earlier is silently missing from the spec.
 * `registerOpenApiRoute` adds the hidden `GET /api/v1/openapi.json` inside the
 * API plugin, behind the auth gate.
 *
 * The committed `packages/server/openapi.json` is drift-checked in CI, so the
 * document must be a function of the route code alone: a constant API version
 * (never package.json's, which changes every release), no `servers` (which
 * would depend on config and port), and paths in a canonical order.
 * {@link generateOpenApiJson} is the one place that produces it.
 */

import swagger, { type FastifyDynamicSwaggerOptions } from '@fastify/swagger';
import { GetOpenApiRoute } from '@bureaucromancer/lantern-schema';

import type { AppOptions } from '../app.js';
import { SESSION_COOKIE_NAME } from '../auth/session.js';
import { DEFAULT_CONFIG, type ResolvedConfig } from '../config/schema.js';
import type { AppServices } from '../services.js';
import type { LanternApp } from './types.js';

/** The API version the spec describes; bumps with the URL prefix, not the release. */
export const OPENAPI_API_VERSION = 'v1';

/** Declared so documentation tools can describe each group; every route tag must be listed. */
export const OPENAPI_TAGS = [
  { name: 'health', description: 'Liveness, outside `/api/v1` and public in every auth mode.' },
  { name: 'session', description: 'The auth mode, sign-in and sign-out.' },
  { name: 'info', description: 'What is answering.' },
  {
    name: 'libraries',
    description: 'Self-contained collections, each with its own database and assets.',
  },
] as const;

const SWAGGER_OPTIONS: FastifyDynamicSwaggerOptions = {
  openapi: {
    // 3.1 takes JSON Schema 2020-12 as it is, so TypeBox output (`const`,
    // `type: 'null'`) passes through unchanged; in 3.0 mode the plugin rewrites it.
    openapi: '3.1.0',
    info: {
      title: 'Magic Lantern',
      version: OPENAPI_API_VERSION,
      description:
        'The HTTP API of the Magic Lantern daemon. Errors use one envelope: ' +
        '`{ error, message, issues? }`, where `error` is a stable kebab-case code.\n\n' +
        'Beyond the answers each operation lists, any request can get 500 `internal` (the ' +
        "cause is only in the daemon's log), and an unknown API route, or a documented path " +
        'under a method it does not list, gets 404 `not-found` (never 405).',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    tags: OPENAPI_TAGS.map((tag) => ({ ...tag })),
    components: {
      securitySchemes: {
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: SESSION_COOKIE_NAME,
          description:
            'Set by `POST /api/v1/session`. In auth mode `password` every `/api/v1` route ' +
            'except `/api/v1/session` requires it; in mode `none` nothing does.',
        },
      },
    },
    // Optional (the empty requirement) because the mode is install config, not API shape.
    security: [{ session: [] }, {}],
  },
  // Defaults to true, which would undo what choosing 3.1 is for.
  convertConstToEnum: false,
  refResolver: {
    // Shared schemas keep their own `$id` as the component name rather than `def-N`,
    // which would renumber whenever one is added.
    buildLocalReference: (json, _baseUri, _fragment, i) =>
      typeof json['$id'] === 'string' ? json['$id'] : `def-${String(i)}`,
  },
};

export async function registerOpenApi(app: LanternApp): Promise<void> {
  await app.register(swagger, SWAGGER_OPTIONS);
}

/** `GET /api/v1/openapi.json`; register inside the API plugin so the auth gate covers it. */
export function registerOpenApiRoute(api: LanternApp): void {
  api.route({
    method: GetOpenApiRoute.method,
    url: GetOpenApiRoute.url,
    schema: GetOpenApiRoute.schema,
    // The plugin caches the document after the first call.
    handler: (request) => Promise.resolve(request.server.swagger()),
  });
}

// ---------------------------------------------------------------------------
// The committed spec
// ---------------------------------------------------------------------------

/** HTTP methods in the order the OpenAPI spec lists a path item's fixed fields. */
const METHOD_ORDER = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Paths sorted, and each path's operations in spec order, so the file does not
 * churn when route registration is reordered without the API changing.
 */
function canonicalPaths(paths: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const path of Object.keys(paths).sort()) {
    const item = paths[path];
    if (!isRecord(item)) {
      sorted[path] = item;
      continue;
    }
    // Non-operation fields (summary, parameters) rank -1, so they come first in
    // their own order: Array#sort is stable.
    const keys = Object.keys(item).sort(
      (a, b) => METHOD_ORDER.indexOf(a) - METHOD_ORDER.indexOf(b),
    );
    sorted[path] = Object.fromEntries(keys.map((key) => [key, item[key]]));
  }
  return sorted;
}

/** The spec as committed: canonical path order, two-space JSON and a final newline. */
export function renderOpenApiDocument(document: unknown): string {
  if (!isRecord(document)) throw new TypeError('An OpenAPI document is a JSON object.');
  const paths = document['paths'];
  const canonical = isRecord(paths) ? { ...document, paths: canonicalPaths(paths) } : document;
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

function unavailable(what: string): never {
  throw new Error(
    `${what} was read while building the app for its OpenAPI spec. Route registration ` +
      'must not touch services or the data directory; only handlers may.',
  );
}

/**
 * Services for an app that is built only to read its spec. Every member throws,
 * which is what holds route registration to "handlers only": a module that
 * reads a service while registering fails the emitter loudly.
 */
export function openApiStubServices(): AppServices {
  return {
    get version(): string {
      return unavailable('services.version');
    },
    get processId(): string {
      return unavailable('services.processId');
    },
    get auth(): AppServices['auth'] {
      return unavailable('services.auth');
    },
    get libraries(): AppServices['libraries'] {
      return unavailable('services.libraries');
    },
  };
}

/** The default config with no data directory: reading `dataDir` throws. */
export function openApiStubConfig(): ResolvedConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    get dataDir(): string {
      return unavailable('config.dataDir');
    },
    provenance: {
      path: '',
      fileFound: false,
      unknownKeys: [],
      envOverrodeFile: [],
      envApplied: [],
      dataDirDefaulted: false,
    },
  };
}

/** `buildApp`, passed in rather than imported so this module and app.ts do not import each other. */
export type AppBuilder = (services: AppServices, options: AppOptions) => Promise<LanternApp>;

/**
 * Builds the app with stub services and no data directory, without listening,
 * and renders its spec. Used by `scripts/emit-openapi.ts` (on the built JS)
 * and by the tests (on the source).
 *
 * API only: whether the app package happens to be built must not reach the
 * committed file (static routes are hidden from the spec anyway; this keeps
 * the emitter off the disk as well).
 */
export async function generateOpenApiJson(build: AppBuilder): Promise<string> {
  const app = await build(openApiStubServices(), {
    config: openApiStubConfig(),
    listenPort: DEFAULT_CONFIG.port,
    appRoot: { kind: 'api-only', looked: '' },
  });
  try {
    await app.ready();
    return renderOpenApiDocument(app.swagger());
  } finally {
    await app.close();
  }
}
