// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * A route descriptor for the merge and validator tests: the plan's example
 * (txt2img), completed so it passes the checks, plus an img2img mode. A test
 * helper: never packed, never exported.
 */

import type { RouteDescriptor } from '@bureaucromancer/lantern-schema';

export const LORA_HASH = 'f'.repeat(64);

export const ROUTE: RouteDescriptor = {
  route: 'rt_example',
  modes: {
    txt2img: {
      fields: {
        'prompt.positive': { state: 'native' },
        'prompt.negative': { state: 'native' },
        'geometry.width': { state: 'native', minimum: 64, maximum: 2048, multipleOf: 64 },
        'geometry.height': { state: 'native', minimum: 64, maximum: 2048, multipleOf: 64 },
        'sampling.seed': { state: 'native' },
        'sampling.steps': { state: 'native', minimum: 1, maximum: 150, default: 20 },
        'sampling.sampler': {
          state: 'native',
          enum: ['euler', 'euler_a', 'dpm++2m'],
          default: 'euler',
        },
        'sampling.eta': { state: 'native' },
        'sampling.distilled_guidance': {
          state: 'ignored',
          reason: 'Not used by this model family',
        },
        count: { state: 'native', native_max: 8, emulated_max: 16 },
        'adapters.lora.id': { state: 'native' },
        'adapters.lora.weight': { state: 'native', minimum: -2, maximum: 2 },
        'passes.hires.scale': { state: 'native', maximum: 4 },
        'passes.hires.target.width': { state: 'native' },
        'passes.hires.target.height': { state: 'native' },
        'passes.hires.denoise': { state: 'native' },
      },
      adapters: {
        lora: {
          state: 'native',
          max: 2,
          options: [
            { id: 'detail-tweaker', label: 'Detail Tweaker' },
            { id: 'film-grain', sha256: LORA_HASH },
          ],
        },
      },
      passes: { hires: { state: 'native', max: 1 } },
      extensions: {
        sdcpp: {
          type: 'object',
          properties: { slg_scale: { type: 'number', minimum: 0 } },
          additionalProperties: false,
        },
      },
      control: { cancel_queued: true, cancel_running: false, progress: 'steps' },
    },
    img2img: {
      fields: {
        'prompt.positive': { state: 'native' },
        'sampling.seed': { state: 'native' },
        'sampling.denoise': { state: 'native', default: 0.75 },
        'inputs.init.asset_id': { state: 'native' },
        'inputs.init.crop': { state: 'emulated', reason: 'Lantern crops before sending' },
        'inputs.control.asset_id': { state: 'native' },
        'inputs.control.weight': { state: 'native', minimum: 0, maximum: 2 },
      },
      inputs: {
        init: { state: 'native', min: 1, max: 1, media: ['image/*'] },
        control: { state: 'native', max: 1, media: ['image/png', 'image/jpeg'] },
      },
      control: { cancel_queued: true, cancel_running: true, progress: 'fraction' },
    },
  },
};
