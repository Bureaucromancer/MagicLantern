// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The merge rules (A6) as a table: for each layer, what it may do (applied,
 * no note) and what it may not (refused, or applied only in part, with a note
 * at the entry). Every result must still pass the descriptor checks.
 */

import {
  checkRouteDescriptor,
  type DescriptorLayer,
  type LayerSource,
  type ModeDescriptor,
  type ModeLayer,
  type RouteDescriptor,
} from '@bureaucromancer/lantern-schema';
import { describe, expect, it } from 'vitest';

import { applyLayer, InvalidDescriptorError, mergeDescriptor, profileLayer } from './merge.js';
import { ROUTE } from './test-descriptors.js';

const T = '/modes/txt2img';

function layerFor(txt2img: ModeLayer): DescriptorLayer {
  return { modes: { txt2img } };
}

function apply(source: LayerSource, txt2img: ModeLayer) {
  const result = applyLayer(ROUTE, layerFor(txt2img), source);
  expect(checkRouteDescriptor(result.descriptor)).toEqual([]);
  return {
    mode: result.descriptor.modes.txt2img!,
    notes: result.notes.map((note) => note.path),
    messages: result.notes.map((note) => note.message),
    descriptor: result.descriptor,
  };
}

type Case = [
  name: string,
  layer: ModeLayer,
  select: (mode: ModeDescriptor) => unknown,
  expected: unknown,
  notes: string[],
];

const steps = (m: ModeDescriptor) => m.fields['sampling.steps'];
const sampler = (m: ModeDescriptor) => m.fields['sampling.sampler']?.enum;
const loraIds = (m: ModeDescriptor) => m.adapters?.lora?.options?.map((option) => option.id);

describe('probe: may only demote', () => {
  it.each<Case>([
    [
      'native → emulated, with a reason',
      { fields: { 'sampling.eta': { state: 'emulated', reason: 'Applied by Lantern' } } },
      (m) => m.fields['sampling.eta'],
      { state: 'emulated', reason: 'Applied by Lantern' },
      [],
    ],
    [
      'native → ignored, which drops narrowing and default',
      { fields: { 'sampling.steps': { state: 'ignored' } } },
      steps,
      { state: 'ignored' },
      [],
    ],
    [
      'an optional field → absent',
      { fields: { 'prompt.negative': { state: 'absent' } } },
      (m) => 'prompt.negative' in m.fields,
      false,
      [],
    ],
    [
      'a collection → absent, its fields with it',
      { adapters: { lora: { state: 'absent' } } },
      (m) => [m.adapters, Object.keys(m.fields).filter((path) => path.startsWith('adapters.'))],
      [undefined, []],
      [],
    ],
    [
      'control down',
      { control: { cancel_queued: false, progress: 'none' } },
      (m) => m.control,
      { cancel_queued: false, cancel_running: false, progress: 'none' },
      [],
    ],
    [
      'not promote',
      { fields: { 'sampling.distilled_guidance': { state: 'native' } } },
      (m) => m.fields['sampling.distilled_guidance']?.state,
      'ignored',
      [`${T}/fields/sampling.distilled_guidance/state`],
    ],
    [
      'not narrow',
      { fields: { 'sampling.steps': { maximum: 50 } } },
      (m) => steps(m)?.maximum,
      150,
      [`${T}/fields/sampling.steps/maximum`],
    ],
    [
      'not change limits',
      { fields: { count: { native_max: 4 } }, adapters: { lora: { max: 1 } } },
      (m) => [m.fields['count']?.native_max, m.adapters?.lora?.max],
      [8, 2],
      [`${T}/fields/count/native_max`, `${T}/adapters/lora/max`],
    ],
    [
      'not add a field',
      { fields: { 'sampling.flow_shift': { state: 'native' } } },
      (m) => 'sampling.flow_shift' in m.fields,
      false,
      [`${T}/fields/sampling.flow_shift`],
    ],
    [
      'not add a collection',
      { inputs: { ref: { state: 'native' } } },
      (m) => m.inputs,
      undefined,
      [`${T}/inputs/ref`],
    ],
    [
      'not turn control up',
      { control: { cancel_running: true, progress: 'fraction' } },
      (m) => m.control,
      ROUTE.modes.txt2img!.control,
      [`${T}/control/cancel_running`, `${T}/control/progress`],
    ],
    [
      'not set a default',
      { fields: { 'sampling.steps': { default: 30 } } },
      (m) => steps(m)?.default,
      20,
      [`${T}/fields/sampling.steps/default`],
    ],
    [
      'not change a reason without a state',
      { fields: { 'sampling.distilled_guidance': { reason: 'Something else' } } },
      (m) => m.fields['sampling.distilled_guidance']?.reason,
      'Not used by this model family',
      [`${T}/fields/sampling.distilled_guidance/reason`],
    ],
    [
      'not remove a required field',
      { fields: { 'sampling.seed': { state: 'absent' } } },
      (m) => m.fields['sampling.seed'],
      { state: 'native' },
      [`${T}/fields/sampling.seed`],
    ],
    [
      'not touch options or extensions',
      {
        adapters: { lora: { options: [{ id: 'x' }] } },
        extensions: { comfy: { type: 'object' } },
      },
      (m) => [loraIds(m), Object.keys(m.extensions ?? {})],
      [['detail-tweaker', 'film-grain'], ['sdcpp']],
      [`${T}/extensions/comfy`, `${T}/adapters/lora/options`],
    ],
  ])('%s', (_name, layer, select, expected, notes) => {
    const result = apply('probe', layer);
    expect(select(result.mode)).toEqual(expected);
    expect(result.notes).toEqual(notes);
  });

  it('may remove a mode, and not add one', () => {
    const removed = applyLayer(ROUTE, { modes: { img2img: { state: 'absent' } } }, 'probe');
    expect(Object.keys(removed.descriptor.modes)).toEqual(['txt2img']);
    expect(removed.notes).toEqual([]);
    const added = applyLayer(
      ROUTE,
      { modes: { txt2vid: { control: ROUTE.modes.txt2img!.control } } },
      'probe',
    );
    expect(added.descriptor).toEqual(ROUTE);
    expect(added.notes.map((note) => note.path)).toEqual(['/modes/txt2vid']);
  });
});

