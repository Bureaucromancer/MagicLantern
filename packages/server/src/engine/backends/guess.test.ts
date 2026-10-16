// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { describe, expect, it } from 'vitest';

import { builtinProfiles } from '../profiles/index.js';
import { guessFamily, trustworthy } from './guess.js';

const profiles = builtinProfiles();

describe('guessFamily (A26)', () => {
  it.each([
    [['sd_xl_base_1.0'], 'sdxl', undefined, 'high'],
    [['SDXL-Base-1.0'], 'sdxl', undefined, 'high'],
    [['sd_xl_turbo_1.0_fp16'], 'sdxl-turbo', undefined, 'high'],
    [['SDXL-Turbo'], 'sdxl-turbo', undefined, 'high'],
    [['v1-5-pruned-emaonly'], 'sd15', undefined, 'high'],
    [['flux1-dev-q8_0'], 'flux1-dev', undefined, 'high'],
    [['flux1-schnell-Q4_0'], 'flux1-schnell', undefined, 'high'],
    [['flux1-kontext'], 'flux1-dev', undefined, 'low'],
    [['Flux-2-Klein-4B'], 'flux2-klein', 'distilled-4b', 'high'],
    [['flux-2-klein-base-9b'], 'flux2-klein', 'base-9b', 'high'],
    [['flux-2-klein'], 'flux2-klein', undefined, 'high'],
    [['Qwen-Image-Edit-2509-Q4_K_M'], 'qwen-image-edit', '2509', 'high'],
    [['qwen_image_edit'], 'qwen-image-edit', undefined, 'high'],
    [['Qwen-Image-Q4_K_M'], 'qwen-image', undefined, 'high'],
    [['z_image_turbo-Q8_0'], 'z-image-turbo', undefined, 'high'],
    [['Z-Image'], 'z-image-turbo', undefined, 'medium'],
    [['juggernaut-xl-v9'], 'sdxl', undefined, 'low'],
  ] as const)('reads %j as %s', (names, family, variant, confidence) => {
    const guess = guessFamily(names, profiles);
    expect(guess).toMatchObject({ family, confidence });
    expect(guess.variant).toBe(variant);
  });

  it('reads every name given, a path or a checkpoint included', () => {
    expect(
      guessFamily(
        ['My Model', '', 'stabilityai/stable-diffusion-xl-base-1.0:sd_xl_base_1.0.safetensors'],
        profiles,
      ),
    ).toMatchObject({ family: 'sdxl', confidence: 'high' });
    expect(guessFamily(['model', 'C:\\models\\v1-5-pruned.safetensors'], profiles)).toMatchObject({
      family: 'sd15',
    });
  });

  it('falls back to the generic profile, saying it has no idea', () => {
    const guess = guessFamily(['dreamshaper_8'], profiles);
    expect(guess).toEqual({
      family: 'generic',
      confidence: 'none',
      reason: expect.stringMatching(/backend’s own defaults/),
    });
    expect(trustworthy(guess)).toBe(false);
  });

  it('trusts a high or medium guess only', () => {
    expect(trustworthy(guessFamily(['Z-Image'], profiles))).toBe(true);
    expect(trustworthy(guessFamily(['juggernaut-xl'], profiles))).toBe(false);
  });
});
