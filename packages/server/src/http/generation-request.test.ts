// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The canonical request under the daemon's own Ajv (rule 5), before any route
 * takes it as a body: it must compile there, refuse rather than repair, and
 * name the field at fault in the form the 422 `issues` use. The code-checked
 * rules are tested beside the schema; this file checks that the two halves
 * meet: schema issues and `checkGenerationRequest` issues share one path form.
 */

import {
  checkGenerationRequest,
  GENERATION_MODES,
  GenerationRequest,
  type GenerationMode,
  type GenerationRequest as Request,
  SEED_MAX,
} from '@bureaucromancer/lantern-schema';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { createValidator } from '../validation/ajv.js';
import { pathOfIssue } from '../validation/issues.js';

const validate = createValidator().compile(GenerationRequest);

/** The JSON pointers Ajv names, as the daemon's 422 reports them, in order and without repeats. */
function schemaIssuePaths(value: unknown): string[] {
  if (validate(value)) return [];
  return [...new Set((validate.errors ?? []).map((issue) => pathOfIssue(issue)))];
}

const ASSET_A = 'a'.repeat(64);
const ASSET_B = 'b'.repeat(64);

function minimal(mode: GenerationMode): Request {
  const request: Request = {
    schema_version: 1,
    mode,
    prompt: { positive: 'a lighthouse at dusk' },
    sampling: { seed: 'random' },
  };
  switch (mode) {
    case 'img2img':
    case 'vid_extend':
      return { ...request, inputs: [{ role: 'init', asset_id: ASSET_A }] };
    case 'inpaint':
      return {
        ...request,
        inputs: [
          { role: 'init', asset_id: ASSET_A },
          { role: 'mask', asset_id: ASSET_B },
        ],
      };
    case 'edit':
      return { ...request, inputs: [{ role: 'ref', asset_id: ASSET_A }] };
    case 'img2vid':
      return { ...request, inputs: [{ role: 'first_frame', asset_id: ASSET_A }] };
    case 'upscale':
      return {
        ...request,
        inputs: [{ role: 'init', asset_id: ASSET_A }],
        passes: [{ kind: 'upscale', scale: 2 }],
      };
    default:
      return request;
  }
}

