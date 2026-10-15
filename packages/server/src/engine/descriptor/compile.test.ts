// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * A route and mode compiled to one JSON Schema, under the daemon's own Ajv
 * (rule 5): in-range requests pass untouched, and everything the effective
 * descriptor narrows or leaves out is refused at the field's own pointer.
 */

import type { GenerationRequest, RouteDescriptor } from '@bureaucromancer/lantern-schema';
import { describe, expect, it } from 'vitest';

import { createValidator } from '../../validation/ajv.js';
import { compileRequestSchema, createRequestValidator } from './compile.js';
import { mergeDescriptor, profileLayer } from './merge.js';
import { ROUTE } from './test-descriptors.js';

const ASSET_A = 'a'.repeat(64);
const ASSET_B = 'b'.repeat(64);

const TXT2IMG: GenerationRequest = {
  schema_version: 1,
  mode: 'txt2img',
  prompt: { positive: 'a lighthouse at dusk', negative: 'blurry' },
  geometry: { width: 1024, height: 768 },
  sampling: { seed: 42, steps: 150, sampler: 'euler_a', eta: 0.5, distilled_guidance: 99 },
  adapters: [
    { kind: 'lora', id: 'detail-tweaker', weight: 0.5 },
    { kind: 'lora', id: 'film-grain', weight: -2 },
  ],
  passes: [{ kind: 'hires', target: { width: 2048, height: 1536 }, denoise: 0.3 }],
  count: 16,
  extensions: { sdcpp: { slg_scale: 2.5 }, comfy: { anything: [1, 2] } },
};

const IMG2IMG: GenerationRequest = {
  schema_version: 1,
  mode: 'img2img',
  prompt: { positive: 'a lighthouse at dusk' },
  inputs: [
    { role: 'init', asset_id: ASSET_A, crop: { x: 0, y: 0, width: 0.5, height: 1 } },
    { role: 'control', asset_id: ASSET_B, weight: 2 },
  ],
  sampling: { seed: 'random', denoise: 0.6 },
};

/** A deep copy with one value replaced (or removed, for `undefined`) at a dotted path. */
function withValue(request: GenerationRequest, path: string, value: unknown): unknown {
  const copy = structuredClone(request) as unknown as Record<string, unknown>;
  const keys = path.split('.');
  const last = keys.pop()!;
  let node = copy;
  for (const key of keys) node = node[key] as Record<string, unknown>;
  if (value === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the field under test
    delete node[last];
  } else {
    node[last] = value;
  }
  return copy;
}

function validatorFor(descriptor: RouteDescriptor, mode: 'txt2img' | 'img2img') {
  return createRequestValidator(createValidator(), descriptor, mode);
}

const txt2img = validatorFor(ROUTE, 'txt2img');
const img2img = validatorFor(ROUTE, 'img2img');

function paths(validate: (request: unknown) => { path: string }[], request: unknown): string[] {
  return validate(request).map((issue) => issue.path);
}

