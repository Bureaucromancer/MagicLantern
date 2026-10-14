// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as api from '@bureaucromancer/lantern-schema';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { DEFAULT_CONFIG } from '../config/schema.js';
import type { AppServices } from '../services.js';
import {
  generateOpenApiJson,
  OPENAPI_API_VERSION,
  OPENAPI_TAGS,
  openApiStubConfig,
  openApiStubServices,
  registerOpenApi,
  registerOpenApiRoute,
  renderOpenApiDocument,
} from './openapi.js';
import type { LanternApp } from './types.js';

/** Every route contract lantern-schema exports, found by shape so a new one cannot be missed. */
const contracts = Object.values(api as Record<string, unknown>).filter(
  (value): value is api.RouteContract =>
    typeof value === 'object' && value !== null && 'method' in value && 'schema' in value,
);

const visibleContracts = contracts.filter((route) => route.schema.hide !== true);

function bareApp(): LanternApp {
  return Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
}

/** Registers each contract at its full path with a handler that is never called. */
function registerContracts(app: LanternApp, routes: readonly api.RouteContract[]): void {
  for (const route of routes) {
    app.route({
      method: route.method,
      url: route.path,
      schema: route.schema,
      handler: () => {
        throw new Error('not called');
      },
    });
  }
}

/** The spec of a bare app documenting `routes`, as the parsed object. */
async function specOf(routes: readonly api.RouteContract[]): Promise<Record<string, any>> {
  const app = bareApp();
  await registerOpenApi(app);
  registerContracts(app, routes);
  await app.ready();
  const spec = app.swagger() as Record<string, any>;
  await app.close();
  return spec;
}

/** Every key used anywhere under `value`, for "this keyword never appears" checks. */
function keysIn(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysIn(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      keysIn(child, into);
    }
  }
  return into;
}

describe('registerOpenApi', () => {
  it('documents OpenAPI 3.1 with a constant version and no servers', async () => {
    const spec = await specOf(contracts);

    expect(spec['openapi']).toBe('3.1.0');
    expect(spec['info'].version).toBe(OPENAPI_API_VERSION);
    expect(spec['info'].title).toBe('Magic Lantern');
    // A `servers` entry would carry the configured host and port into the
    // committed file, which then differs per machine.
    expect(spec).not.toHaveProperty('servers');
  });

  it('passes TypeBox output through as JSON Schema 2020-12', async () => {
    const spec = await specOf(contracts);

    expect(
      spec['paths']['/healthz'].get.responses['200'].content['application/json'].schema.properties
        .status,
    ).toMatchObject({ const: 'ok', type: 'string' });
    // 3.0-style rewrites, which 3.1 with convertConstToEnum off never needs.
    const keys = keysIn(spec);
    expect(keys.has('enum')).toBe(false);
    expect(keys.has('nullable')).toBe(false);
  });

  it('documents every visible route contract, with its responses described', async () => {
    const spec = await specOf(contracts);

    for (const route of visibleContracts) {
      const operation = spec['paths'][route.path]?.[route.method.toLowerCase()];
      expect(operation, `${route.method} ${route.path}`).toBeDefined();
      expect(operation.operationId).toBe(route.schema.operationId);
      for (const [status, response] of Object.entries(operation.responses as object)) {
        expect(response.description, `${route.path} ${status}`).not.toBe('Default Response');
      }
    }
  });

  it('documents a 204 as a response with no content', async () => {
    const spec = await specOf([api.LoginRoute, api.LogoutRoute]);
    const session = spec['paths'][api.LoginRoute.path];

    expect(session.post.responses['204']).toEqual({
      description: 'Signed in; the session cookie is set.',
    });
    expect(session.delete.responses['204']).not.toHaveProperty('content');
  });

  it('documents a request body as closed, so unknown fields read as refused', async () => {
    const spec = await specOf([api.LoginRoute]);
    const body = spec['paths'][api.LoginRoute.path].post.requestBody;

    expect(body.required).toBe(true);
    expect(body.content['application/json'].schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['password'],
    });
  });

  it('leaves hidden routes out', async () => {
    const spec = await specOf(contracts);

    expect(spec['paths']).not.toHaveProperty(api.GetOpenApiRoute.path);
  });

  it('documents the session cookie as optional, since whether it is needed is install config', async () => {
    const spec = await specOf([]);

    expect(spec['components'].securitySchemes.session).toMatchObject({
      type: 'apiKey',
      in: 'cookie',
      name: 'lantern_session',
    });
    expect(spec['security']).toEqual([{ session: [] }, {}]);
  });

  it('declares every tag a route contract uses', () => {
    const declared = new Set<string>(OPENAPI_TAGS.map((tag) => tag.name));
    for (const route of visibleContracts) {
      for (const tag of route.schema.tags ?? []) {
        expect(declared.has(tag), `${route.path} uses the undeclared tag "${tag}"`).toBe(true);
      }
    }
  });

  it('names a shared schema by its $id rather than a counter', async () => {
    const app = bareApp();
    await registerOpenApi(app);
    app.addSchema({ $id: 'Thing', type: 'object', properties: { a: { type: 'string' } } });
    app.get(
      '/thing',
      {
        schema: {
          tags: ['test'],
          response: { 200: { $ref: 'Thing#', description: 'A thing.' } },
        },
      },
      () => ({ a: 'b' }),
    );
    await app.ready();
    const spec = app.swagger() as Record<string, any>;
    await app.close();

    expect(Object.keys(spec['components'].schemas)).toEqual(['Thing']);
    expect(spec['paths']['/thing'].get.responses['200'].content['application/json'].schema).toEqual(
      { $ref: '#/components/schemas/Thing' },
    );
  });
});

