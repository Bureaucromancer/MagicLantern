// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * What Phase 5 added to resolving: the route's extension defaults written
 * out (L7), and the output size taken from the init image (A4), snapped to
 * what the route takes.
 */

import type { ModeDescriptor } from '@bureaucromancer/lantern-schema';
import { describe, expect, it } from 'vitest';

import { snapSize } from './fill.js';
import {
  ASSET_A,
  descriptor,
  IMG2IMG,
  img2img,
  model,
  route,
  testResolver,
  TXT2IMG,
  txt2img,
} from './test-resolver.js';
import type { InputSizer, Resolution, ResolveInput } from './types.js';

function resolve(input: ResolveInput): Resolution {
  const outcome = testResolver().resolve(input);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.failure));
  return outcome.resolution;
}

/** txt2img on a route whose sdcpp block has defaults, nested ones included. */
const WITH_DEFAULTS: ModeDescriptor = {
  ...TXT2IMG,
  extensions: {
    sdcpp: {
      type: 'object',
      additionalProperties: false,
      properties: {
        vae_tiling_params: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', default: true },
            tile_size_x: { type: 'integer', minimum: 0, default: 0 },
          },
        },
        cache_mode: { type: 'string', default: '' },
        slg_scale: { type: 'number', minimum: 0 },
      },
    },
  },
};

const onDefaults = () =>
  model('sdxl', [route('rt_a', { descriptor: descriptor('rt_a', { txt2img: WITH_DEFAULTS }) })]);

describe('extension defaults (L7)', () => {
  it('writes out every default of the route’s own block, as the route’s', () => {
    const resolution = resolve({ request: txt2img(), model: onDefaults() });
    expect(resolution.effective.extensions).toEqual({
      sdcpp: { vae_tiling_params: { enabled: true, tile_size_x: 0 }, cache_mode: '' },
    });
    expect(resolution.field_report['/extensions/sdcpp']).toMatchObject({
      state: 'native',
      source: 'descriptor',
      used: { vae_tiling_params: { enabled: true, tile_size_x: 0 }, cache_mode: '' },
    });
    expect(resolution.field_report['/extensions/sdcpp']).not.toHaveProperty('requested');
  });

  it('never changes what the request set, filling only around it', () => {
    const resolution = resolve({
      request: txt2img({
        extensions: { sdcpp: { vae_tiling_params: { enabled: false }, slg_scale: 2 } },
      }),
      model: onDefaults(),
    });
    expect(resolution.effective.extensions?.['sdcpp']).toEqual({
      vae_tiling_params: { enabled: false, tile_size_x: 0 },
      slg_scale: 2,
      cache_mode: '',
    });
    expect(resolution.field_report['/extensions/sdcpp']).toMatchObject({
      source: 'request',
      requested: { vae_tiling_params: { enabled: false }, slg_scale: 2 },
    });
  });

  it('leaves another kind’s block alone, and fills nothing on a route without defaults', () => {
    const elsewhere = resolve({
      request: txt2img({ extensions: { comfy: { node: 3 } } }),
      model: onDefaults(),
    });
    expect(elsewhere.effective.extensions?.['comfy']).toEqual({ node: 3 });
    expect(resolve({ request: txt2img(), model: model() }).effective.extensions).toBeUndefined();
  });

  it('reproduces: effective resolves to itself', () => {
    const first = resolve({ request: txt2img(), model: onDefaults() });
    const again = resolve({ request: first.effective, model: onDefaults() });
    expect(again.effective).toEqual(first.effective);
  });
});

describe('the size from the init image (A4)', () => {
  const sized =
    (width: number, height: number): InputSizer =>
    (input) =>
      input.asset_id === ASSET_A ? { width, height } : undefined;

  it('takes the input’s size, reported as from the input', () => {
    const resolution = resolve({ request: img2img(), model: model(), inputSize: sized(768, 512) });
    expect(resolution.effective.geometry).toEqual({ width: 768, height: 512 });
    expect(resolution.field_report['/geometry/width']).toMatchObject({
      source: 'input',
      used: 768,
    });
    expect(resolution.warnings.map((warning) => warning.code)).not.toContain('input_size_adjusted');
  });

  it('snaps it to the nearest size the route takes, and says so', () => {
    // As the catalog merges SDXL's multiple of 8 into the route's descriptor.
    const eights: ModeDescriptor = {
      ...IMG2IMG,
      fields: {
        ...IMG2IMG.fields,
        'geometry.width': { state: 'native', multipleOf: 8 },
        'geometry.height': { state: 'native', multipleOf: 8 },
      },
    };
    const resolution = resolve({
      request: img2img(),
      model: model('sdxl', [
        route('rt_a', { descriptor: descriptor('rt_a', { img2img: eights }) }),
      ]),
      inputSize: sized(1000, 750),
    });
    expect(resolution.effective.geometry).toEqual({ width: 1000, height: 752 });
    expect(resolution.warnings).toContainEqual(
      expect.objectContaining({
        code: 'input_size_adjusted',
        message:
          'The input is 1000×750; the output is 1000×752, the nearest size this route takes.',
      }),
    );
  });

  it('keeps a size the request gives, and leaves it unset when the input cannot be measured', () => {
    const given = resolve({
      request: img2img({ geometry: { width: 512, height: 512 } }),
      model: model(),
      inputSize: sized(1000, 750),
    });
    expect(given.effective.geometry).toEqual({ width: 512, height: 512 });
    expect(given.field_report['/geometry/width']).toMatchObject({ source: 'request' });
    const unknown = resolve({ request: img2img(), model: model(), inputSize: () => undefined });
    expect(unknown.effective.geometry).toBeUndefined();
  });

  it('warns rather than guess when no size the route takes is near', () => {
    const narrow: ModeDescriptor = {
      ...IMG2IMG,
      fields: {
        ...IMG2IMG.fields,
        'geometry.width': { state: 'native', minimum: 64, maximum: 128 },
        'geometry.height': { state: 'native', minimum: 64, maximum: 90, multipleOf: 100 },
      },
    };
    const resolution = resolve({
      request: img2img(),
      model: model('sdxl', [
        route('rt_a', { descriptor: descriptor('rt_a', { img2img: narrow }) }),
      ]),
      inputSize: sized(1000, 750),
    });
    expect(resolution.effective.geometry).toBeUndefined();
    expect(resolution.warnings.map((warning) => warning.code)).toContain('input_size_refused');
  });
});

describe('snapSize', () => {
  it.each([
    [750, { multipleOf: 8 }, 752],
    [1000, { multipleOf: 64 }, 1024],
    [20, { multipleOf: 64 }, 64],
    [5000, { maximum: 4096, multipleOf: 64 }, 4096],
    [10, { minimum: 64 }, 64],
    [130, { minimum: 64, maximum: 128, multipleOf: 100 }, 100],
    [130, { minimum: 64, maximum: 90, multipleOf: 100 }, undefined],
    [99, {}, 99],
  ] as const)('snaps %d under %j to %s', (value, narrowing, expected) => {
    expect(snapSize(value, narrowing)).toBe(expected);
  });
});
