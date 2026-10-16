// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `prepare` for sd-server (SD2): an effective request to the exact
 * `POST /sdcpp/v1/img_gen` body, with `{"$asset": sha256}` placeholders where
 * the images go (A15). Pure: the same request gives the same body.
 *
 * Every value that can change pixels is written out, even where it equals
 * what the server would assume, because the server's assumptions come from
 * its command line and differ between instances (L7): the negative prompt,
 * clip skip (`-1`: the model's own), the LoRA list (empty included) and the
 * hires pass (`enabled: false` included). What the model decides (a sampler
 * or flow shift the server reports as `"default"` or `null`) is left out,
 * because no value would say the same thing.
 *
 * | Canonical | sd-server |
 * | --- | --- |
 * | `prompt.positive`, `prompt.negative` | `prompt`, `negative_prompt` |
 * | `geometry.width`, `geometry.height` | `width`, `height` |
 * | `sampling.steps`, `.sampler`, `.scheduler`, `.eta`, `.flow_shift` | `sample_params.sample_steps`, `.sample_method`, `.scheduler`, `.eta`, `.flow_shift` |
 * | `sampling.cfg`, `.image_cfg`, `.distilled_guidance` | `sample_params.guidance.txt_cfg`, `.img_cfg`, `.distilled_guidance` |
 * | `sampling.denoise`, `sampling.clip_skip` | `strength`, `clip_skip` |
 * | `sampling.seed`, `count` | `seed`, `batch_count` (output k uses seed + k) |
 * | inputs init, mask, control, ip_adapter, ref | `init_image`, `mask_image`, `control_image` (+ `control_strength`), `ip_adapter_image` (+ `ip_adapter_strength`), `ref_images[]` |
 * | `adapters` (LoRA) | `lora[{path, multiplier, is_high_noise}]` |
 * | `passes` hires | `hires` |
 * | `extensions.sdcpp` | `sample_params.guidance.slg`, `sample_params.shifted_timestep`, and the rest at the top level |
 */

import type { GenerationRequest, Input } from '@bureaucromancer/lantern-schema';

import { assetPlaceholder } from '../shared/wire.js';
import { nativeName, SDCPP_KIND } from './describe.js';

export interface PrepareOptions {
  /** The preview mode to ask for (`proj`), or null for none. */
  readonly preview: string | null;
}

/** Keys of `extensions.sdcpp` that go to the top level of the body as they are. */
const TOP_LEVEL_EXTENSIONS = [
  'vae_tiling_params',
  'cache_mode',
  'cache_option',
  'scm_mask',
  'scm_policy_dynamic',
  'image_preprocess',
  'ref_image_args',
  'increase_ref_index',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function only(inputs: readonly Input[], role: Input['role']): Input | undefined {
  return inputs.find((input) => input.role === role);
}

/**
 * The `img_gen` body for an effective request.
 *
 * @throws TypeError when the request is not effective (no concrete seed, no size)
 */
export function prepareImgGen(
  request: GenerationRequest,
  options: PrepareOptions,
): Record<string, unknown> {
  const { sampling, prompt, geometry } = request;
  if (typeof sampling.seed !== 'number') {
    throw new TypeError('sd-server is sent concrete seeds only: resolve the request first.');
  }
  if (geometry === undefined) {
    throw new TypeError('The effective request has no geometry, and sd-server needs a size.');
  }
  const extension = request.extensions?.[SDCPP_KIND] ?? {};
  const inputs = request.inputs ?? [];

  const guidance: Record<string, unknown> = {};
  if (sampling.cfg !== undefined) guidance['txt_cfg'] = sampling.cfg;
  if (sampling.image_cfg !== undefined) guidance['img_cfg'] = sampling.image_cfg;
  if (sampling.distilled_guidance !== undefined) {
    guidance['distilled_guidance'] = sampling.distilled_guidance;
  }
  if (isRecord(extension['slg'])) guidance['slg'] = extension['slg'];

  const sampleParams: Record<string, unknown> = {};
  if (sampling.steps !== undefined) sampleParams['sample_steps'] = sampling.steps;
  if (sampling.sampler !== undefined) sampleParams['sample_method'] = nativeName(sampling.sampler);
  if (sampling.scheduler !== undefined) sampleParams['scheduler'] = nativeName(sampling.scheduler);
  if (sampling.eta !== undefined) sampleParams['eta'] = sampling.eta;
  if (sampling.flow_shift !== undefined) sampleParams['flow_shift'] = sampling.flow_shift;
  if (extension['shifted_timestep'] !== undefined) {
    sampleParams['shifted_timestep'] = extension['shifted_timestep'];
  }
  sampleParams['guidance'] = guidance;

  const wire: Record<string, unknown> = {
    prompt: prompt.positive,
    negative_prompt: prompt.negative ?? '',
    width: geometry.width,
    height: geometry.height,
    seed: sampling.seed,
    batch_count: request.count ?? 1,
    clip_skip: sampling.clip_skip ?? -1,
  };
  if (
    sampling.denoise !== undefined &&
    (request.mode === 'img2img' || request.mode === 'inpaint')
  ) {
    wire['strength'] = sampling.denoise;
  }
  wire['sample_params'] = sampleParams;

  const init = only(inputs, 'init');
  if (init !== undefined && (request.mode === 'img2img' || request.mode === 'inpaint')) {
    wire['init_image'] = assetPlaceholder(init.asset_id);
  }
  const mask = only(inputs, 'mask');
  if (mask !== undefined && request.mode === 'inpaint') {
    wire['mask_image'] = assetPlaceholder(mask.asset_id);
  }
  const control = only(inputs, 'control');
  if (control !== undefined) {
    wire['control_image'] = assetPlaceholder(control.asset_id);
    if (control.weight !== undefined) wire['control_strength'] = control.weight;
  }
  const ipAdapter = only(inputs, 'ip_adapter');
  if (ipAdapter !== undefined) {
    wire['ip_adapter_image'] = assetPlaceholder(ipAdapter.asset_id);
    if (ipAdapter.weight !== undefined) wire['ip_adapter_strength'] = ipAdapter.weight;
  }
  if (request.mode === 'edit') {
    wire['ref_images'] = inputs
      .filter((input) => input.role === 'ref')
      .map((input) => assetPlaceholder(input.asset_id));
  }

  wire['lora'] = (request.adapters ?? [])
    .filter((adapter) => adapter.kind === 'lora')
    .map((adapter) => ({
      path: adapter.id,
      multiplier: adapter.weight,
      is_high_noise: adapter.stage === 'high_noise',
    }));

  const hires = (request.passes ?? []).find((pass) => pass.kind === 'hires');
  if (hires?.kind === 'hires') {
    wire['hires'] = {
      enabled: true,
      ...(hires.upscaler === undefined ? {} : { upscaler: hires.upscaler }),
      ...(hires.scale === undefined ? {} : { scale: hires.scale }),
      target_width: hires.target?.width ?? 0,
      target_height: hires.target?.height ?? 0,
      // 0: as many steps as the first pass.
      steps: hires.steps ?? 0,
      ...(hires.denoise === undefined ? {} : { denoising_strength: hires.denoise }),
    };
  } else {
    wire['hires'] = { enabled: false };
  }

  for (const key of TOP_LEVEL_EXTENSIONS) {
    if (extension[key] !== undefined) wire[key] = extension[key];
  }

  wire['output_format'] = 'png';
  wire['output_compression'] = 100;
  wire['embed_image_metadata'] = true;
  if (options.preview !== null) {
    wire['preview'] = options.preview;
    wire['preview_interval'] = 1;
  }
  return wire;
}
