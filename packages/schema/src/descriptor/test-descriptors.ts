// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Descriptors for this package's tests and the server's merge and validator
 * tests. A test helper: never packed, never exported from the package index.
 */

import type { ModeDescriptor, RouteDescriptor } from './descriptor.js';

const LORA_HASH = 'f'.repeat(64);

/** txt2img as the plan's descriptor example has it, completed so it passes the checks. */
const TXT2IMG: ModeDescriptor = {
  fields: {
    'prompt.positive': { state: 'native' },
    'prompt.negative': { state: 'native' },
    'geometry.width': { state: 'native', minimum: 64, maximum: 2048, multipleOf: 64 },
    'geometry.height': { state: 'native', minimum: 64, maximum: 2048, multipleOf: 64 },
    'sampling.seed': { state: 'native' },
    'sampling.steps': { state: 'native', minimum: 1, maximum: 150, default: 20 },
    'sampling.cfg': { state: 'native', maximum: 30, default: 7 },
    'sampling.sampler': {
      state: 'native',
      enum: ['euler', 'euler_a', 'dpm++2m'],
      default: 'euler',
    },
    // The plan's example once had `sampling.eta` "ignored by this sampler
    // family": a state that depends on another field's value. Descriptors are
    // static (A6), so eta is native here; that euler ignores it is a profile
    // warning.
    'sampling.eta': { state: 'native' },
    'sampling.distilled_guidance': { state: 'ignored', reason: 'Not used by this model family' },
    count: { state: 'native', native_max: 8, emulated_max: 16 },
    'adapters.lora.id': { state: 'native' },
    'adapters.lora.weight': { state: 'native', minimum: -2, maximum: 2 },
    'passes.hires.scale': { state: 'native', maximum: 4 },
    'passes.hires.target.width': { state: 'native' },
    'passes.hires.target.height': { state: 'native' },
    'passes.hires.steps': { state: 'native', maximum: 50 },
    'passes.hires.denoise': { state: 'native' },
  },
  adapters: {
    lora: {
      state: 'native',
      max: 4,
      options: [
        { id: 'detail-tweaker', label: 'Detail Tweaker', default_weight: 0.5 },
        { id: 'film-grain', sha256: LORA_HASH, triggers: ['film grain'] },
      ],
    },
  },
  passes: { hires: { state: 'native', max: 1 } },
  extensions: {
    sdcpp: {
      type: 'object',
      properties: { slg_scale: { type: 'number' } },
      additionalProperties: false,
    },
  },
  control: { cancel_queued: true, cancel_running: false, progress: 'none' },
};

const IMG2IMG: ModeDescriptor = {
  fields: {
    'prompt.positive': { state: 'native' },
    'prompt.negative': { state: 'native' },
    'sampling.seed': { state: 'native' },
    'sampling.steps': { state: 'native', minimum: 1, maximum: 150, default: 20 },
    'sampling.denoise': { state: 'native', default: 0.75 },
    'inputs.init.asset_id': { state: 'native' },
    'inputs.init.crop': { state: 'emulated', reason: 'Lantern crops before sending' },
    'inputs.control.asset_id': { state: 'native' },
    'inputs.control.weight': { state: 'native', minimum: 0, maximum: 2 },
  },
  inputs: {
    init: { state: 'native', min: 1, max: 1, media: ['image/*'] },
    control: { state: 'native', max: 1, media: ['image/*'] },
  },
  control: { cancel_queued: true, cancel_running: true, progress: 'steps' },
};

/** The plan's example route, with img2img filled in. */
export const EXAMPLE_DESCRIPTOR: RouteDescriptor = {
  route: 'rt_example',
  modes: { txt2img: TXT2IMG, img2img: IMG2IMG },
};