describe('override: may only add or widen', () => {
  it.each<Case>([
    [
      'add a field',
      { fields: { 'sampling.flow_shift': { state: 'native', maximum: 10 } } },
      (m) => m.fields['sampling.flow_shift'],
      { state: 'native', maximum: 10 },
      [],
    ],
    [
      'promote ignored → native, dropping the stale reason',
      { fields: { 'sampling.distilled_guidance': { state: 'native' } } },
      (m) => m.fields['sampling.distilled_guidance'],
      { state: 'native' },
      [],
    ],
    [
      'widen a bound',
      { fields: { 'sampling.steps': { maximum: 200, minimum: 1 } } },
      (m) => steps(m)?.maximum,
      200,
      [],
    ],
    [
      'widen a set',
      { fields: { 'sampling.sampler': { enum: ['euler', 'euler_a', 'dpm++2m', 'heun'] } } },
      sampler,
      ['euler', 'euler_a', 'dpm++2m', 'heun'],
      [],
    ],
    [
      'raise count limits',
      { fields: { count: { emulated_max: 32 } } },
      (m) => m.fields['count'],
      { state: 'native', native_max: 8, emulated_max: 32 },
      [],
    ],
    [
      'add an adapter option, and fill in an existing one',
      {
        adapters: {
          lora: {
            options: [{ id: 'detail-tweaker', family: 'sdxl' }, { id: 'ink-wash' }],
          },
        },
      },
      (m) => m.adapters?.lora?.options,
      [
        { id: 'detail-tweaker', label: 'Detail Tweaker', family: 'sdxl' },
        { id: 'film-grain', sha256: 'f'.repeat(64) },
        { id: 'ink-wash' },
      ],
      [],
    ],
    [
      'add a collection together with its required fields',
      {
        inputs: { control: { state: 'native', max: 1 } },
        fields: { 'inputs.control.asset_id': { state: 'native' } },
      },
      (m) => [m.inputs, m.fields['inputs.control.asset_id']],
      [{ control: { state: 'native', max: 1 } }, { state: 'native' }],
      [],
    ],
    [
      'add an extension kind',
      { extensions: { comfy: { type: 'object' } } },
      (m) => Object.keys(m.extensions ?? {}),
      ['sdcpp', 'comfy'],
      [],
    ],
    [
      'turn control up',
      { control: { cancel_running: true, progress: 'fraction' } },
      (m) => m.control,
      { cancel_queued: true, cancel_running: true, progress: 'fraction' },
      [],
    ],
    [
      'raise a collection limit',
      { adapters: { lora: { max: 4 } } },
      (m) => m.adapters?.lora?.max,
      4,
      [],
    ],
    [
      'not demote',
      { fields: { 'sampling.steps': { state: 'emulated' } } },
      (m) => steps(m)?.state,
      'native',
      [`${T}/fields/sampling.steps/state`],
    ],
    [
      'not remove',
      { fields: { 'sampling.eta': { state: 'absent' } }, adapters: { lora: { state: 'absent' } } },
      (m) => ['sampling.eta' in m.fields, m.adapters?.lora?.state],
      [true, 'native'],
      [`${T}/fields/sampling.eta/state`, `${T}/adapters/lora/state`],
    ],
    [
      'not narrow a bound',
      { fields: { 'sampling.steps': { maximum: 50 } } },
      (m) => steps(m)?.maximum,
      150,
      [`${T}/fields/sampling.steps/maximum`],
    ],
    [
      'not add a bound where there was none',
      { fields: { 'sampling.eta': { maximum: 1 } } },
      (m) => m.fields['sampling.eta'],
      { state: 'native' },
      [`${T}/fields/sampling.eta/maximum`],
    ],
    [
      'only the widening part of a set',
      { fields: { 'sampling.sampler': { enum: ['euler', 'heun'] } } },
      sampler,
      ['euler', 'euler_a', 'dpm++2m', 'heun'],
      [`${T}/fields/sampling.sampler/enum`],
    ],
    [
      'not lower a collection limit',
      { adapters: { lora: { max: 1 } } },
      (m) => m.adapters?.lora?.max,
      2,
      [`${T}/adapters/lora/max`],
    ],
    [
      'not change an existing option',
      { adapters: { lora: { options: [{ id: 'detail-tweaker', label: 'Details' }] } } },
      (m) => m.adapters?.lora?.options?.[0]?.label,
      'Detail Tweaker',
      [`${T}/adapters/lora/options/0/label`],
    ],
    [
      'not narrow adapter ids with an enum',
      { fields: { 'adapters.lora.id': { enum: ['film-grain'] } } },
      loraIds,
      ['detail-tweaker', 'film-grain'],
      [`${T}/fields/adapters.lora.id/enum`],
    ],
    [
      'not replace an extension',
      { extensions: { sdcpp: { type: 'object' } } },
      (m) => m.extensions?.['sdcpp']?.['additionalProperties'],
      false,
      [`${T}/extensions/sdcpp`],
    ],
    [
      'not set a default, on a new field or an old one',
      {
        fields: {
          'sampling.steps': { default: 30 },
          'sampling.cfg': { state: 'native', default: 7 },
        },
      },
      (m) => [steps(m)?.default, m.fields['sampling.cfg']],
      [20, { state: 'native' }],
      [`${T}/fields/sampling.cfg/default`, `${T}/fields/sampling.steps/default`],
    ],
    [
      'not add a field without a state',
      { fields: { 'sampling.cfg': { maximum: 10 } } },
      (m) => 'sampling.cfg' in m.fields,
      false,
      [`${T}/fields/sampling.cfg`],
    ],
    [
      'not add a path that is not a field',
      { fields: { 'sampling.cfg_scale': { state: 'native' }, 'inputs.ref': { state: 'native' } } },
      (m) => Object.keys(m.fields).length,
      Object.keys(ROUTE.modes.txt2img!.fields).length,
      [`${T}/fields/sampling.cfg_scale`, `${T}/fields/inputs.ref`],
    ],
    [
      'not turn control down',
      { control: { cancel_queued: false } },
      (m) => m.control.cancel_queued,
      true,
      [`${T}/control/cancel_queued`],
    ],
  ])('%s', (_name, layer, select, expected, notes) => {
    const result = apply('override', layer);
    expect(select(result.mode)).toEqual(expected);
    expect(result.notes).toEqual(notes);
  });

  it('refuses additions together when they leave the mode invalid', () => {
    const result = apply('override', {
      inputs: { control: { state: 'native' } },
      fields: { 'sampling.cfg': { state: 'native' } },
    });
    expect(result.mode).toEqual(ROUTE.modes.txt2img);
    expect(result.notes).toEqual([T]);
    expect(result.messages[0]).toContain('`inputs.control.asset_id` is required');
  });

  it('may add a whole mode with a complete control, and not remove one', () => {
    const txt2vid: ModeLayer = {
      fields: {
        'prompt.positive': { state: 'native' },
        'sampling.seed': { state: 'native' },
        'geometry.width': { state: 'native' },
        'geometry.height': { state: 'native' },
        'geometry.frames': { state: 'native', maximum: 81 },
      },
      control: { cancel_queued: true, cancel_running: false, progress: 'fraction' },
    };
    const added = applyLayer(ROUTE, { modes: { txt2vid } }, 'override');
    expect(added.notes).toEqual([]);
    expect(added.descriptor.modes.txt2vid?.fields['geometry.frames']).toEqual({
      state: 'native',
      maximum: 81,
    });

    const incomplete = applyLayer(
      ROUTE,
      { modes: { txt2vid: { ...txt2vid, control: { progress: 'none' } } } },
      'override',
    );
    expect(incomplete.descriptor).toEqual(ROUTE);
    expect(incomplete.notes.map((note) => note.path)).toEqual(['/modes/txt2vid/control']);

    const invalid = applyLayer(
      ROUTE,
      { modes: { txt2vid: { ...txt2vid, fields: { 'prompt.positive': { state: 'native' } } } } },
      'override',
    );
    expect(invalid.descriptor).toEqual(ROUTE);
    expect(invalid.notes.map((note) => note.path)).toEqual(['/modes/txt2vid']);

    const removed = applyLayer(ROUTE, { modes: { img2img: { state: 'absent' } } }, 'override');
    expect(removed.descriptor).toEqual(ROUTE);
    expect(removed.notes.map((note) => note.path)).toEqual(['/modes/img2img/state']);
  });

  it('refuses options on an adapter kind that takes any id', () => {
    const base = structuredClone(ROUTE);
    delete base.modes.txt2img!.adapters!.lora!.options;
    const result = applyLayer(
      base,
      layerFor({ adapters: { lora: { options: [{ id: 'x' }] } } }),
      'override',
    );
    expect(result.descriptor).toEqual(base);
    expect(result.notes.map((note) => note.path)).toEqual([`${T}/adapters/lora/options`]);
  });
});

