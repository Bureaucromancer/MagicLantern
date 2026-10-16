// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { Kind, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import * as api from './index.js';
import type { RouteContract } from './route.js';

/** Every route contract the module exports, found by shape so a new one cannot be missed. */
const routes = Object.entries(api as Record<string, unknown>).filter(
  (entry): entry is [string, RouteContract] => {
    const value = entry[1];
    return typeof value === 'object' && value !== null && 'method' in value && 'schema' in value;
  },
);

describe('the route contracts', () => {
  it('are all found', () => {
    expect(routes.map(([name]) => name).sort()).toEqual([
      'CancelJobRoute',
      'CreateLibraryRoute',
      'DeleteAssetRoute',
      'EventsRoute',
      'GetAssetRoute',
      'GetHealthRoute',
      'GetInfoRoute',
      'GetJobRoute',
      'GetLineageRoute',
      'GetOpenApiRoute',
      'GetProvenanceRoute',
      'GetQueueRoute',
      'GetSessionRoute',
      'GetThumbnailRoute',
      'ListAssetsRoute',
      'ListJobsRoute',
      'ListLibrariesRoute',
      'LoginRoute',
      'LogoutRoute',
      'PatchAssetRoute',
      'RenameLibraryRoute',
      'ReproduceJobRoute',
      'RerollJobRoute',
      'ResolveRoute',
      'SubmitJobRoute',
      'UploadAssetRoute',
    ]);
  });

  it('mount API routes under /api/v1 and health at the root', () => {
    for (const [name, route] of routes) {
      if (name === 'GetHealthRoute') {
        expect(route.path).toBe('/healthz');
        expect(route.url).toBe(route.path);
      } else {
        // The path names parameters as OpenAPI does (`{lib}`), the url as Fastify does (`:lib`).
        const url = route.url.replaceAll(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
        expect(route.path, name).toBe(`${api.API_V1_PREFIX}${url}`);
      }
    }
  });

  it('close every request body, so unknown fields are refused rather than dropped (rule 5)', () => {
    for (const [name, route] of routes) {
      const body = route.schema.body;
      if (body === undefined) continue;
      expect(body['additionalProperties'], name).toBe(false);
    }
  });

  it('describe every response, so the OpenAPI spec never says "Default Response"', () => {
    for (const [name, route] of routes) {
      for (const [status, schema] of Object.entries(route.schema.response ?? {})) {
        expect(schema.description, `${name} ${status}`).toEqual(expect.any(String));
      }
    }
  });

  it('give every visible route an operation id, a summary and a tag', () => {
    for (const [name, route] of routes) {
      if (route.schema.hide === true) continue;
      expect(route.schema.operationId, name).toEqual(expect.any(String));
      expect(route.schema.summary, name).toEqual(expect.any(String));
      expect(route.schema.tags?.length, name).toBeGreaterThan(0);
    }
  });

  it('use unique operation ids', () => {
    const ids = routes.flatMap(([, route]) => route.schema.operationId ?? []);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('give a bodiless sign-out no body schema, since Fastify would validate the absent body', () => {
    expect(api.LogoutRoute.schema).not.toHaveProperty('body');
  });

  it('list the 403 of the Host and Origin checks, which every request passes through', () => {
    for (const [name, route] of routes) {
      if (route.schema.hide === true) continue;
      expect(Object.keys(route.schema.response ?? {}), name).toContain('403');
      expect(route.schema.response?.[403], name).toBe(api.ForbiddenHostOrOrigin);
    }
  });

  it('list the body refusals on every state-changing route, which parses a body even unasked', () => {
    const safe = new Set<string>(['GET', 'HEAD', 'OPTIONS']);
    const changing = routes.filter(([, route]) => !safe.has(route.method));
    expect(changing.map(([name]) => name).sort()).toEqual([
      'CancelJobRoute',
      'CreateLibraryRoute',
      'DeleteAssetRoute',
      'LoginRoute',
      'LogoutRoute',
      'PatchAssetRoute',
      'RenameLibraryRoute',
      'ReproduceJobRoute',
      'RerollJobRoute',
      'ResolveRoute',
      'SubmitJobRoute',
      'UploadAssetRoute',
    ]);

    for (const [name, route] of changing) {
      const statuses = Object.keys(route.schema.response ?? {});
      // Unreadable or empty JSON, over the size limit, not JSON at all.
      expect(statuses, name).toEqual(expect.arrayContaining(['400', '413', '415']));
      // Only a body or path schema can fail validation.
      if (route.schema.body === undefined && route.schema.params === undefined) {
        expect(statuses, name).not.toContain('422');
      } else {
        expect(statuses, name).toContain('422');
      }
    }
  });
});

describe('LoginBody', () => {
  it('accepts a password, including an empty one', () => {
    expect(Value.Check(api.LoginBody, { password: 'hunter2' })).toBe(true);
    expect(Value.Check(api.LoginBody, { password: '' })).toBe(true);
  });

  it('refuses an unknown field', () => {
    expect(Value.Check(api.LoginBody, { password: 'x', remember: true })).toBe(false);
  });

  it('refuses a missing or non-string password', () => {
    expect(Value.Check(api.LoginBody, {})).toBe(false);
    expect(Value.Check(api.LoginBody, { password: 42 })).toBe(false);
  });

  it('caps the length scrypt is asked to hash', () => {
    expect(Value.Check(api.LoginBody, { password: 'x'.repeat(512) })).toBe(true);
    expect(Value.Check(api.LoginBody, { password: 'x'.repeat(513) })).toBe(false);
  });
});

describe('library ids', () => {
  const valid = 'lib_01JA2B3C4D5E6F7G8H9JKMNPQR';

  it('accept lib_ and a ULID', () => {
    expect(valid).toHaveLength(30);
    expect(Value.Check(api.LibraryId, valid)).toBe(true);
    expect(new RegExp(api.LIBRARY_ID_PATTERN).test(valid)).toBe(true);
  });

  it.each([
    ['lowercase', 'lib_01ja2b3c4d5e6f7g8h9jkmnpqr'],
    ['a letter Crockford excludes', 'lib_01JA2B3C4D5E6F7G8H9JKMNPQU'],
    ['too short', 'lib_01JA2B3C4D5E6F7G8H9JKMNPQ'],
    ['too long', 'lib_01JA2B3C4D5E6F7G8H9JKMNPQRS'],
    ['another prefix', 'job_01JA2B3C4D5E6F7G8H9JKMNPQR'],
    ['a path', 'lib_../../../../etc/passwd/xx'],
  ])('refuse %s', (_label, id) => {
    expect(Value.Check(api.LibraryId, id)).toBe(false);
  });
});

describe('response schemas', () => {
  it('accept the shapes the daemon sends', () => {
    expect(Value.Check(api.HealthResponse, { status: 'ok' })).toBe(true);
    expect(Value.Check(api.SessionResponse, { mode: 'password', authenticated: false })).toBe(true);
    expect(
      Value.Check(api.InfoResponse, { name: 'lantern', version: '0.1.0', apiVersion: 'v1' }),
    ).toBe(true);
    expect(
      Value.Check(api.LibraryListResponse, {
        libraries: [
          { id: 'lib_01JA2B3C4D5E6F7G8H9JKMNPQR', name: 'Library', status: 'ok' },
          {
            id: 'lib_01JA2B3C4D5E6F7G8H9JKMNPQS',
            name: 'Archive',
            status: 'unavailable',
            reason: 'Written by a newer Lantern.',
          },
        ],
      }),
    ).toBe(true);
  });

  it('leave responses open, so a newer daemon may add fields', () => {
    const schemas: TSchema[] = [
      api.HealthResponse,
      api.SessionResponse,
      api.InfoResponse,
      api.LibrarySummary,
      api.LibraryListResponse,
      api.ErrorBody,
    ];
    for (const schema of schemas) {
      expect(schema[Kind]).toBe('Object');
      expect(schema['additionalProperties']).toBeUndefined();
    }
  });

  it('describe the error envelope with kebab-case codes', () => {
    const pattern = new RegExp(api.ERROR_CODE_PATTERN);
    for (const code of Object.values(api.ErrorCodes)) {
      expect(pattern.test(code), code).toBe(true);
    }
    expect(Value.Check(api.ErrorBody, { error: 'invalid', message: 'Bad', issues: [] })).toBe(true);
    expect(Value.Check(api.ErrorBody, { error: 'Not Kebab', message: 'Bad' })).toBe(false);
  });

  it('promise no 405: Fastify answers a known path under another method with 404 `not-found`', () => {
    expect(Object.values(api.ErrorCodes)).not.toContain('method-not-allowed');
    expect(api.ErrorCodes).not.toHaveProperty('methodNotAllowed');
  });
});

describe('fillPath', () => {
  it('fills each parameter as one encoded segment', () => {
    expect(api.fillPath(api.ResolveRoute.path, { lib: 'lib_01JA0000000000000000000000' })).toBe(
      '/api/v1/libraries/lib_01JA0000000000000000000000/resolve',
    );
    expect(api.fillPath('/a/{x}/b', { x: '../c d/e' })).toBe('/a/..%2Fc%20d%2Fe/b');
  });

  it('refuses a missing parameter', () => {
    expect(() => api.fillPath(api.ResolveRoute.path, {})).toThrow(/`lib`/);
  });
});

describe('ResolveBody', () => {
  const request = {
    schema_version: 1,
    mode: 'txt2img',
    prompt: { positive: 'x' },
    sampling: { seed: 'random' },
  };

  it('takes a request and a model, and optionally a route', () => {
    expect(Value.Check(api.ResolveBody, { request, model: 'mdl_a' })).toBe(true);
    expect(Value.Check(api.ResolveBody, { request, model: 'mdl_a', route: 'rt_a' })).toBe(true);
  });

  it('refuses unknown fields, and ids with spaces or slashes', () => {
    expect(Value.Check(api.ResolveBody, { request, model: 'mdl_a', preset: {} })).toBe(false);
    expect(Value.Check(api.ResolveBody, { request, model: 'a b' })).toBe(false);
    expect(Value.Check(api.ResolveBody, { request, model: 'a/b' })).toBe(false);
  });
});
