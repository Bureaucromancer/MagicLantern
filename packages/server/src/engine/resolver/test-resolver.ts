// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Routes, models and requests for the resolver's tests. A test helper: never
 * packed, never exported.
 */

import type {
  GenerationRequest,
  ModeDescriptor,
  RouteDescriptor,
} from '@bureaucromancer/lantern-schema';

import { createValidator } from '../../validation/ajv.js';
import { builtinProfiles } from '../profiles/index.js';
import { createResolver, type Resolver } from './resolver.js';
import type { ResolverModel, RouteCandidate, SeedSource } from './types.js';

export const ASSET_A = 'a'.repeat(64);
export const ASSET_B = 'b'.repeat(64);

const CONTROL: ModeDescriptor['control'] = {
  cancel_queued: true,
  cancel_running: false,
  progress: 'steps',
};

/** txt2img as an sd.cpp-like route might describe it. */
export const TXT2IMG: ModeDescriptor = {
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
    'sampling.scheduler': { state: 'native', default: 'discrete' },
    'sampling.eta': { state: 'native' },
    'sampling.distilled_guidance': { state: 'ignored', reason: 'Not used by this model family' },
    count: { state: 'native', native_max: 4, emulated_max: 8 },
    'adapters.lora.id': { state: 'native' },
    'adapters.lora.weight': { state: 'native', minimum: -2, maximum: 2 },
    'passes.hires.scale': { state: 'native', maximum: 4, default: 2 },
    'passes.hires.target.width': { state: 'native' },
    'passes.hires.target.height': { state: 'native' },
    'passes.hires.steps': { state: 'native', maximum: 50, default: 10 },
    'passes.hires.denoise': { state: 'native', default: 0.5 },
  },
  adapters: {
    lora: {
      state: 'native',
      max: 2,
      options: [{ id: 'detail-tweaker' }, { id: 'film-grain' }],
    },
  },
  passes: { hires: { state: 'native', max: 2 } },
  extensions: {
    sdcpp: {
      type: 'object',
      properties: { slg_scale: { type: 'number', minimum: 0 } },
      additionalProperties: false,
    },
  },
  control: CONTROL,
};

/** img2img, with an init image and an emulated control input. */
export const IMG2IMG: ModeDescriptor = {
  fields: {
    'prompt.positive': { state: 'native' },
    'prompt.negative': { state: 'native' },
    'geometry.width': { state: 'native', default: 512 },
    'geometry.height': { state: 'native', default: 512 },
    'sampling.seed': { state: 'native' },
    'sampling.steps': { state: 'native', minimum: 1, maximum: 150, default: 20 },
    'sampling.cfg': { state: 'native', default: 7 },
    'sampling.denoise': { state: 'native', default: 0.75 },
    'inputs.init.asset_id': { state: 'native' },
    'inputs.init.weight': { state: 'native', default: 1 },
    'inputs.init.crop': { state: 'emulated', reason: 'Lantern crops before sending' },
    'inputs.control.asset_id': { state: 'native' },
    'inputs.control.weight': { state: 'native', minimum: 0, maximum: 2, default: 0.8 },
  },
  inputs: {
    init: { state: 'native', min: 1, max: 1, media: ['image/*'] },
    control: { state: 'emulated', reason: 'Applied by a second pass', max: 2 },
  },
  control: CONTROL,
};

/** A descriptor with the given modes (txt2img and img2img by default). */
export function descriptor(
  route: string,
  modes: RouteDescriptor['modes'] = { txt2img: TXT2IMG, img2img: IMG2IMG },
): RouteDescriptor {
  return { route, modes };
}

/** A healthy, loaded sd.cpp route. */
export function route(id: string, overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    id,
    backend_kind: 'sdcpp',
    priority: 0,
    health: { status: 'ok', load_state: 'loaded' },
    descriptor: descriptor(id),
    ...overrides,
  };
}

/** A model of a family on the given routes (one healthy route by default). */
export function model(
  family = 'sdxl',
  routes: readonly RouteCandidate[] = [route('rt_a')],
  overrides: Partial<ResolverModel> = {},
): ResolverModel {
  return { id: `mdl_${family}`, family, routes, ...overrides };
}

/** A seed source that gives these draws in turn, then repeats the last. */
export function seeds(...draws: number[]): SeedSource & { readonly limits: number[] } {
  const limits: number[] = [];
  let i = 0;
  const source = (limit: number): number => {
    limits.push(limit);
    const value = draws[Math.min(i, draws.length - 1)] ?? 0;
    i += 1;
    return value;
  };
  return Object.assign(source, { limits });
}

/** A resolver over the built-in profiles, drawing from `drawSeed` (1234 by default). */
export function testResolver(drawSeed: SeedSource = seeds(1234)): Resolver {
  return createResolver({ ajv: createValidator(), profiles: builtinProfiles(), drawSeed });
}

/** A txt2img request with the given parts laid over a minimal one. */
export function txt2img(parts: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    schema_version: 1,
    mode: 'txt2img',
    prompt: { positive: 'a lighthouse at dusk' },
    sampling: { seed: 'random' },
    ...parts,
  };
}

/** An img2img request with the given parts laid over a minimal one. */
export function img2img(parts: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    schema_version: 1,
    mode: 'img2img',
    prompt: { positive: 'a lighthouse at dusk' },
    inputs: [{ role: 'init', asset_id: ASSET_A }],
    sampling: { seed: 'random' },
    ...parts,
  };
}

/** Freezes a value deeply, so a test proves the resolver never writes to its input. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
