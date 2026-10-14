// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { API_V1_PREFIX, LibraryListResponse } from '@bureaucromancer/lantern-schema';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Value } from '@sinclair/typebox/value';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { LanternApp } from '../http/types.js';
import type { AppServices, AuthService } from '../services.js';
import type { LibraryRecord, LibraryRegistry } from '../store/index.js';
import { registerLibrariesRoutes, toLibrarySummary } from './libraries.js';

const OK: LibraryRecord = {
  id: 'lib_01JA0000000000000000000000',
  name: 'Library',
  path: 'libraries/lib_01JA0000000000000000000000',
  status: 'ok',
  schemaVersion: 1,
};
const READ_ONLY: LibraryRecord = {
  id: 'lib_01JB0000000000000000000000',
  name: 'From the future',
  path: 'libraries/lib_01JB0000000000000000000000',
  status: 'read-only',
  reason: 'It was written by a newer Lantern.',
  schemaVersion: 4,
};
const UNAVAILABLE: LibraryRecord = {
  id: 'lib_01JC0000000000000000000000',
  name: 'Unplugged',
  path: 'libraries/lib_01JC0000000000000000000000',
  status: 'unavailable',
  reason: 'Its database was not found.',
  schemaVersion: null,
};

/** Only the registry is used here; anything else touched is a test failure. */
const unusedAuth = new Proxy({} as AuthService, {
  get: (_target, key) => {
    throw new Error(`The libraries route touched auth.${String(key)}.`);
  },
});

function registryOf(records: () => LibraryRecord[]): LibraryRegistry {
  return {
    list: records,
    get: (id) => records().find((record) => record.id === id),
    close: () => undefined,
  };
}

const apps: LanternApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

/** The route alone, mounted under the API prefix the way app.ts mounts it. */
async function appWith(records: () => LibraryRecord[]): Promise<LanternApp> {
  const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  apps.push(app);
  const services: AppServices = {
    version: '0.0.0-test',
    processId: 'proc_test',
    auth: unusedAuth,
    libraries: registryOf(records),
  };
  app.decorate('services', services);
  await app.register(
    (api, _options, done) => {
      registerLibrariesRoutes(api);
      done();
    },
    { prefix: API_V1_PREFIX },
  );
  await app.ready();
  return app;
}

describe('GET /api/v1/libraries', () => {
  it('lists every library as a summary, with reasons only where there are any', async () => {
    const app = await appWith(() => [OK, READ_ONLY, UNAVAILABLE]);
    const response = await app.inject({ method: 'GET', url: `${API_V1_PREFIX}/libraries` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    const body: unknown = response.json();
    expect(body).toEqual({
      libraries: [
        { id: OK.id, name: 'Library', status: 'ok' },
        {
          id: READ_ONLY.id,
          name: 'From the future',
          status: 'read-only',
          reason: 'It was written by a newer Lantern.',
        },
        {
          id: UNAVAILABLE.id,
          name: 'Unplugged',
          status: 'unavailable',
          reason: 'Its database was not found.',
        },
      ],
    });
    expect(Value.Check(LibraryListResponse, body)).toBe(true);
  });

  it('never sends the folder path or schema version', async () => {
    const app = await appWith(() => [OK]);
    const response = await app.inject({ method: 'GET', url: `${API_V1_PREFIX}/libraries` });
    expect(response.body).not.toContain('libraries/');
    expect(response.body).not.toContain('schemaVersion');
  });

  it('reads the registry per request, not at registration', async () => {
    let records: LibraryRecord[] = [];
    const app = await appWith(() => records);
    expect((await app.inject({ method: 'GET', url: `${API_V1_PREFIX}/libraries` })).json()).toEqual(
      { libraries: [] },
    );
    records = [OK];
    expect((await app.inject({ method: 'GET', url: `${API_V1_PREFIX}/libraries` })).json()).toEqual(
      { libraries: [{ id: OK.id, name: 'Library', status: 'ok' }] },
    );
  });
});

describe('toLibrarySummary', () => {
  it('copies only the wire fields', () => {
    expect(toLibrarySummary(READ_ONLY)).toEqual({
      id: READ_ONLY.id,
      name: READ_ONLY.name,
      status: 'read-only',
      reason: READ_ONLY.reason,
    });
    expect(Object.keys(toLibrarySummary(OK))).toEqual(['id', 'name', 'status']);
  });
});
