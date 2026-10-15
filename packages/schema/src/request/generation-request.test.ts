// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { Kind, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import {
  checkGenerationRequest,
  checkSourceRect,
  GENERATION_MODES,
  GenerationRequest,
  type GenerationRequest as Request,
  HiresPass,
  INPUT_ROLES,
  listRequestPaths,
  Pass,
  PASS_KINDS,
  PASS_SCHEMAS,
  REQUEST_PATH_SET,
  REQUEST_PATHS,
  SEED_DRAW_LIMIT,
  SEED_MAX,
  type SourceRect,
  UpscalePass,
} from './index.js';
import { ASSET_A, ASSET_B, FULL_REQUEST, MINIMAL_REQUESTS } from './test-requests.js';

/** A copy of a valid request with some fields replaced, typed loosely so a test can break it. */
function variant(request: Request, changes: Record<string, unknown>): Request {
  return { ...structuredClone(request), ...changes };
}

/** The issue paths `checkGenerationRequest` reports, after confirming the schema accepts the request. */
function codeIssuePaths(request: Request): string[] {
  expect([...Value.Errors(GenerationRequest, request)]).toEqual([]);
  return checkGenerationRequest(request).map((issue) => issue.path);
}

/** Every subschema, depth first. */
function* walk(schema: unknown): Generator<Record<string, unknown>> {
  if (typeof schema !== 'object' || schema === null) return;
  if (Array.isArray(schema)) {
    for (const item of schema) yield* walk(item);
    return;
  }
  const record = schema as Record<string, unknown>;
  yield record;
  for (const value of Object.values(record)) yield* walk(value);
}

describe('GenerationRequest', () => {
  it.each(GENERATION_MODES)('accepts a minimal %s request', (mode) => {
    const request = MINIMAL_REQUESTS[mode];
    expect(request.mode).toBe(mode);
    expect(codeIssuePaths(request)).toEqual([]);
  });

  it('accepts a request with every field set', () => {
    expect(codeIssuePaths(FULL_REQUEST)).toEqual([]);
  });

  it('declares no defaults: they belong to the resolver (rule 5)', () => {
    for (const node of walk(GenerationRequest)) expect(node).not.toHaveProperty('default');
  });

  it('closes every object except the contents of extensions', () => {
    const extensionValues = GenerationRequest.properties.extensions.patternProperties;
    const open = new Set<unknown>(Object.values(extensionValues));
    for (const node of walk(GenerationRequest)) {
      if (node['type'] !== 'object' || open.has(node)) continue;
      expect(node['additionalProperties'], JSON.stringify(node).slice(0, 80)).toBe(false);
    }
    expect(open.size).toBe(1);
  });

  it('uses no $id, so it leaves the OpenAPI components alone', () => {
    for (const node of walk(GenerationRequest)) expect(node).not.toHaveProperty('$id');
  });

  it('refuses a request without a mode, prompt, sampling or seed', () => {
    const request = MINIMAL_REQUESTS.txt2img;
    for (const field of ['schema_version', 'mode', 'prompt', 'sampling']) {
      const broken: Record<string, unknown> = structuredClone(request);
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the field under test
      delete broken[field];
      expect(Value.Check(GenerationRequest, broken), field).toBe(false);
    }
    expect(Value.Check(GenerationRequest, variant(request, { sampling: {} }))).toBe(false);
  });

  it('refuses another schema version', () => {
    expect(
      Value.Check(GenerationRequest, variant(MINIMAL_REQUESTS.txt2img, { schema_version: 2 })),
    ).toBe(false);
  });
});

