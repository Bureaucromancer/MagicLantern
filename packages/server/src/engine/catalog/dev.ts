// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The development catalog, served with `LANTERN_DEV=1` (D6): one SDXL model on
 * one route of the mock backend kind (adapters/mock), so jobs run end to end
 * before any real backend exists. Phase 5 replaces the catalog with the
 * install database; until then this is the only model a development daemon
 * knows. A normal start has no models.
 */

import {
  isMockProfile,
  MOCK_MODEL_IDENTITY,
  MOCK_PROFILES,
  MOCK_ROUTE_ID,
  MockAdapter,
  mockRouteDescriptor,
  type MockOptions,
  type MockProfile,
  type MockSettings,
} from '../../adapters/mock/index.js';
import type { RouteBinding } from '../jobs/bindings.js';
import type { ProfileRegistry } from '../profiles/index.js';
import { type CatalogModel, InMemoryModelCatalog } from './catalog.js';

/** Whether the environment asks for development mode. */
export function isDevMode(env: Readonly<Record<string, string | undefined>>): boolean {
  return env['LANTERN_DEV'] === '1';
}

export const DEV_MODEL_ID = 'mdl_dev_sdxl';
export const DEV_ROUTE_ID = MOCK_ROUTE_ID;
/** The mock backend's id, which is also its resource group. */
export const DEV_BACKEND_ID = 'be_dev_mock';

/** The mock route's `describe()` result. */
export const DEV_ROUTE_DESCRIPTOR = mockRouteDescriptor(DEV_ROUTE_ID);

export const DEV_BASE_URL = 'mock://dev';

/** The development model, its route described as the mock profile describes it. */
export function devModel(profile: MockProfile = 'basic'): CatalogModel {
  return {
    id: DEV_MODEL_ID,
    family: 'sdxl',
    routes: [
      {
        id: DEV_ROUTE_ID,
        backend_kind: 'mock',
        priority: 0,
        health: { status: 'ok', load_state: profile === 'orchd' ? 'cold' : 'loaded' },
        describe: mockRouteDescriptor(DEV_ROUTE_ID, profile),
        fingerprint: MOCK_MODEL_IDENTITY,
      },
    ],
  };
}

/** The development model under the default profile. */
export const DEV_MODEL: CatalogModel = devModel();

/**
 * The mock profile a development daemon runs (`LANTERN_DEV_MOCK_PROFILE`),
 * `basic` by default.
 *
 * @throws Error naming the profiles for an unknown one
 */
export function devMockProfile(env: Readonly<Record<string, string | undefined>>): MockProfile {
  const value = env['LANTERN_DEV_MOCK_PROFILE'];
  if (value === undefined || value === '') return 'basic';
  if (!isMockProfile(value)) {
    throw new Error(
      `LANTERN_DEV_MOCK_PROFILE is "${value}"; it must be one of ${MOCK_PROFILES.join(', ')}.`,
    );
  }
  return value;
}

/** The mock backend, initialised, and its route's binding. */
export async function devBackend(
  settings: MockSettings = {},
  options: MockOptions = {},
): Promise<{ adapter: MockAdapter; binding: RouteBinding }> {
  const adapter = new MockAdapter(options);
  await adapter.init({
    backendId: DEV_BACKEND_ID,
    baseUrl: DEV_BASE_URL,
    settings: { ...settings },
  });
  return {
    adapter,
    binding: {
      routeId: DEV_ROUTE_ID,
      backendId: DEV_BACKEND_ID,
      backendKind: 'mock',
      baseUrl: DEV_BASE_URL,
      adapter,
      resourceGroup: DEV_BACKEND_ID,
      concurrency: 1,
    },
  };
}

/**
 * The catalog a daemon starts with: the development model under
 * `LANTERN_DEV=1`, else none.
 *
 * @param env the process environment
 * @param profiles the loaded profiles
 */
export function startupModelCatalog(
  env: Readonly<Record<string, string | undefined>>,
  profiles: ProfileRegistry,
): InMemoryModelCatalog {
  return new InMemoryModelCatalog(isDevMode(env) ? [devModel(devMockProfile(env))] : [], profiles);
}