describe('registerOpenApiRoute', () => {
  async function appServingTheSpec(): Promise<LanternApp> {
    const app = bareApp();
    await registerOpenApi(app);
    registerContracts(app, visibleContracts);
    await app.register(
      (child, _options, done) => {
        registerOpenApiRoute(child);
        done();
      },
      { prefix: api.API_V1_PREFIX },
    );
    return app;
  }

  it('serves the spec as JSON at /api/v1/openapi.json', async () => {
    const app = await appServingTheSpec();
    const response = await app.inject({ method: 'GET', url: api.GetOpenApiRoute.path });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json()).toEqual(JSON.parse(JSON.stringify(app.swagger())));
    await app.close();
  });

  it('is not in the spec it serves', async () => {
    const app = await appServingTheSpec();
    const spec = (await app.inject({ method: 'GET', url: api.GetOpenApiRoute.path })).json();

    expect(Object.keys(spec.paths)).not.toContain(api.GetOpenApiRoute.path);
    expect(Object.keys(spec.paths)).toContain(api.GetSessionRoute.path);
    await app.close();
  });
});

describe('renderOpenApiDocument', () => {
  async function renderedWith(routes: readonly api.RouteContract[]): Promise<string> {
    const app = bareApp();
    await registerOpenApi(app);
    registerContracts(app, routes);
    await app.ready();
    const text = renderOpenApiDocument(app.swagger());
    await app.close();
    return text;
  }

  it('does not depend on the order routes were registered in', async () => {
    const forwards = await renderedWith(visibleContracts);
    const backwards = await renderedWith([...visibleContracts].reverse());

    expect(backwards).toBe(forwards);
  });

  it('sorts paths, and lists each path’s operations in the spec’s method order', async () => {
    const spec = JSON.parse(
      await renderedWith([
        api.LogoutRoute,
        api.LoginRoute,
        api.GetHealthRoute,
        api.GetSessionRoute,
      ]),
    );

    expect(Object.keys(spec.paths)).toEqual([api.GetSessionRoute.path, api.GetHealthRoute.path]);
    expect(Object.keys(spec.paths[api.GetSessionRoute.path])).toEqual(['get', 'post', 'delete']);
  });

  it('writes two-space JSON with a final newline', () => {
    const text = renderOpenApiDocument({ openapi: '3.1.0', paths: { '/b': {}, '/a': {} } });

    expect(text).toBe(
      '{\n  "openapi": "3.1.0",\n  "paths": {\n    "/a": {},\n    "/b": {}\n  }\n}\n',
    );
  });

  it('keeps non-operation path fields ahead of the operations', () => {
    const text = renderOpenApiDocument({
      paths: { '/x': { post: {}, parameters: [], get: {}, summary: 's' } },
    });

    expect(Object.keys(JSON.parse(text).paths['/x'])).toEqual([
      'parameters',
      'summary',
      'get',
      'post',
    ]);
  });

  it('refuses something that is not a document', () => {
    expect(() => renderOpenApiDocument('openapi: 3.1.0')).toThrow(TypeError);
    expect(() => renderOpenApiDocument(null)).toThrow(TypeError);
  });
});