describe('compileRequestSchema', () => {
  it("compiles every mode under the daemon's Ajv", () => {
    for (const mode of ['txt2img', 'img2img'] as const) {
      expect(() => createValidator().compile(compileRequestSchema(ROUTE, mode))).not.toThrow();
    }
  });

  it('refuses a mode the route does not serve', () => {
    expect(() => compileRequestSchema(ROUTE, 'edit')).toThrow(/does not serve edit/);
  });

  it('writes narrowing in, and leaves defaults and reasons out', () => {
    const schema = compileRequestSchema(ROUTE, 'txt2img');
    const json = JSON.stringify(schema);
    expect(json).not.toContain('"default"');
    expect(json).not.toContain('Not used by this model family');
    const sampling = (schema['properties'] as Record<string, Record<string, unknown>>)['sampling']!;
    const props = sampling['properties'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(props)).toEqual(['seed', 'steps', 'distilled_guidance', 'sampler', 'eta']);
    expect(props['steps']).toMatchObject({ type: 'integer', minimum: 1, maximum: 150 });
    expect(props['sampler']).toMatchObject({ enum: ['euler', 'euler_a', 'dpm++2m'] });
  });

  it('turns per-role entries into if/then overlays on the item schema', () => {
    const schema = compileRequestSchema(ROUTE, 'img2img') as {
      properties: Record<string, { items?: unknown }>;
    };
    expect(Object.keys(schema.properties)).toEqual([
      'schema_version',
      'mode',
      'prompt',
      'inputs',
      'sampling',
      'extensions',
    ]);
    const items = schema.properties['inputs']!.items as Record<string, unknown>;
    expect({
      role: (items['properties'] as Record<string, unknown>)['role'],
      allOf: items['allOf'],
    }).toMatchInlineSnapshot(`
      {
        "allOf": [
          {
            "if": {
              "properties": {
                "role": {
                  "const": "init",
                },
              },
              "required": [
                "role",
              ],
            },
            "then": {
              "properties": {
                "region": false,
                "weight": false,
              },
            },
          },
          {
            "if": {
              "properties": {
                "role": {
                  "const": "control",
                },
              },
              "required": [
                "role",
              ],
            },
            "then": {
              "properties": {
                "crop": false,
                "region": false,
                "weight": {
                  "maximum": 2,
                  "minimum": 0,
                },
              },
            },
          },
        ],
        "role": {
          "description": "What an input is for. \`ref\` is a likeness or content reference; \`style\` a style exemplar (StoryEngine's split).",
          "enum": [
            "init",
            "control",
          ],
          "type": "string",
        },
      }
    `);
  });
});

