// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The resolver end to end over the built-in profiles: precedence, seeds,
 * route choice, refusals with suggestions, the field report, warnings,
 * finalising at dispatch and the re-run actions. Whole resolutions are
 * snapshotted with a fixed seed source, so any change to what a request
 * resolves to shows up in review.
 */

import {
  checkGenerationRequest,
  type GenerationRequest,
  type RouteDescriptor,
} from '@bureaucromancer/lantern-schema';
import { describe, expect, it, vi } from 'vitest';

import { createValidator } from '../../validation/ajv.js';
import { createRequestValidator } from '../descriptor/index.js';
import { fillDefaults } from './fill.js';
import { anotherRoute, reproduce, reroll } from './rerun.js';
import {
  ASSET_A,
  ASSET_B,
  deepFreeze,
  descriptor,
  IMG2IMG,
  img2img,
  model,
  route,
  seeds,
  testResolver,
  TXT2IMG,
  txt2img,
} from './test-resolver.js';
import type { Resolution, ResolveFailure, ResolveInput, ResolveOutcome } from './types.js';

function resolved(outcome: ResolveOutcome): Resolution {
  if (!outcome.ok) throw new Error(`Expected a resolution, got ${JSON.stringify(outcome.failure)}`);
  return outcome.resolution;
}

function refused(outcome: ResolveOutcome): ResolveFailure {
  if (outcome.ok) throw new Error('Expected a refusal, got a resolution');
  return outcome.failure;
}

function resolve(input: ResolveInput, resolver = testResolver()): Resolution {
  return resolved(resolver.resolve(input));
}

function issuesOf(outcome: ResolveOutcome) {
  const failure = refused(outcome);
  if (failure.kind !== 'invalid') throw new Error(`Expected invalid, got ${failure.kind}`);
  return failure.issues;
}

describe('a whole resolution', () => {
  it('writes out every value, reports every leaf, and warns', () => {
    const request = txt2img({
      prompt: { positive: 'a lighthouse at dusk', negative: 'blurry' },
      sampling: { seed: 'random', cfg: 1, distilled_guidance: 3.5 },
      adapters: [{ kind: 'lora', id: 'film-grain', weight: 0.4 }],
      passes: [
        { kind: 'hires', target: { width: 2048, height: 2048 } },
        { kind: 'hires', scale: 1.5, steps: 12 },
      ],
      count: 6,
      extensions: { sdcpp: { slg_scale: 2.5 }, comfy: { anything: [1, null] } },
    });
    expect(resolve({ request, model: model() })).toMatchSnapshot();
  });

  it('resolves img2img, leaving the size to the init image', () => {
    const request = img2img({
      inputs: [
        { role: 'init', asset_id: ASSET_A, crop: { x: 0, y: 0, width: 0.5, height: 1 } },
        { role: 'control', asset_id: ASSET_B },
        { role: 'control', asset_id: ASSET_A, weight: 1.5 },
      ],
    });
    expect(resolve({ request, model: model() })).toMatchSnapshot();
  });
});