describe('the stubs the emitter builds the app with', () => {
  it('throw on every service, naming it', () => {
    const services = openApiStubServices();

    expect(() => services.version).toThrow(/services\.version/);
    expect(() => services.processId).toThrow(/services\.processId/);
    expect(() => services.auth).toThrow(/services\.auth/);
    expect(() => services.libraries).toThrow(/services\.libraries/);
  });

  it('have no data directory, and otherwise the default config', () => {
    const config = openApiStubConfig();

    expect(() => config.dataDir).toThrow(/config\.dataDir/);
    expect(config.host).toBe(DEFAULT_CONFIG.host);
    expect(config.port).toBe(DEFAULT_CONFIG.port);
    expect(config.appRoot).toBeNull();
    expect(config.auth).toEqual(DEFAULT_CONFIG.auth);
  });

  it('are fresh each time, so nothing can leak between builds', () => {
    const config = openApiStubConfig();
    config.allowedHosts.push('example.test');

    expect(openApiStubConfig().allowedHosts).toEqual([]);
  });
});

describe('generateOpenApiJson on the real app', () => {
  it('builds it without touching services or a data directory', async () => {
    const text = await generateOpenApiJson(buildApp);
    const spec = JSON.parse(text);

    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.version).toBe(OPENAPI_API_VERSION);
    expect(spec).not.toHaveProperty('servers');
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('produces the same bytes every time', async () => {
    expect(await generateOpenApiJson(buildApp)).toBe(await generateOpenApiJson(buildApp));
  });

  it('documents exactly the visible route contracts', async () => {
    const spec = JSON.parse(await generateOpenApiJson(buildApp));
    const documented = Object.entries(spec.paths as Record<string, object>).flatMap(
      ([path, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
    );

    expect(documented.sort()).toEqual(
      visibleContracts.map((route) => `${route.method} ${route.path}`).sort(),
    );
  });

  it('is unchanged when the daemon also serves the app', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lantern-openapi-')));
    try {
      await writeFile(join(root, 'index.html'), '<!doctype html><title>Lantern</title>');
      const app = await buildApp(openApiStubServices(), {
        config: openApiStubConfig(),
        listenPort: DEFAULT_CONFIG.port,
        appRoot: { kind: 'served', root, detected: false },
      });
      await app.ready();
      const served = renderOpenApiDocument(app.swagger());
      await app.close();

      expect(served).toBe(await generateOpenApiJson(buildApp));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('GET /api/v1/openapi.json on the real app', () => {
  /** Services for answering requests: an auth mode, no sessions, no libraries. */
  function servicesIn(mode: 'none' | 'password'): AppServices {
    return {
      version: '0.0.0-test',
      processId: 'proc_test',
      auth: {
        mode: () => mode,
        verifyPassword: () => Promise.resolve(false),
        issueSession: () => {
          throw new Error('not used');
        },
        readSession: () => null,
        cookie: { name: 'lantern_session', secure: false, maxAgeSeconds: 60 },
      },
      libraries: { list: () => [], get: () => undefined, close: () => undefined },
    };
  }

  async function get(mode: 'none' | 'password') {
    const app = await buildApp(servicesIn(mode), {
      config: openApiStubConfig(),
      listenPort: DEFAULT_CONFIG.port,
      appRoot: { kind: 'api-only', looked: '' },
    });
    const response = await app.inject({ method: 'GET', url: api.GetOpenApiRoute.path });
    await app.close();
    return response;
  }

  it('serves the committed document', async () => {
    const response = await get('none');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(JSON.parse(await generateOpenApiJson(buildApp)));
  });

  it('requires a session in password mode', async () => {
    const response = await get('password');

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: api.ErrorCodes.unauthenticated });
  });
});