describe('profile: may only narrow or remove', () => {
  it.each<Case>([
    [
      'narrow a bound, keeping a default still in range',
      { fields: { 'sampling.steps': { maximum: 100 } } },
      steps,
      { state: 'native', minimum: 1, maximum: 100, default: 20 },
      [],
    ],
    [
      'narrow a set',
      { fields: { 'sampling.sampler': { enum: ['euler'] } } },
      sampler,
      ['euler'],
      [],
    ],
    [
      'add a bound',
      { fields: { 'sampling.eta': { maximum: 1 } } },
      (m) => m.fields['sampling.eta'],
      { state: 'native', maximum: 1 },
      [],
    ],
    [
      'tighten multipleOf to a multiple',
      { fields: { 'geometry.width': { multipleOf: 128 } } },
      (m) => m.fields['geometry.width']?.multipleOf,
      128,
      [],
    ],
    [
      'narrow adapter ids by filtering the options',
      { fields: { 'adapters.lora.id': { enum: ['film-grain'] } } },
      (m) => [loraIds(m), m.fields['adapters.lora.id']],
      [['film-grain'], { state: 'native' }],
      [],
    ],
    [
      'lower a collection limit and narrow media',
      { adapters: { lora: { max: 1 } } },
      (m) => m.adapters?.lora?.max,
      1,
      [],
    ],
    [
      'remove a field and a collection, its fields with it',
      { fields: { 'sampling.eta': { state: 'absent' } }, passes: { hires: { state: 'absent' } } },
      (m) => [
        'sampling.eta' in m.fields,
        m.passes,
        Object.keys(m.fields).filter((path) => path.startsWith('passes.')),
      ],
      [false, undefined, []],
      [],
    ],
    [
      'drop a default that narrowing leaves out of range, noting it',
      { fields: { 'sampling.steps': { maximum: 8 } } },
      steps,
      { state: 'native', minimum: 1, maximum: 8 },
      [`${T}/fields/sampling.steps/default`],
    ],
    [
      'not widen a bound',
      { fields: { 'sampling.steps': { maximum: 200 } } },
      (m) => steps(m)?.maximum,
      150,
      [`${T}/fields/sampling.steps/maximum`],
    ],
    [
      'only the narrowing part of a set',
      { fields: { 'sampling.sampler': { enum: ['euler', 'heun'] } } },
      sampler,
      ['euler'],
      [`${T}/fields/sampling.sampler/enum`],
    ],
    [
      'not a disjoint set',
      { fields: { 'sampling.sampler': { enum: ['heun'] } } },
      sampler,
      ['euler', 'euler_a', 'dpm++2m'],
      [`${T}/fields/sampling.sampler/enum`],
    ],
    [
      'not a multipleOf that is not a multiple',
      { fields: { 'geometry.width': { multipleOf: 96 } } },
      (m) => m.fields['geometry.width']?.multipleOf,
      64,
      [`${T}/fields/geometry.width/multipleOf`],
    ],
    [
      'only the offered adapter ids',
      { fields: { 'adapters.lora.id': { enum: ['film-grain', 'missing'] } } },
      loraIds,
      ['film-grain'],
      [`${T}/fields/adapters.lora.id/enum`],
    ],
    [
      'not change a state other than to absent',
      { fields: { 'sampling.steps': { state: 'emulated' } } },
      (m) => steps(m)?.state,
      'native',
      [`${T}/fields/sampling.steps/state`],
    ],
    [
      'not narrow a field the route lacks',
      { fields: { 'sampling.flow_shift': { maximum: 3 } } },
      (m) => 'sampling.flow_shift' in m.fields,
      false,
      [`${T}/fields/sampling.flow_shift`],
    ],
    [
      'not narrow an ignored field',
      { fields: { 'sampling.distilled_guidance': { maximum: 5 } } },
      (m) => m.fields['sampling.distilled_guidance']?.maximum,
      undefined,
      [`${T}/fields/sampling.distilled_guidance/maximum`],
    ],
    [
      'not remove a required field',
      { fields: { 'prompt.positive': { state: 'absent' } } },
      (m) => m.fields['prompt.positive'],
      { state: 'native' },
      [`${T}/fields/prompt.positive`],
    ],
    [
      'not narrow to bounds that admit nothing',
      { fields: { 'sampling.steps': { minimum: 200 } } },
      steps,
      ROUTE.modes.txt2img!.fields['sampling.steps'],
      [`${T}/fields/sampling.steps`],
    ],
    [
      'not change control, options or count limits',
      {
        control: { cancel_queued: false },
        adapters: { lora: { options: [] } },
        fields: { count: { native_max: 4 } },
      },
      (m) => [m.control, loraIds(m), m.fields['count']],
      [
        ROUTE.modes.txt2img!.control,
        ['detail-tweaker', 'film-grain'],
        { state: 'native', native_max: 8, emulated_max: 16 },
      ],
      [`${T}/fields/count/native_max`, `${T}/adapters/lora/options`, `${T}/control/cancel_queued`],
    ],
  ])('%s', (_name, layer, select, expected, notes) => {
    const result = apply('profile', layer);
    expect(select(result.mode)).toEqual(expected);
    expect(result.notes).toEqual(notes);
  });

  it('may remove a mode, and not narrow one the route lacks', () => {
    const result = applyLayer(
      ROUTE,
      { modes: { img2img: { state: 'absent' }, edit: { fields: {} } } },
      'profile',
    );
    expect(Object.keys(result.descriptor.modes)).toEqual(['txt2img']);
    expect(result.notes.map((note) => note.path)).toEqual(['/modes/edit']);
  });

  it('builds its layer from a NarrowingMap and absent paths', () => {
    expect(
      profileLayer({
        txt2img: {
          narrow: { 'sampling.steps': { maximum: 8 } },
          absent: ['sampling.eta', 'adapters.lora', 'passes.hires'],
        },
      }),
    ).toEqual({
      modes: {
        txt2img: {
          fields: { 'sampling.steps': { maximum: 8 }, 'sampling.eta': { state: 'absent' } },
          adapters: { lora: { state: 'absent' } },
          passes: { hires: { state: 'absent' } },
        },
      },
    });
  });
});