describe('precedence (A3): request > preset > model overrides > profile > descriptor default', () => {
  const steps = (resolution: Resolution) => resolution.field_report['/sampling/steps'];

  it.each([
    [
      'the request',
      { sampling: { seed: 1, steps: 30 } },
      { 'sampling.steps': 25 },
      { 'sampling.steps': 22 },
      'sdxl',
    ],
    ['a preset', {}, { 'sampling.steps': 25 }, { 'sampling.steps': 22 }, 'sdxl'],
    ['the model overrides', {}, {}, { 'sampling.steps': 22 }, 'sdxl'],
    ['the profile (sdxl: 40)', {}, {}, {}, 'sdxl'],
    ['the descriptor default (flux2-klein gives no steps)', {}, {}, {}, 'flux2-klein'],
  ] as const)('takes the value from %s', (_label, parts, preset, overrides, family) => {
    const resolution = resolve({
      request: txt2img(parts),
      model: model(family, [route('rt_a')], { profile_overrides: { txt2img: overrides } }),
      preset,
    });
    expect(steps(resolution)).toMatchSnapshot();
  });

  it('passes over a lower layer’s value the route can’t take, with a warning', () => {
    const resolution = resolve({
      request: txt2img(),
      model: model('sdxl', [route('rt_a')], {
        profile_overrides: { txt2img: { 'sampling.steps': 22 } },
      }),
      preset: { 'sampling.steps': 999, 'sampling.sampler': 'lms' },
    });
    expect(steps(resolution)).toMatchObject({ source: 'model', used: 22 });
    expect(resolution.field_report['/sampling/sampler']).toMatchObject({
      source: 'descriptor',
      used: 'euler',
    });
    expect(resolution.warnings.filter((w) => w.code === 'default_refused')).toMatchSnapshot();
  });

  it('applies a collection field’s default to every item, never over an item’s own value', () => {
    const resolution = resolve({
      request: img2img({
        inputs: [
          { role: 'init', asset_id: ASSET_A },
          { role: 'control', asset_id: ASSET_B },
          { role: 'control', asset_id: ASSET_A, weight: 1.5 },
        ],
      }),
      model: model(),
      preset: { 'inputs.control.weight': 0.6 },
    });
    expect(resolution.effective.inputs).toEqual([
      { role: 'init', asset_id: ASSET_A },
      { role: 'control', asset_id: ASSET_B, weight: 0.6 },
      { role: 'control', asset_id: ASSET_A, weight: 1.5 },
    ]);
    expect(resolution.field_report['/inputs/1/weight']).toMatchObject({ source: 'preset' });
    expect(resolution.field_report['/inputs/2/weight']).toMatchObject({ source: 'request' });
  });

  it('never gives an init input a weight, nor a hires pass both a scale and a target', () => {
    const resolution = resolve({
      request: txt2img({ passes: [{ kind: 'hires', target: { width: 2048, height: 2048 } }] }),
      model: model(),
    });
    expect(resolution.effective.passes).toEqual([
      { kind: 'hires', target: { width: 2048, height: 2048 }, steps: 10, denoise: 0.5 },
    ]);
    const withInit = resolve({ request: img2img(), model: model() });
    expect(withInit.effective.inputs).toEqual([{ role: 'init', asset_id: ASSET_A }]);
  });

  it('leaves the size to the init image where the mode derives it (A4)', () => {
    const resolution = resolve({ request: img2img(), model: model() });
    expect(resolution.effective.geometry).toBeUndefined();
    expect(resolve({ request: txt2img(), model: model() }).effective.geometry).toEqual({
      width: 1024,
      height: 1024,
    });
  });

  it('takes out an object it could not complete, so effective stays valid', () => {
    const mode = { ...TXT2IMG, fields: { ...TXT2IMG.fields } };
    const filled = fillDefaults(txt2img(), mode, {
      preset: {},
      model: { 'geometry.width': 512 },
      profile: {},
    });
    expect(filled.effective.geometry).toBeUndefined();
    expect([...filled.sources.keys()]).not.toContain('/geometry/width');
  });

  it('fills nothing the route ignores', () => {
    const resolution = resolve({
      request: txt2img(),
      model: model('flux1-dev'),
    });
    // flux1-dev's profile gives distilled_guidance; this route ignores it.
    expect(resolution.effective.sampling.distilled_guidance).toBeUndefined();
    expect(resolution.field_report['/sampling/cfg']).toMatchObject({ source: 'profile', used: 1 });
  });

  it('falls back to one output when nothing gives a count', () => {
    expect(resolve({ request: txt2img(), model: model() }).field_report['/count']).toEqual({
      field: 'count',
      state: 'native',
      source: 'builtin',
      used: 1,
    });
  });
});