describe('the compiled validator', () => {
  it('accepts in-range requests and rewrites nothing', () => {
    for (const [validate, request] of [
      [txt2img, TXT2IMG],
      [img2img, IMG2IMG],
    ] as const) {
      const copy = structuredClone(request);
      expect(validate(copy)).toEqual([]);
      expect(copy).toEqual(request);
    }
  });

  it.each([
    ['sampling.steps', 151, '/sampling/steps'],
    ['sampling.steps', 0, '/sampling/steps'],
    ['sampling.sampler', 'heun', '/sampling/sampler'],
    ['sampling.cfg', 7, '/sampling/cfg'],
    ['sampling.seed', 2 ** 53, '/sampling/seed'],
    ['prompt.dialect_hint', 'prose', '/prompt/dialect_hint'],
    ['geometry.width', 1000, '/geometry/width'],
    ['geometry.width', 4096, '/geometry/width'],
    ['geometry.frames', 4, '/geometry/frames'],
    ['count', 17, '/count'],
    ['mode', 'img2img', '/mode'],
    ['audio', { enabled: true }, '/audio'],
    ['inputs', [{ role: 'init', asset_id: ASSET_A }], '/inputs'],
    ['adapters.0.id', 'ink-wash', '/adapters/0/id'],
    ['adapters.1.weight', 2.5, '/adapters/1/weight'],
    ['adapters.0.stage', 'low_noise', '/adapters/0/stage'],
    ['adapters.0.kind', 'embedding', '/adapters/0/kind'],
    ['passes.0.upscaler', 'RealESRGAN', '/passes/0/upscaler'],
    ['passes.0.steps', 10, '/passes/0/steps'],
    ['passes.0.kind', 'upscale', '/passes/0/kind'],
    ['passes.0', { kind: 'hires', scale: 5 }, '/passes/0/scale'],
    ['extensions.sdcpp.slg_scale', -1, '/extensions/sdcpp/slg_scale'],
    ['extensions.sdcpp.vae_tiling', true, '/extensions/sdcpp/vae_tiling'],
    ['sampling.cfg_scale', 7, '/sampling/cfg_scale'],
  ])('txt2img refuses %s = %j at %s', (path, value, pointer) => {
    expect(paths(txt2img, withValue(TXT2IMG, path, value))).toEqual([pointer]);
  });

  it.each([
    ['inputs.1.weight', 2.5, '/inputs/1/weight'],
    ['inputs.0.weight', 0.5, '/inputs/0/weight'],
    ['inputs.0.region', { x: 0, y: 0, width: 1, height: 1 }, '/inputs/0/region'],
    ['inputs.1.role', 'ref', '/inputs/1/role'],
    ['sampling.denoise', 1.5, '/sampling/denoise'],
    ['sampling.steps', 20, '/sampling/steps'],
    ['prompt.negative', 'blurry', '/prompt/negative'],
    ['geometry', { width: 512, height: 512 }, '/geometry'],
    ['adapters', [], '/adapters'],
  ])('img2img refuses %s = %j at %s', (path, value, pointer) => {
    expect(paths(img2img, withValue(IMG2IMG, path, value))).toEqual([pointer]);
  });

  it('counts items per role and kind in code', () => {
    const twoControls = withValue(IMG2IMG, 'inputs', [
      { role: 'init', asset_id: ASSET_A },
      { role: 'control', asset_id: ASSET_B },
      { role: 'control', asset_id: ASSET_B },
    ]);
    expect(img2img(twoControls)).toEqual([
      { path: '/inputs', message: 'at most 1 `control` input on this route' },
    ]);
    const noInit = withValue(IMG2IMG, 'inputs', [{ role: 'control', asset_id: ASSET_B }]);
    expect(img2img(noInit)).toEqual([
      { path: '/inputs', message: 'at least 1 `init` input on this route' },
    ]);
    const threeLoras = withValue(TXT2IMG, 'adapters', [
      ...TXT2IMG.adapters!,
      { kind: 'lora', id: 'film-grain', weight: 1 },
    ]);
    expect(txt2img(threeLoras)).toEqual([
      { path: '/adapters', message: 'at most 2 `lora` adapters on this route' },
    ]);
  });

  it('says a known field is unsupported here, and an unknown one unknown', () => {
    expect(txt2img(withValue(TXT2IMG, 'sampling.cfg', 7))).toEqual([
      { path: '/sampling/cfg', message: 'is not supported by this route in txt2img' },
    ]);
    expect(txt2img(withValue(TXT2IMG, 'adapters.0.stage', 'low_noise'))).toEqual([
      { path: '/adapters/0/stage', message: 'is not supported by this route in txt2img' },
    ]);
    expect(txt2img(withValue(TXT2IMG, 'sampling.cfg_scale', 7))).toEqual([
      { path: '/sampling/cfg_scale', message: 'is not a known field' },
    ]);
    expect(txt2img(withValue(TXT2IMG, 'inputs', []))).toEqual([
      { path: '/inputs', message: 'is not supported by this route in txt2img' },
    ]);
  });

  it('takes narrowing from the profile layer', () => {
    const { descriptor } = mergeDescriptor(ROUTE, {
      profile: profileLayer({
        txt2img: {
          narrow: {
            'sampling.steps': { maximum: 8 },
            'adapters.lora.id': { enum: ['film-grain'] },
          },
          absent: ['sampling.eta'],
        },
      }),
    });
    const validate = validatorFor(descriptor, 'txt2img');
    const request = {
      ...TXT2IMG,
      sampling: { seed: 42, steps: 9, eta: 0.5 },
    };
    expect(paths(validate, request)).toEqual([
      '/sampling/eta',
      '/sampling/steps',
      '/adapters/0/id',
    ]);
    expect(
      validate({
        ...TXT2IMG,
        sampling: { seed: 42, steps: 8 },
        adapters: [{ kind: 'lora', id: 'film-grain', weight: 1 }],
      }),
    ).toEqual([]);
  });

  it('caps count at native_max when nothing is emulated', () => {
    const descriptor = structuredClone(ROUTE);
    delete descriptor.modes.txt2img!.fields['count']!.emulated_max;
    const validate = validatorFor(descriptor, 'txt2img');
    expect(paths(validate, withValue(TXT2IMG, 'count', 9))).toEqual(['/count']);
    expect(validate(withValue(TXT2IMG, 'count', 8))).toEqual([]);
  });
});