describe('mergeDescriptor', () => {
  it('applies probe, override and profile in that order', () => {
    const result = mergeDescriptor(ROUTE, {
      // Profile first in the object: order comes from the merge, not the keys.
      profile: profileLayer({ txt2img: { narrow: { 'sampling.steps': { maximum: 8 } } } }),
      probe: layerFor({
        fields: { 'sampling.eta': { state: 'ignored', reason: 'Probe: no effect' } },
      }),
      override: layerFor({ fields: { 'sampling.eta': { state: 'native' } } }),
    });
    const mode = result.descriptor.modes.txt2img!;
    expect(mode.fields['sampling.eta']).toEqual({ state: 'native' });
    expect(mode.fields['sampling.steps']).toEqual({ state: 'native', minimum: 1, maximum: 8 });
    expect(result.notes).toEqual([
      {
        layer: 'profile',
        path: `${T}/fields/sampling.steps/default`,
        message: "the route's default 20 is outside the narrowed values; dropped",
      },
    ]);
  });

  it('leaves its inputs alone', () => {
    const before = structuredClone(ROUTE);
    const layer = layerFor({ fields: { 'sampling.steps': { maximum: 8 } } });
    mergeDescriptor(ROUTE, { profile: layer });
    expect(ROUTE).toEqual(before);
  });

  it('is the identity with no layers', () => {
    expect(mergeDescriptor(ROUTE)).toEqual({ descriptor: ROUTE, notes: [] });
  });

  it('throws on an invalid describe() result, naming each issue', () => {
    const bad: RouteDescriptor = structuredClone(ROUTE);
    delete bad.modes.txt2img!.fields['sampling.seed'];
    expect(() => mergeDescriptor(bad)).toThrow(InvalidDescriptorError);
    expect(() => mergeDescriptor({ route: '', modes: {} })).toThrow(/\/route/);
  });

  it('refuses a malformed layer whole', () => {
    const malformed = {
      modes: { txt2img: { fields: { 'sampling.steps': { maximum: 'eight' } } } },
    };
    const result = applyLayer(ROUTE, malformed as unknown as DescriptorLayer, 'profile');
    expect(result.descriptor).toBe(ROUTE);
    expect(result.notes[0]?.message).toMatch(/^the layer is malformed/);
  });

  it('writes notes as prose a person can act on', () => {
    const result = apply('profile', {
      fields: {
        'sampling.steps': { maximum: 200 },
        'sampling.sampler': { enum: ['euler', 'heun'] },
        'prompt.positive': { state: 'absent' },
      },
    });
    expect(result.messages).toMatchInlineSnapshot(`
      [
        "\`maximum\` 200 is not narrower than the route's 150; kept the route's",
        "\`enum\` values ["heun"] are not on the route; narrowed to ["euler"]",
        "refused, because it would leave the mode invalid: /modes/txt2img/fields \`prompt.positive\` is required by the request, so the mode must list it",
      ]
    `);
  });
});