describe('seeds (A1)', () => {
  it('draws one for "random", in [0, 2^32), and reports it as drawn', () => {
    const source = seeds(4_000_000_000);
    const resolution = resolve({ request: txt2img(), model: model() }, testResolver(source));
    expect(source.limits).toEqual([2 ** 32]);
    expect(resolution.effective.sampling.seed).toBe(4_000_000_000);
    expect(resolution.canonical.sampling.seed).toBe('random');
    expect(resolution.field_report['/sampling/seed']).toEqual({
      field: 'sampling.seed',
      state: 'native',
      source: 'drawn',
      requested: 'random',
      used: 4_000_000_000,
    });
    expect(resolution.plan).toEqual([{ route: 'rt_a', count: 1, seed: 4_000_000_000 }]);
  });

  it('keeps a seed the request gives, and draws nothing', () => {
    const source = seeds(7);
    const resolution = resolve(
      { request: txt2img({ sampling: { seed: 2 ** 53 - 1 } }), model: model() },
      testResolver(source),
    );
    expect(source.limits).toEqual([]);
    expect(resolution.effective.sampling.seed).toBe(2 ** 53 - 1);
    expect(resolution.field_report['/sampling/seed']).toMatchObject({ source: 'request' });
  });

  it('never writes to the request it is given', () => {
    const request = deepFreeze(
      img2img({
        inputs: [
          { role: 'init', asset_id: ASSET_A },
          { role: 'control', asset_id: ASSET_B },
        ],
      }),
    );
    const before = structuredClone(request);
    const resolution = resolve({ request, model: model() });
    expect(request).toEqual(before);
    expect(resolution.canonical).toBe(request);
    expect(resolution.effective).not.toBe(request);
  });

  it('draws within a route’s narrower seed range', () => {
    const narrow = route('rt_a', {
      descriptor: descriptor('rt_a', {
        txt2img: {
          ...TXT2IMG,
          fields: {
            ...TXT2IMG.fields,
            'sampling.seed': { state: 'native', minimum: 10, maximum: 999 },
          },
        },
      }),
    });
    const source = seeds(5);
    const resolution = resolve(
      { request: txt2img(), model: model('sdxl', [narrow]) },
      testResolver(source),
    );
    expect(source.limits).toEqual([990]);
    expect(resolution.effective.sampling.seed).toBe(15);
  });

  it('refuses a seed source that draws out of range', () => {
    expect(() =>
      resolve({ request: txt2img(), model: model() }, testResolver(seeds(2 ** 32))),
    ).toThrow(RangeError);
    expect(() => resolve({ request: txt2img(), model: model() }, testResolver(seeds(0.5)))).toThrow(
      RangeError,
    );
  });

  it('is deterministic for a fixed seed source', () => {
    const input = { request: txt2img(), model: model() };
    expect(resolve(input, testResolver(seeds(99)))).toEqual(
      resolve(input, testResolver(seeds(99))),
    );
  });
});