describe('seeds', () => {
  const withSeed = (seed: unknown) => variant(MINIMAL_REQUESTS.txt2img, { sampling: { seed } });

  it('draw below 2^32 and allow up to 2^53 − 1', () => {
    expect(SEED_DRAW_LIMIT).toBe(4_294_967_296);
    expect(SEED_MAX).toBe(2 ** 53 - 1);
  });

  it.each([['random'], [0], [SEED_DRAW_LIMIT], [SEED_MAX]])('accept %s', (seed) => {
    expect(Value.Check(GenerationRequest, withSeed(seed))).toBe(true);
  });

  it.each([['Random'], [-1], [1.5], [2 ** 53], [2 ** 64], [null]])('refuse %s', (seed) => {
    expect(Value.Check(GenerationRequest, withSeed(seed))).toBe(false);
  });
});

describe('checkGenerationRequest: modes (A4)', () => {
  it.each([
    ['img2img', 'init'],
    ['inpaint', 'init'],
    ['inpaint', 'mask'],
    ['edit', 'ref'],
    ['upscale', 'init'],
  ] as const)('refuses %s without a `%s` input, at /inputs', (mode, role) => {
    const request = structuredClone(MINIMAL_REQUESTS[mode]);
    request.inputs = (request.inputs ?? []).filter((input) => input.role !== role);
    const issues = checkGenerationRequest(request);
    expect(issues).toContainEqual({
      path: '/inputs',
      message: `${mode} needs a \`${role}\` input`,
    });
  });

  it('counts an absent inputs array as no inputs', () => {
    const request = structuredClone(MINIMAL_REQUESTS.edit);
    delete request.inputs;
    expect(codeIssuePaths(request)).toEqual(['/inputs']);
  });

  it('accepts several refs for edit', () => {
    const request = variant(MINIMAL_REQUESTS.edit, {
      inputs: [
        { role: 'ref', asset_id: ASSET_A },
        { role: 'ref', asset_id: ASSET_B, weight: 0.5 },
      ],
    });
    expect(codeIssuePaths(request)).toEqual([]);
  });

  it('refuses upscale without an upscale pass, at /passes', () => {
    expect(codeIssuePaths(variant(MINIMAL_REQUESTS.upscale, { passes: [] }))).toEqual(['/passes']);
    const hiresOnly = variant(MINIMAL_REQUESTS.upscale, { passes: [{ kind: 'hires', scale: 2 }] });
    expect(codeIssuePaths(hiresOnly)).toEqual(['/passes']);
  });

  it('refuses a second init or mask, at its role', () => {
    const request = variant(MINIMAL_REQUESTS.inpaint, {
      inputs: [
        { role: 'init', asset_id: ASSET_A },
        { role: 'mask', asset_id: ASSET_B },
        { role: 'init', asset_id: ASSET_B },
        { role: 'mask', asset_id: ASSET_A },
      ],
    });
    expect(codeIssuePaths(request)).toEqual(['/inputs/2/role', '/inputs/3/role']);
  });

  it('refuses a weight on init or mask: init strength is sampling.denoise (A8)', () => {
    const request = variant(MINIMAL_REQUESTS.inpaint, {
      inputs: [
        { role: 'init', asset_id: ASSET_A, weight: 0.5 },
        { role: 'mask', asset_id: ASSET_B, weight: 1 },
      ],
    });
    expect(codeIssuePaths(request)).toEqual(['/inputs/0/weight', '/inputs/1/weight']);
  });

  it('leaves inputs a mode does not use to the resolver, which reports them as ignored', () => {
    const request = variant(MINIMAL_REQUESTS.txt2img, {
      inputs: [{ role: 'mask', asset_id: ASSET_A }],
    });
    expect(codeIssuePaths(request)).toEqual([]);
  });
});

