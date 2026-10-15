// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Minimal valid requests, one per mode, for this package's tests and the
 * server's Ajv conformance test. A test helper: never packed, never exported
 * from the package index.
 */

import {
  GENERATION_REQUEST_SCHEMA_VERSION,
  type GenerationMode,
  type GenerationRequest,
} from './generation-request.js';

/** Three distinct asset ids. */
export const ASSET_A = 'a'.repeat(64);
export const ASSET_B = 'b'.repeat(64);
export const ASSET_C = '0123456789abcdef'.repeat(4);

function base(mode: GenerationMode): GenerationRequest {
  return {
    schema_version: GENERATION_REQUEST_SCHEMA_VERSION,
    mode,
    prompt: { positive: 'a lighthouse at dusk' },
    sampling: { seed: 'random' },
  };
}

/** The smallest valid request for each mode. */
export const MINIMAL_REQUESTS: Readonly<Record<GenerationMode, GenerationRequest>> = {
  txt2img: base('txt2img'),
  img2img: { ...base('img2img'), inputs: [{ role: 'init', asset_id: ASSET_A }] },
  inpaint: {
    ...base('inpaint'),
    inputs: [
      { role: 'init', asset_id: ASSET_A },
      { role: 'mask', asset_id: ASSET_B },
    ],
  },
  edit: { ...base('edit'), inputs: [{ role: 'ref', asset_id: ASSET_A }] },
  txt2vid: base('txt2vid'),
  img2vid: { ...base('img2vid'), inputs: [{ role: 'first_frame', asset_id: ASSET_A }] },
  vid_extend: { ...base('vid_extend'), inputs: [{ role: 'init', asset_id: ASSET_A }] },
  upscale: {
    ...base('upscale'),
    inputs: [{ role: 'init', asset_id: ASSET_A }],
    passes: [{ kind: 'upscale', scale: 2 }],
  },
};

/** A request with every field set, experimental ones included. */
export const FULL_REQUEST: GenerationRequest = {
  schema_version: GENERATION_REQUEST_SCHEMA_VERSION,
  mode: 'img2img',
  prompt: { positive: 'a lighthouse at dusk', negative: 'blurry', dialect_hint: 'prose' },
  inputs: [
    {
      role: 'init',
      asset_id: ASSET_A,
      crop: { x: 0.1, y: 0.2, width: 0.9, height: 0.8 },
    },
    {
      role: 'control',
      asset_id: ASSET_B,
      weight: 0.8,
      region: { x: 0, y: 0, width: 1, height: 1 },
    },
  ],
  subjects: [
    {
      label: 'Mara',
      references: [{ asset_id: ASSET_C, crop: { x: 0.25, y: 0, width: 0.5, height: 0.5 } }],
      descriptors: { face: 'freckled', hair: 'red, cropped' },
      adapters: [{ kind: 'lora', id: 'mara-v2', weight: 0.7 }],
    },
  ],
  style: { exemplars: [{ asset_id: ASSET_B }], text: 'ink wash' },
  geometry: { width: 1024, height: 768, frames: 1, fps: 24, duration_s: 1 },
  sampling: {
    seed: 4_294_967_295,
    steps: 30,
    cfg: 6.5,
    distilled_guidance: 3.5,
    image_cfg: 1.5,
    denoise: 0.6,
    clip_skip: 2,
    sampler: 'euler_a',
    scheduler: 'native:karras',
    eta: 0,
    flow_shift: 3,
  },
  adapters: [
    { kind: 'lora', id: 'detail-tweaker', weight: -0.5, stage: 'high_noise' },
    { kind: 'embedding', id: 'easynegative', weight: 1 },
  ],
  passes: [
    { kind: 'hires', scale: 1.5, steps: 12, denoise: 0.4, upscaler: 'RealESRGAN_x4plus' },
    { kind: 'hires', target: { width: 2048, height: 1536 } },
    { kind: 'upscale', scale: 2, upscaler: 'RealESRGAN_x4plus' },
  ],
  count: 4,
  audio: { enabled: false, prompt: 'surf' },
  extensions: {
    sdcpp: { slg_scale: 2.5, cache: { mode: 'easycache', threshold: [0.2, null] } },
    comfy: {},
  },
};