describe('route choice', () => {
  const by = (resolution: Resolution) => ({
    route: resolution.route.id,
    skipped: resolution.skipped_routes,
    blocked: resolution.blocked_reason,
  });

  const img2imgless = descriptor('x', { txt2img: TXT2IMG });
  const stepsUpTo10 = (id: string): RouteDescriptor =>
    descriptor(id, {
      txt2img: {
        ...TXT2IMG,
        fields: { ...TXT2IMG.fields, 'sampling.steps': { state: 'native', maximum: 10 } },
      },
    });

  it.each([
    [
      'the highest priority',
      [route('rt_low', { priority: 1 }), route('rt_high', { priority: 5 })],
      img2img(),
    ],
    ['ties by id', [route('rt_b'), route('rt_a')], txt2img()],
    [
      'a cold route, which is healthy (L2)',
      [
        route('rt_cold', { priority: 5, health: { status: 'ok', load_state: 'cold' } }),
        route('rt_warm', { priority: 1 }),
      ],
      txt2img(),
    ],
    [
      'a degraded route over a lower one',
      [
        route('rt_slow', { priority: 5, health: { status: 'degraded', load_state: 'loaded' } }),
        route('rt_b'),
      ],
      txt2img(),
    ],
    [
      'past a down route',
      [
        route('rt_down', { priority: 5, health: { status: 'down', load_state: 'unknown' } }),
        route('rt_up', { priority: 1 }),
      ],
      txt2img(),
    ],
    [
      'past a route without the mode',
      [route('rt_txt', { priority: 5, descriptor: img2imgless }), route('rt_both')],
      img2img(),
    ],
    [
      'past a route the request does not validate on',
      [route('rt_narrow', { priority: 5, descriptor: stepsUpTo10('rt_narrow') }), route('rt_wide')],
      txt2img({ sampling: { seed: 1, steps: 30 } }),
    ],
    [
      'a down route when no healthy one takes the request, blocked (A12)',
      [
        route('rt_down', {
          priority: 1,
          health: { status: 'down', load_state: 'unknown', detail: 'refused' },
        }),
        route('rt_narrow', { priority: 5, descriptor: stepsUpTo10('rt_narrow') }),
      ],
      txt2img({ sampling: { seed: 1, steps: 30 } }),
    ],
  ])('chooses %s', (_label, routes, request) => {
    expect(by(resolve({ request, model: model('sdxl', routes) }))).toMatchSnapshot();
  });

  it('takes the route asked for, even below another', () => {
    const routes = [route('rt_high', { priority: 5 }), route('rt_low')];
    expect(
      resolve({ request: txt2img(), model: model('sdxl', routes), route: 'rt_low' }).route.id,
    ).toBe('rt_low');
  });

  it('takes a down route asked for, and says it would wait', () => {
    const routes = [route('rt_down', { health: { status: 'down', load_state: 'unknown' } })];
    const resolution = resolve({
      request: txt2img(),
      model: model('sdxl', routes),
      route: 'rt_down',
    });
    expect(resolution.blocked_reason).toEqual({
      code: 'routes_down',
      detail: 'Route rt_down is down.',
    });
    expect(resolution.warnings.map((w) => w.code)).toContain('route_down');
  });

  it.each([
    ['an unknown route', model(), 'rt_nope', { kind: 'unknown_route', route: 'rt_nope' }],
    ['a model with no routes', model('sdxl', []), undefined, { kind: 'no_routes' }],
  ])('refuses %s', (_label, m, routeId, expected) => {
    const input = {
      request: txt2img(),
      model: m,
      ...(routeId === undefined ? {} : { route: routeId }),
    };
    expect(refused(testResolver().resolve(input))).toEqual(expected);
  });

  it('refuses when no route takes the request, with the first route’s issues and every skip', () => {
    const routes = [
      route('rt_img', { priority: 9, descriptor: descriptor('rt_img', { img2img: IMG2IMG }) }),
      route('rt_narrow', { priority: 5, descriptor: stepsUpTo10('rt_narrow') }),
      route('rt_down', {
        priority: 1,
        health: { status: 'down', load_state: 'unknown' },
        descriptor: stepsUpTo10('rt_down'),
      }),
    ];
    const failure = refused(
      testResolver().resolve({
        request: txt2img({ sampling: { seed: 1, steps: 30 } }),
        model: model('sdxl', routes),
      }),
    );
    expect(failure).toMatchSnapshot();
  });

  it('refuses a mode no route serves, at /mode', () => {
    const routes = [route('rt_txt', { descriptor: img2imgless })];
    expect(
      issuesOf(testResolver().resolve({ request: img2img(), model: model('sdxl', routes) })),
    ).toEqual([{ path: '/mode', message: 'no route of model mdl_sdxl serves img2img' }]);
    expect(
      issuesOf(
        testResolver().resolve({
          request: img2img(),
          model: model('sdxl', routes),
          route: 'rt_txt',
        }),
      ),
    ).toEqual([{ path: '/mode', message: 'route rt_txt does not serve img2img' }]);
  });

  it('refuses a mode the profile does not support, at /mode', () => {
    expect(
      issuesOf(
        testResolver().resolve({
          request: { ...txt2img(), mode: 'edit', inputs: [{ role: 'ref', asset_id: ASSET_A }] },
          model: model(),
        }),
      ),
    ).toEqual([{ path: '/mode', message: 'Stable Diffusion XL 1.0 does not support edit' }]);
  });

  it('throws on a model whose profile is not loaded: a catalog bug, not a bad request', () => {
    expect(() =>
      testResolver().resolve({ request: txt2img(), model: model('no-such-family') }),
    ).toThrow(/not loaded/);
  });
});