describe('checkGenerationRequest: crops and regions (A7)', () => {
  const rect = (r: SourceRect) => r;

  it('tolerate a floating-point sum just above 1', () => {
    expect(0.8888888888888891 + 0.1111111111111111).toBeGreaterThan(1);
  });

  it.each([
    ['the whole image', rect({ x: 0, y: 0, width: 1, height: 1 }), []],
    [
      'a sum that floating point puts above 1',
      rect({ x: 0.8888888888888891, y: 0, width: 0.1111111111111111, height: 1 }),
      [],
    ],
    ['zero width', rect({ x: 0, y: 0, width: 0, height: 1 }), ['/r/width']],
    ['zero height', rect({ x: 0, y: 0, width: 1, height: 0 }), ['/r/height']],
    ['past the right edge', rect({ x: 0.5, y: 0, width: 0.6, height: 1 }), ['/r/width']],
    ['past the bottom edge', rect({ x: 0, y: 0.75, width: 1, height: 0.5 }), ['/r/height']],
  ])('%s', (_label, value, paths) => {
    expect(checkSourceRect(value, '/r').map((issue) => issue.path)).toEqual(paths);
  });

  it('checks every crop and region in a request', () => {
    const bad = { x: 0.5, y: 0.5, width: 0.6, height: 0 };
    const request = variant(FULL_REQUEST, {
      inputs: [
        { role: 'init', asset_id: ASSET_A, crop: bad },
        { role: 'control', asset_id: ASSET_B, region: bad },
      ],
      subjects: [{ references: [{ asset_id: ASSET_A, crop: bad }] }],
      style: { exemplars: [{ asset_id: ASSET_B, crop: bad }] },
    });
    expect(codeIssuePaths(request)).toEqual([
      '/inputs/0/crop/width',
      '/inputs/0/crop/height',
      '/inputs/1/region/width',
      '/inputs/1/region/height',
      '/subjects/0/references/0/crop/width',
      '/subjects/0/references/0/crop/height',
      '/style/exemplars/0/crop/width',
      '/style/exemplars/0/crop/height',
    ]);
  });

  it('refuses coordinates outside 0..1 in the schema', () => {
    for (const crop of [
      { x: -0.1, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 0, width: 1.5, height: 0.5 },
      { x: 0, y: 0, width: 0.5 },
      { x: 0, y: 0, width: 0.5, height: 0.5, unit: 'px' },
    ]) {
      const request = variant(MINIMAL_REQUESTS.img2img, {
        inputs: [{ role: 'init', asset_id: ASSET_A, crop }],
      });
      expect(Value.Check(GenerationRequest, request), JSON.stringify(crop)).toBe(false);
    }
  });
});

describe('checkGenerationRequest: passes (A9)', () => {
  const withPasses = (passes: unknown[]) => variant(MINIMAL_REQUESTS.txt2img, { passes });

  it('refuses a hires pass with neither scale nor target, at its scale', () => {
    expect(codeIssuePaths(withPasses([{ kind: 'hires', steps: 10 }]))).toEqual(['/passes/0/scale']);
  });

  it('refuses a hires pass with both scale and target, at its target', () => {
    const pass = { kind: 'hires', scale: 2, target: { width: 2048, height: 2048 } };
    expect(codeIssuePaths(withPasses([pass]))).toEqual(['/passes/0/target']);
  });

  it('refuses hires fields on an upscale pass, at each field', () => {
    const pass = { kind: 'upscale', scale: 2, steps: 10, denoise: 0.3 };
    const issues = checkGenerationRequest(withPasses([pass]));
    expect(issues).toEqual([
      { path: '/passes/0/steps', message: 'is not a field of a `upscale` pass' },
      { path: '/passes/0/denoise', message: 'is not a field of a `upscale` pass' },
    ]);
  });

  it('refuses an upscale pass without a scale, at its scale', () => {
    expect(codeIssuePaths(withPasses([{ kind: 'upscale', upscaler: 'x' }]))).toEqual([
      '/passes/0/scale',
    ]);
  });

  it('names the index of the pass at fault', () => {
    const passes = [{ kind: 'upscale', scale: 2 }, { kind: 'hires' }];
    expect(codeIssuePaths(withPasses(passes))).toEqual(['/passes/1/scale']);
  });

  it('refuses refine, face_fix and unknown fields in the schema', () => {
    for (const pass of [
      { kind: 'refine' },
      { kind: 'face_fix' },
      { kind: 'hires', scale: 2, model: 'x' },
      { kind: 'upscale', scale: 0 },
    ]) {
      expect(Value.Check(GenerationRequest, withPasses([pass])), JSON.stringify(pass)).toBe(false);
    }
  });

  it("validates a pass with one closed object holding each kind's fields, with the same schemas", () => {
    expect(PASS_KINDS).toEqual(Object.keys(PASS_SCHEMAS));
    const flat = Pass as unknown as { properties: Record<string, TSchema> };
    const members = [HiresPass.properties, UpscalePass.properties];
    const memberFields = new Set(members.flatMap((properties) => Object.keys(properties)));
    expect(new Set(Object.keys(flat.properties))).toEqual(memberFields);
    for (const properties of members) {
      for (const [name, schema] of Object.entries(properties)) {
        if (name === 'kind') continue;
        expect(JSON.stringify(flat.properties[name]), name).toBe(JSON.stringify(schema));
      }
    }
    expect(Pass[Kind]).toBe('Object');
  });
});

