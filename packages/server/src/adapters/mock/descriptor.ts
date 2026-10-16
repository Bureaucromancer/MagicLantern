// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * What the mock backend says it can do: an SDXL-shaped route with txt2img and
 * img2img. A real descriptor in every respect, so the resolver, the form and
 * the engine treat it like any other; only `control` changes with the
 * behaviour profile, as it would between backends.
 */

import type { ModeDescriptor, RouteDescriptor } from '@bureaucromancer/lantern-schema';

import type { MockProfile } from './profiles.js';

export const MOCK_ROUTE_ID = 'rt_dev_mock';

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

const GEOMETRY: ModeDescriptor['fields'] = {
  'geometry.width': { state: 'native', minimum: 64, maximum: 2048, multipleOf: 64 },
  'geometry.height': { state: 'native', minimum: 64, maximum: 2048, multipleOf: 64 },
};

/** What cancelling and progress look like under each profile, as the real backends they stand for. */
function controlFor(profile: MockProfile): ModeDescriptor['control'] {
  switch (profile) {
    case 'sdserver':
      return { cancel_queued: true, cancel_running: false, progress: 'steps' };
    case 'sync':
      return { cancel_queued: false, cancel_running: false, progress: 'none' };
    default:
      return { cancel_queued: true, cancel_running: true, progress: 'fraction' };
  }
}

/** The route's `describe()` result under a profile. */
export function mockRouteDescriptor(
  route: string = MOCK_ROUTE_ID,
  profile: MockProfile = 'basic',
): RouteDescriptor {
  const control = controlFor(profile);
  return {
    route,
    modes: {
      txt2img: {
        fields: { ...COMMON, ...GEOMETRY },
        extensions: {
          mock: { type: 'object', properties: { delay_ms: { type: 'integer', minimum: 0 } } },
        },
        control,
      },
      img2img: {
        fields: {
          ...COMMON,
          ...GEOMETRY,
          'sampling.denoise': { state: 'native', default: 0.75 },
          'inputs.init.asset_id': { state: 'native' },
          'inputs.init.crop': { state: 'emulated', reason: 'Lantern crops before sending.' },
        },
        inputs: { init: { state: 'native', min: 1, max: 1, media: ['image/*'] } },
        control,
      },
    },
  };
}