describe('refusals (422) never change a value, and suggest one (A3)', () => {
  it.each([
    ['steps over the route’s maximum', txt2img({ sampling: { seed: 1, steps: 200 } })],
    ['steps under the schema’s minimum', txt2img({ sampling: { seed: 1, steps: 0 } })],
    ['a width off the route’s multiple', txt2img({ geometry: { width: 1000, height: 1024 } })],
    ['a sampler the route does not offer', txt2img({ sampling: { seed: 1, sampler: 'lms' } })],
    ['a count over the emulated maximum', txt2img({ count: 20 })],
    [
      'a LoRA weight out of range',
      txt2img({ adapters: [{ kind: 'lora', id: 'film-grain', weight: 3 }] }),
    ],
    [
      'a LoRA the route does not offer',
      txt2img({ adapters: [{ kind: 'lora', id: 'nope', weight: 1 }] }),
    ],
    [
      'a control weight on an item',
      img2img({
        inputs: [
          { role: 'init', asset_id: ASSET_A },
          { role: 'control', asset_id: ASSET_B, weight: 2.5 },
        ],
      }),
    ],
    ['an unknown field', { ...txt2img(), colour: 'teal' }],
    ['a field the route does not list', txt2img({ sampling: { seed: 1, image_cfg: 2 } })],
    ['a missing init image', { ...img2img(), inputs: [] }],
    [
      'an init image with a weight',
      img2img({ inputs: [{ role: 'init', asset_id: ASSET_A, weight: 1 }] }),
    ],
    ['a seed beyond 2^53 − 1', txt2img({ sampling: { seed: 2 ** 53 } })],
  ])('%s', (_label, request) => {
    expect(issuesOf(testResolver().resolve({ request, model: model() }))).toMatchSnapshot();
  });
});

describe('the field report', () => {
  it('reports a value the route ignores as ignored, keeps it, and says why', () => {
    const resolution = resolve({
      request: txt2img({ sampling: { seed: 1, distilled_guidance: 3.5 } }),
      model: model(),
    });
    expect(resolution.effective.sampling.distilled_guidance).toBe(3.5);
    expect(resolution.field_report['/sampling/distilled_guidance']).toEqual({
      field: 'sampling.distilled_guidance',
      state: 'ignored',
      source: 'request',
      requested: 3.5,
      reason: 'Not used by this model family',
    });
  });

  it('reports extensions for another backend kind as ignored, never refused (A11)', () => {
    const resolution = resolve({
      request: txt2img({ extensions: { comfy: { node: 3 }, sdcpp: { slg_scale: 1 } } }),
      model: model(),
    });
    expect(resolution.field_report['/extensions/comfy']).toMatchObject({
      state: 'ignored',
      reason: 'Extensions for another backend kind (`comfy`); this route is `sdcpp`.',
    });
    expect(resolution.field_report['/extensions/sdcpp']).toMatchObject({
      state: 'native',
      used: { slg_scale: 1 },
    });
  });

  it('still checks extensions for the route’s own kind', () => {
    expect(
      issuesOf(
        testResolver().resolve({
          request: txt2img({ extensions: { sdcpp: { slg_scale: -1 } } }),
          model: model(),
        }),
      ),
    ).toEqual([{ path: '/extensions/sdcpp/slg_scale', message: 'must be >= 0' }]);
  });

  it('weakens a field to its collection’s state, and reports an emulated crop', () => {
    const resolution = resolve({
      request: img2img({
        inputs: [
          { role: 'init', asset_id: ASSET_A, crop: { x: 0, y: 0, width: 1, height: 0.5 } },
          { role: 'control', asset_id: ASSET_B },
        ],
      }),
      model: model(),
    });
    expect(resolution.field_report['/inputs/0/crop']).toMatchObject({ state: 'emulated' });
    expect(resolution.field_report['/inputs/1/asset_id']).toMatchObject({
      state: 'emulated',
      reason: 'Applied by a second pass',
    });
  });

  it('reports a count above the backend’s own maximum as emulated', () => {
    expect(
      resolve({ request: txt2img({ count: 6 }), model: model() }).field_report['/count'],
    ).toMatchObject({
      state: 'emulated',
      requested: 6,
      used: 6,
    });
    expect(
      resolve({ request: txt2img({ count: 4 }), model: model() }).field_report['/count'],
    ).toMatchObject({
      state: 'native',
    });
  });

  it('reports every leaf of effective, and nothing else', () => {
    const resolution = resolve({ request: txt2img({ count: 2 }), model: model() });
    expect(Object.keys(resolution.field_report)).toEqual([
      '/prompt/positive',
      '/geometry/width',
      '/geometry/height',
      '/sampling/seed',
      '/sampling/steps',
      '/sampling/cfg',
      '/sampling/sampler',
      '/sampling/scheduler',
      '/count',
    ]);
  });
});