const FULL: Request = {
  ...minimal('img2img'),
  prompt: { positive: 'a lighthouse', negative: 'blurry', dialect_hint: 'prose' },
  inputs: [
    { role: 'init', asset_id: ASSET_A, crop: { x: 0, y: 0, width: 0.5, height: 1 } },
    {
      role: 'control',
      asset_id: ASSET_B,
      weight: 0.8,
      region: { x: 0, y: 0, width: 1, height: 1 },
    },
  ],
  subjects: [{ label: 'Mara', references: [{ asset_id: ASSET_B }], descriptors: { hair: 'red' } }],
  style: { exemplars: [{ asset_id: ASSET_A }], text: 'ink wash' },
  geometry: { width: 1024, height: 768, frames: 1, fps: 24, duration_s: 1 },
  sampling: {
    seed: SEED_MAX,
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
  adapters: [{ kind: 'lora', id: 'detail', weight: -0.5, stage: 'low_noise' }],
  passes: [
    { kind: 'hires', target: { width: 2048, height: 1536 }, steps: 10, denoise: 0.3 },
    { kind: 'upscale', scale: 2, upscaler: 'RealESRGAN' },
  ],
  count: 2,
  audio: { enabled: true },
  extensions: { sdcpp: { slg: { scale: 2.5, layers: [7, 8, 9] }, vae_tiling: true, note: null } },
};

/** A deep copy of a request with one value replaced at a dotted path (array indexes as numbers). */
function withValue(request: Request, path: string, value: unknown): unknown {
  const copy: unknown = structuredClone(request);
  const keys = path.split('.');
  const last = keys.pop()!;
  let node = copy as Record<string, unknown>;
  for (const key of keys) node = node[key] as Record<string, unknown>;
  if (value === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the field under test
    delete node[last];
  } else {
    node[last] = value;
  }
  return copy;
}

describe("GenerationRequest under the daemon's Ajv", () => {
  it.each(GENERATION_MODES)(
    'accepts a minimal %s request, which also passes the code checks',
    (mode) => {
      const request = minimal(mode);
      expect(schemaIssuePaths(request)).toEqual([]);
      expect(checkGenerationRequest(request)).toEqual([]);
    },
  );

  it('accepts a request with every field set', () => {
    expect(schemaIssuePaths(FULL)).toEqual([]);
    expect(checkGenerationRequest(FULL)).toEqual([]);
  });

  it('rewrites nothing: no defaults filled, no fields removed, no types coerced', () => {
    const request = structuredClone(FULL);
    validate(request);
    expect(request).toEqual(FULL);
    const sparse = minimal('txt2img');
    validate(sparse);
    expect(sparse).toEqual(minimal('txt2img'));
  });

  it.each([
    ['', 'seed'],
    ['prompt', 'text'],
    ['inputs.0', 'strength'],
    ['inputs.0.crop', 'unit'],
    ['inputs.1.region', 'z'],
    ['subjects.0', 'pose'],
    ['subjects.0.references.0', 'weight'],
    ['subjects.0.descriptors', 'height'],
    ['style', 'strength'],
    ['geometry', 'aspect'],
    ['sampling', 'cfg_scale'],
    ['adapters.0', 'path'],
    ['passes.0', 'model'],
    ['passes.0.target', 'depth'],
    ['audio', 'voice'],
  ])('refuses an unknown field in %s, naming it', (at, field) => {
    const path = at === '' ? field : `${at}.${field}`;
    const pointer = `/${path.replaceAll('.', '/')}`;
    expect(schemaIssuePaths(withValue(FULL, path, 1))).toEqual([pointer]);
  });

  it('refuses an extensions key that is not a backend kind, but keeps any content under one', () => {
    const bad = withValue(FULL, 'extensions', { SD_CPP: {} });
    expect(schemaIssuePaths(bad)).toContain('/extensions/SD_CPP');
    expect(schemaIssuePaths(withValue(FULL, 'extensions.sdcpp', 'on'))).toEqual([
      '/extensions/sdcpp',
    ]);
    expect(schemaIssuePaths(withValue(FULL, 'extensions.comfy', { anything: [{}] }))).toEqual([]);
  });

  it.each([
    ['schema_version', undefined, '/schema_version'],
    ['schema_version', 2, '/schema_version'],
    ['mode', undefined, '/mode'],
    ['mode', 'refine', '/mode'],
    ['prompt', undefined, '/prompt'],
    ['prompt.positive', undefined, '/prompt/positive'],
    ['sampling', undefined, '/sampling'],
    ['sampling.seed', undefined, '/sampling/seed'],
    ['sampling.seed', 2 ** 53, '/sampling/seed'],
    ['sampling.seed', -1, '/sampling/seed'],
    ['sampling.seed', 7.5, '/sampling/seed'],
    ['sampling.seed', '42', '/sampling/seed'],
    ['sampling.steps', 0, '/sampling/steps'],
    ['sampling.denoise', 1.01, '/sampling/denoise'],
    ['sampling.denoise', -0.01, '/sampling/denoise'],
    ['sampling.clip_skip', 0, '/sampling/clip_skip'],
    ['sampling.clip_skip', -2, '/sampling/clip_skip'],
    ['sampling.cfg', '7', '/sampling/cfg'],
    ['inputs.0.role', 'init_image', '/inputs/0/role'],
    ['inputs.0.asset_id', 'A'.repeat(64), '/inputs/0/asset_id'],
    ['inputs.0.asset_id', 'a'.repeat(63), '/inputs/0/asset_id'],
    ['inputs.0.crop.x', 1.5, '/inputs/0/crop/x'],
    ['inputs.0.crop.height', undefined, '/inputs/0/crop/height'],
    ['geometry.width', 0, '/geometry/width'],
    ['geometry.fps', 0, '/geometry/fps'],
    ['adapters.0.kind', 'hypernetwork', '/adapters/0/kind'],
    ['adapters.0.weight', undefined, '/adapters/0/weight'],
    ['adapters.0.stage', 'refiner', '/adapters/0/stage'],
    ['passes.0.kind', 'face_fix', '/passes/0/kind'],
    ['passes.1.scale', 0, '/passes/1/scale'],
    ['count', 0, '/count'],
    ['count', 1.5, '/count'],
    ['audio.enabled', undefined, '/audio/enabled'],
  ])('refuses %s = %j at %s', (path, value, pointer) => {
    expect(schemaIssuePaths(withValue(FULL, path, value))).toEqual([pointer]);
  });

  it('refuses a seed above 2^53 even after JSON parsing rounds it', () => {
    const body = JSON.stringify(FULL).replace(
      `"seed":${String(SEED_MAX)}`,
      '"seed":9007199254740993',
    );
    expect(body).toContain('9007199254740993');
    expect(schemaIssuePaths(JSON.parse(body))).toEqual(['/sampling/seed']);
  });

  it('reports schema and code issues in one path form', () => {
    const request = withValue(minimal('inpaint'), 'inputs', [
      { role: 'init', asset_id: ASSET_A, crop: { x: 0.5, y: 0, width: 0.75, height: 1 } },
    ]) as Request;
    expect(schemaIssuePaths(request)).toEqual([]);
    expect(checkGenerationRequest(request).map((issue) => issue.path)).toEqual([
      '/inputs/0/crop/width',
      '/inputs',
    ]);
    // An upscale pass carrying a hires field passes the wire schema; the code check names it.
    const upscale = withValue(minimal('upscale'), 'passes', [
      { kind: 'upscale', scale: 2, denoise: 0.2 },
    ]) as Request;
    expect(schemaIssuePaths(upscale)).toEqual([]);
    expect(checkGenerationRequest(upscale).map((issue) => issue.path)).toEqual([
      '/passes/0/denoise',
    ]);
  });

  it('survives response serialisation whole, extensions included', async () => {
    const app = Fastify();
    app.get('/echo', { schema: { response: { 200: GenerationRequest } } }, () => FULL);
    const response = await app.inject({ method: 'GET', url: '/echo' });
    await app.close();
    expect(response.json()).toEqual(FULL);
  });
});
