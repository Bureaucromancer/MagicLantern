// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The development catalog, served with `LANTERN_DEV=1` (D6): one SDXL model on
 * one route of the `mock` backend kind, so the dry run works end to end before
 * any backend exists. The mock adapter itself arrives in Phase 4 (EN2), and
 * Phase 5 replaces the catalog with the install database; until then this is
 * the only model a development daemon knows. A normal start has no models.
 */

import type { ModeDescriptor, RouteDescriptor } from '@bureaucromancer/lantern-schema';

import type { ProfileRegistry } from '../profiles/index.js';
import { type CatalogModel, InMemoryModelCatalog } from './catalog.js';

/** Whether the environment asks for development mode. */
export function isDevMode(env: Readonly<Record<string, string | undefined>>): boolean {
  return env['LANTERN_DEV'] === '1';
}

export const DEV_MODEL_ID = 'mdl_dev_sdxl';
export const DEV_ROUTE_ID = 'rt_dev_mock';

const COMMON: ModeDescriptor['fields'] = {
  'prompt.positive': { state: 'native' },
  'prompt.negative': { state: 'native' },
  'sampling.seed': { state: 'native', maximum: 2 ** 32 - 1 },
  'sampling.steps': { state: 'native', minimum: 1, maximum: 150, default: 20 },
  'sampling.cfg': { state: 'native', maximum: 30, default: 7 },
  'sampling.sampler': {
    state: 'native',
    enum: ['euler', 'euler_a', 'dpm++2m', 'lcm'],
    default: 'euler_a',
  },
  'sampling.scheduler': { state: 'native', enum: ['discrete', 'karras'], default: 'discrete' },
  'sampling.clip_skip': { state: 'ignored', reason: 'The mock backend draws no text encoder.' },
  count: { state: 'native', native_max: 4, emulated_max: 8, default: 1 },
};

const CONTROL: ModeDescriptor['control'] = {
  cancel_queued: true,
  cancel_running: true,
  progress: 'fraction',
};

/** The mock route's `describe()` result. */
export const DEV_ROUTE_DESCRIPTOR: RouteDescriptor = {
  route: DEV_ROUTE_ID,
  modes: {
    txt2img: {
      fields: {
        ...COMMON,
        'geometry.width': { state: 'native', minimum: 256, maximum: 2048, multipleOf: 64 },
        'geometry.height': { state: 'native', minimum: 256, maximum: 2048, multipleOf: 64 },
      },
      extensions: {
        mock: { type: 'object', properties: { delay_ms: { type: 'integer', minimum: 0 } } },
      },
      control: CONTROL,
    },
    img2img: {
      fields: {
        ...COMMON,
        'sampling.denoise': { state: 'native', default: 0.75 },
        'inputs.init.asset_id': { state: 'native' },
        'inputs.init.crop': { state: 'emulated', reason: 'Lantern crops before sending.' },
      },
      inputs: { init: { state: 'native', min: 1, max: 1, media: ['image/*'] } },
      control: CONTROL,
    },
  },
};

/** The development model. */
export const DEV_MODEL: CatalogModel = {
  id: DEV_MODEL_ID,
  family: 'sdxl',
  routes: [
    {
      id: DEV_ROUTE_ID,
      backend_kind: 'mock',
      priority: 0,
      health: { status: 'ok', load_state: 'loaded' },
      describe: DEV_ROUTE_DESCRIPTOR,
    },
  ],
};

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
  return new InMemoryModelCatalog(isDevMode(env) ? [DEV_MODEL] : [], profiles);
}