describe('field paths', () => {
  it('cover the schema in one grammar', () => {
    expect(REQUEST_PATHS.map((entry) => entry.path)).toEqual([
      'prompt.positive',
      'prompt.negative',
      'prompt.dialect_hint',
      ...INPUT_ROLES.flatMap((role) => [
        `inputs.${role}`,
        `inputs.${role}.asset_id`,
        `inputs.${role}.weight`,
        `inputs.${role}.region`,
        `inputs.${role}.crop`,
      ]),
      'subjects',
      'style',
      'geometry.width',
      'geometry.height',
      'geometry.frames',
      'geometry.fps',
      'geometry.duration_s',
      'sampling.seed',
      'sampling.steps',
      'sampling.cfg',
      'sampling.distilled_guidance',
      'sampling.image_cfg',
      'sampling.denoise',
      'sampling.clip_skip',
      'sampling.sampler',
      'sampling.scheduler',
      'sampling.eta',
      'sampling.flow_shift',
      'adapters.lora',
      'adapters.lora.id',
      'adapters.lora.weight',
      'adapters.lora.stage',
      'adapters.embedding',
      'adapters.embedding.id',
      'adapters.embedding.weight',
      'adapters.embedding.stage',
      'passes.hires',
      'passes.hires.scale',
      'passes.hires.target.width',
      'passes.hires.target.height',
      'passes.hires.steps',
      'passes.hires.denoise',
      'passes.hires.upscaler',
      'passes.upscale',
      'passes.upscale.scale',
      'passes.upscale.upscaler',
      'count',
      'audio.enabled',
      'audio.prompt',
    ]);
  });

  it('mark collections and experimental fields', () => {
    const collections = REQUEST_PATHS.filter((entry) => entry.kind === 'collection');
    expect(collections.map((entry) => entry.path)).toEqual([
      ...INPUT_ROLES.map((role) => `inputs.${role}`),
      'subjects',
      'adapters.lora',
      'adapters.embedding',
      'passes.hires',
      'passes.upscale',
    ]);
    const experimental = REQUEST_PATHS.filter((entry) => entry.experimental === true);
    expect(experimental.map((entry) => entry.path)).toEqual(['subjects', 'style']);
  });

  it('include the examples the plan names, and nothing for schema_version, mode or extensions', () => {
    for (const path of ['sampling.steps', 'inputs.ref.weight', 'passes.hires.scale', 'count']) {
      expect(REQUEST_PATH_SET.has(path), path).toBe(true);
    }
    for (const path of REQUEST_PATH_SET) {
      expect(path).not.toMatch(/^(schema_version|mode|extensions)\b/);
      expect(path).not.toMatch(/\.(role|kind)$|\.crop\.|\.region\./);
    }
    expect(REQUEST_PATH_SET.size).toBe(REQUEST_PATHS.length);
  });

  it('are generated from the schema', () => {
    expect(listRequestPaths()).toEqual(REQUEST_PATHS);
  });
});