describe('profile warnings, evaluated on effective', () => {
  it.each([
    [
      'sdxl, negative at cfg 1',
      'sdxl',
      txt2img({ prompt: { positive: 'x', negative: 'blurry' }, sampling: { seed: 1, cfg: 1 } }),
    ],
    [
      'sdxl, negative at cfg 7: none',
      'sdxl',
      txt2img({ prompt: { positive: 'x', negative: 'blurry' }, sampling: { seed: 1, cfg: 7 } }),
    ],
    ['sdxl, cfg 1 and no negative: none', 'sdxl', txt2img({ sampling: { seed: 1, cfg: 1 } })],
    [
      'flux1-schnell, negative at its default cfg',
      'flux1-schnell',
      txt2img({ prompt: { positive: 'x', negative: 'blurry' } }),
    ],
    ['flux1-schnell, steps above 4', 'flux1-schnell', txt2img({ sampling: { seed: 1, steps: 6 } })],
    [
      'sdxl-turbo img2img, steps × denoise under one',
      'sdxl-turbo',
      img2img({ sampling: { seed: 1, steps: 2, denoise: 0.4 } }),
    ],
    ['sdxl-turbo img2img at its defaults: none', 'sdxl-turbo', img2img()],
  ])('%s', (_label, family, request) => {
    expect(resolve({ request, model: model(family) }).warnings).toMatchSnapshot();
  });
});

describe('effective', () => {
  const validator = createValidator();
  const cases: [string, GenerationRequest][] = [
    ['txt2img', txt2img()],
    [
      'txt2img with passes',
      txt2img({
        passes: [{ kind: 'hires', scale: 2 }],
        adapters: [{ kind: 'lora', id: 'detail-tweaker', weight: 1 }],
      }),
    ],
    [
      'img2img',
      img2img({
        inputs: [
          { role: 'init', asset_id: ASSET_A },
          { role: 'control', asset_id: ASSET_B },
        ],
      }),
    ],
  ];

  it.each(cases)('%s re-validates on its route, and resolves to itself (A2)', (_label, request) => {
    const resolution = resolve({ request, model: model() });
    const { effective } = resolution;
    expect(checkGenerationRequest(effective)).toEqual([]);
    expect(
      createRequestValidator(validator, descriptor('rt_a'), effective.mode)(effective),
    ).toEqual([]);
    expect(typeof effective.sampling.seed).toBe('number');
    const again = resolve({ request: effective, model: model() });
    expect(again.effective).toEqual(effective);
    expect(Object.values(again.field_report).every((entry) => entry.source === 'request')).toBe(
      true,
    );
  });

  it('keeps its keys in schema order', () => {
    const { effective } = resolve({ request: txt2img({ count: 2 }), model: model() });
    expect(Object.keys(effective)).toEqual([
      'schema_version',
      'mode',
      'prompt',
      'geometry',
      'sampling',
      'count',
    ]);
    expect(Object.keys(effective.sampling)).toEqual([
      'seed',
      'steps',
      'cfg',
      'sampler',
      'scheduler',
    ]);
  });
});

describe('finalise at dispatch (A12)', () => {
  const fingerprint = { kind: 'file', path: '/models/sdxl.safetensors', stem: 'sdxl' } as const;
  const submitted = () =>
    resolve(
      {
        request: txt2img({ sampling: { seed: 'random', steps: 30 } }),
        model: model('sdxl', [route('rt_a', { fingerprint })]),
      },
      testResolver(seeds(77)),
    );

  it('re-runs on the same route with the seed drawn at submit', async () => {
    const source = seeds(5);
    const outcome = await testResolver(source).finalise(
      submitted(),
      model('sdxl', [route('rt_a', { fingerprint, health: { status: 'ok', load_state: 'cold' } })]),
    );
    if (!outcome.ok) throw new Error('expected ok');
    expect(source.limits).toEqual([]);
    expect(outcome.resolution.provisional).toBe(false);
    expect(outcome.resolution.effective.sampling.seed).toBe(77);
    expect(outcome.resolution.field_report['/sampling/seed']).toMatchObject({
      source: 'drawn',
      requested: 'random',
    });
    expect(outcome.resolution.route.health.load_state).toBe('cold');
    expect(outcome).not.toHaveProperty('wire');
  });

  it('calls the prepare hook with the finalised request', async () => {
    const prepare = vi.fn((routeId: string, effective: GenerationRequest) =>
      Promise.resolve({ route: routeId, seed: effective.sampling.seed }),
    );
    const outcome = await testResolver().finalise(
      submitted(),
      model('sdxl', [route('rt_a', { fingerprint })]),
      {
        prepare: { prepare },
      },
    );
    expect(prepare).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({ ok: true, wire: { route: 'rt_a', seed: 77 } });
  });

  it.each([
    ['the route is gone', model('sdxl', [route('rt_b', { fingerprint })]), 'route_missing'],
    [
      'the route is down',
      model('sdxl', [
        route('rt_a', { fingerprint, health: { status: 'down', load_state: 'unknown' } }),
      ]),
      'routes_down',
    ],
    [
      'the route serves another model file',
      model('sdxl', [route('rt_a', { fingerprint: { ...fingerprint, stem: 'other' } })]),
      'identity_changed',
    ],
    [
      'the route no longer identifies its model',
      model('sdxl', [route('rt_a')]),
      'identity_changed',
    ],
    [
      'the request no longer validates',
      model('sdxl', [
        route('rt_a', {
          fingerprint,
          descriptor: descriptor('rt_a', {
            txt2img: {
              ...TXT2IMG,
              fields: { ...TXT2IMG.fields, 'sampling.steps': { state: 'native', maximum: 10 } },
            },
          }),
        }),
      ]),
      'request_invalid',
    ],
  ])('blocks when %s', async (_label, now, code) => {
    const outcome = await testResolver().finalise(submitted(), now);
    expect(outcome).toMatchObject({ ok: false, blocked_reason: { code } });
  });
});

describe('re-runs (A11)', () => {
  const routes = [
    route('rt_a', { priority: 5 }),
    route('rt_b', {
      backend_kind: 'comfy',
      descriptor: descriptor('rt_b', {
        txt2img: { ...TXT2IMG, extensions: { comfy: { type: 'object' } } },
      }),
    }),
  ];
  const m = model('sdxl', routes);
  const job = () => {
    const resolution = resolve(
      { request: txt2img({ extensions: { sdcpp: { slg_scale: 1 } } }), model: m },
      testResolver(seeds(42)),
    );
    return {
      canonical: resolution.canonical,
      effective: resolution.effective,
      route: resolution.route.id,
    };
  };

  it('reproduce submits effective on the same route', () => {
    const source = job();
    const again = resolved(reproduce(testResolver(seeds(9)), source, m));
    expect(again.effective).toEqual(source.effective);
    expect(again.route.id).toBe('rt_a');
  });

  it('re-roll draws a new seed, never the old one', () => {
    const source = job();
    const again = resolved(reroll(testResolver(seeds(42, 42, 43)), source, m));
    expect(again.effective.sampling.seed).toBe(43);
    expect({ ...again.effective, sampling: { ...again.effective.sampling, seed: 42 } }).toEqual(
      source.effective,
    );
  });

  it('another route starts from canonical with the job’s seed, and ignores the other kind’s extensions', () => {
    const again = resolved(anotherRoute(testResolver(seeds(9)), job(), m));
    expect(again.route.id).toBe('rt_b');
    expect(again.effective.sampling.seed).toBe(42);
    expect(again.field_report['/extensions/sdcpp']).toMatchObject({ state: 'ignored' });
    expect(again.field_report['/sampling/steps']).toMatchObject({ source: 'profile' });
  });

  it('another route may name the route', () => {
    expect(resolved(anotherRoute(testResolver(), job(), m, 'rt_a')).route.id).toBe('rt_a');
  });
});
