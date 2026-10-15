// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import {
  checkDescriptorPaths,
  checkRouteDescriptor,
  DescriptorLayer,
  isDescriptorFieldPath,
  type ModeDescriptor,
  narrowableTypes,
  REQUEST_NODES,
  RouteDescriptor,
  satisfiesNarrowing,
} from './index.js';
import { REQUEST_PATHS } from '../request/index.js';
import { EXAMPLE_DESCRIPTOR } from './test-descriptors.js';

/** A copy of the example with one mode replaced by `change` applied to a copy of it. */
function withMode(
  mode: 'txt2img' | 'img2img',
  change: (descriptor: ModeDescriptor) => void,
): RouteDescriptor {
  const copy = structuredClone(EXAMPLE_DESCRIPTOR);
  change(copy.modes[mode]!);
  return copy;
}

function issuePaths(descriptor: RouteDescriptor): string[] {
  expect([...Value.Errors(RouteDescriptor, descriptor)]).toEqual([]);
  return checkRouteDescriptor(descriptor).map((issue) => issue.path);
}

describe('the request tree', () => {
  it('lists exactly REQUEST_PATHS, in order, plus the objects between them', () => {
    const listed = [...REQUEST_NODES.values()]
      .filter((node) => node.kind !== 'object')
      .map((node) => [node.path, node.kind]);
    expect(listed).toEqual(REQUEST_PATHS.map((path) => [path.path, path.kind]));
    const objects = [...REQUEST_NODES.values()].filter((node) => node.kind === 'object');
    expect(objects.map((node) => node.path)).toEqual([
      'prompt',
      'geometry',
      'sampling',
      'passes.hires.target',
      'audio',
    ]);
  });

  it('knows which fields are required where', () => {
    const required = [...REQUEST_NODES.values()]
      .filter((node) => node.required)
      .map((node) => node.path);
    expect(required).toMatchInlineSnapshot(`
      [
        "prompt",
        "prompt.positive",
        "inputs.init.asset_id",
        "inputs.mask.asset_id",
        "inputs.ref.asset_id",
        "inputs.style.asset_id",
        "inputs.control.asset_id",
        "inputs.ip_adapter.asset_id",
        "inputs.first_frame.asset_id",
        "inputs.last_frame.asset_id",
        "inputs.annotation.asset_id",
        "geometry.width",
        "geometry.height",
        "sampling",
        "sampling.seed",
        "adapters.lora.id",
        "adapters.lora.weight",
        "adapters.embedding.id",
        "adapters.embedding.weight",
        "passes.hires.target.width",
        "passes.hires.target.height",
        "passes.upscale.scale",
        "audio.enabled",
      ]
    `);
  });

  it.each([
    ['sampling.steps', ['number']],
    ['sampling.seed', ['string', 'number']],
    ['sampling.sampler', ['string']],
    ['adapters.lora.stage', ['string']],
    ['inputs.ref.crop', []],
    ['audio.enabled', []],
  ])('narrows %s as %j', (path, types) => {
    expect([...narrowableTypes(REQUEST_NODES.get(path)!.schema)].sort()).toEqual([...types].sort());
  });

  it('takes field paths and experimental paths as descriptor fields, never collections', () => {
    expect(isDescriptorFieldPath('sampling.steps')).toBe(true);
    expect(isDescriptorFieldPath('passes.hires.target.width')).toBe(true);
    expect(isDescriptorFieldPath('subjects')).toBe(true);
    expect(isDescriptorFieldPath('style')).toBe(true);
    expect(isDescriptorFieldPath('inputs.ref')).toBe(false);
    expect(isDescriptorFieldPath('passes.hires.target')).toBe(false);
    expect(isDescriptorFieldPath('sampling.cfg_scale')).toBe(false);
    expect(isDescriptorFieldPath('mode')).toBe(false);
  });
});

describe('RouteDescriptor', () => {
  it("accepts the plan's example, completed and made static", () => {
    expect(issuePaths(EXAMPLE_DESCRIPTOR)).toEqual([]);
  });

  it.each([
    ['an unknown mode', { modes: { refine: EXAMPLE_DESCRIPTOR.modes.txt2img } }],
    [
      'an unknown input role',
      {
        modes: {
          img2img: { ...EXAMPLE_DESCRIPTOR.modes.img2img, inputs: { depth: { state: 'native' } } },
        },
      },
    ],
    [
      'an unknown state',
      {
        modes: {
          txt2img: { ...EXAMPLE_DESCRIPTOR.modes.txt2img, fields: { count: { state: 'partial' } } },
        },
      },
    ],
    [
      'a non-hex option hash',
      {
        modes: {
          txt2img: {
            ...EXAMPLE_DESCRIPTOR.modes.txt2img,
            adapters: { lora: { state: 'native', options: [{ id: 'x', sha256: 'abc' }] } },
          },
        },
      },
    ],
    [
      'a field entry with an unknown keyword',
      {
        modes: {
          txt2img: {
            ...EXAMPLE_DESCRIPTOR.modes.txt2img,
            fields: { count: { state: 'native', pattern: 'x' } },
          },
        },
      },
    ],
    ['a mode without control', { modes: { txt2img: { fields: {} } } }],
    [
      'an extension key that is not a backend kind',
      {
        modes: {
          txt2img: {
            ...EXAMPLE_DESCRIPTOR.modes.txt2img,
            extensions: { SDCPP: { type: 'object' } },
          },
        },
      },
    ],
  ])('refuses %s by schema', (_name, change) => {
    expect(Value.Check(RouteDescriptor, { ...EXAMPLE_DESCRIPTOR, ...change })).toBe(false);
  });

  it('checks field paths against REQUEST_PATH_SET', () => {
    const descriptor = withMode('txt2img', (mode) => {
      mode.fields['sampling.cfg_scale'] = { state: 'native' };
      mode.fields['adapters.lora'] = { state: 'native' };
      mode.fields['mode'] = { state: 'native' };
    });
    expect(checkDescriptorPaths(descriptor)).toEqual([
      {
        path: '/modes/txt2img/fields/sampling.cfg_scale',
        message: '`sampling.cfg_scale` is not a request field path',
      },
      {
        path: '/modes/txt2img/fields/adapters.lora',
        message: '`adapters.lora` is a collection: list it under `adapters`, not `fields`',
      },
      { path: '/modes/txt2img/fields/mode', message: '`mode` is not a request field path' },
    ]);
  });

  it.each<[string, 'txt2img' | 'img2img', (mode: ModeDescriptor) => void, string[]]>([
    [
      'a required field left out',
      'txt2img',
      (m) => delete m.fields['sampling.seed'],
      ['/modes/txt2img/fields'],
    ],
    [
      'half of an object listed',
      'txt2img',
      (m) => delete m.fields['geometry.height'],
      ['/modes/txt2img/fields'],
    ],
    [
      'a collection without its required field',
      'img2img',
      (m) => delete m.fields['inputs.init.asset_id'],
      ['/modes/img2img/fields'],
    ],
    [
      'a field whose collection is not listed',
      'txt2img',
      (m) => (m.fields['inputs.ref.weight'] = { state: 'native' }),
      ['/modes/txt2img/fields/inputs.ref.weight', '/modes/txt2img/fields'],
    ],
    [
      "a mode's required input left out",
      'img2img',
      (m) => {
        delete m.inputs!.init;
        for (const k of Object.keys(m.fields)) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the entries under test
          if (k.startsWith('inputs.init.')) delete m.fields[k];
        }
      },
      ['/modes/img2img/inputs'],
    ],
    [
      'native_max on a field other than count',
      'txt2img',
      (m) => (m.fields['sampling.steps']!.native_max = 4),
      ['/modes/txt2img/fields/sampling.steps/native_max'],
    ],
    [
      'emulated_max below native_max',
      'txt2img',
      (m) => (m.fields['count']!.emulated_max = 4),
      ['/modes/txt2img/fields/count/emulated_max'],
    ],
    [
      'narrowing on an ignored field',
      'txt2img',
      (m) => (m.fields['sampling.distilled_guidance']!.maximum = 5),
      ['/modes/txt2img/fields/sampling.distilled_guidance/maximum'],
    ],
    [
      'a numeric keyword on a string',
      'txt2img',
      (m) => (m.fields['sampling.sampler']!.minimum = 1),
      ['/modes/txt2img/fields/sampling.sampler/minimum'],
    ],
    [
      'a length keyword on a number',
      'txt2img',
      (m) => (m.fields['sampling.steps']!.maxLength = 3),
      ['/modes/txt2img/fields/sampling.steps/maxLength'],
    ],
    [
      'bounds that admit nothing',
      'txt2img',
      (m) => (m.fields['sampling.steps']!.minimum = 200),
      ['/modes/txt2img/fields/sampling.steps', '/modes/txt2img/fields/sampling.steps/default'],
    ],
    [
      'an enum value of the wrong type',
      'txt2img',
      (m) => (m.fields['sampling.sampler']!.enum = ['euler', 3]),
      ['/modes/txt2img/fields/sampling.sampler/enum/1'],
    ],
    [
      'an enum value outside the bounds',
      'txt2img',
      (m) => (m.fields['sampling.steps']!.enum = [20, 200]),
      ['/modes/txt2img/fields/sampling.steps/enum/1'],
    ],
    [
      'a default outside the narrowing',
      'txt2img',
      (m) => (m.fields['sampling.steps']!.default = 151),
      ['/modes/txt2img/fields/sampling.steps/default'],
    ],
    [
      'a default of the wrong type',
      'txt2img',
      (m) => (m.fields['sampling.sampler']!.default = 1),
      ['/modes/txt2img/fields/sampling.sampler/default'],
    ],
    [
      'an id enum beside adapter options',
      'txt2img',
      (m) => (m.fields['adapters.lora.id']!.enum = ['film-grain']),
      ['/modes/txt2img/fields/adapters.lora.id/enum'],
    ],
    [
      'a repeated adapter option',
      'txt2img',
      (m) => m.adapters!.lora!.options!.push({ id: 'film-grain' }),
      ['/modes/txt2img/adapters/lora/options/2/id'],
    ],
    [
      'collection min above max',
      'img2img',
      (m) => (m.inputs!.control!.min = 2),
      ['/modes/img2img/inputs/control/min'],
    ],
    [
      'an extension schema that is not an object',
      'txt2img',
      (m) => (m.extensions!['sdcpp'] = { type: 'array' }),
      ['/modes/txt2img/extensions/sdcpp/type'],
    ],
  ])('reports %s', (_name, mode, change, paths) => {
    expect(issuePaths(withMode(mode, change))).toEqual(paths);
  });

  it('names the missing required field in its message', () => {
    const descriptor = withMode('txt2img', (m) => delete m.fields['sampling.seed']);
    expect(checkRouteDescriptor(descriptor)[0]?.message).toBe(
      '`sampling.seed` is required by the request, so the mode must list it',
    );
  });

  it('needs an upscale pass on upscale', () => {
    const descriptor: RouteDescriptor = {
      route: 'rt_up',
      modes: {
        upscale: {
          fields: {
            'prompt.positive': { state: 'ignored' },
            'sampling.seed': { state: 'ignored' },
            'inputs.init.asset_id': { state: 'native' },
          },
          inputs: { init: { state: 'native' } },
          control: { cancel_queued: true, cancel_running: false, progress: 'none' },
        },
      },
    };
    expect(issuePaths(descriptor)).toEqual(['/modes/upscale/passes']);
    descriptor.modes.upscale!.passes = { upscale: { state: 'native' } };
    expect(issuePaths(descriptor)).toEqual(['/modes/upscale/fields']);
    descriptor.modes.upscale!.fields['passes.upscale.scale'] = { state: 'native', enum: [2, 4] };
    expect(issuePaths(descriptor)).toEqual([]);
  });

  it('declares no $id and accepts layers of the same shape', () => {
    expect(JSON.stringify(RouteDescriptor)).not.toContain('"$id"');
    expect(
      Value.Check(DescriptorLayer, {
        modes: {
          txt2img: { fields: { 'sampling.steps': { maximum: 8 } }, control: { progress: 'none' } },
        },
      }),
    ).toBe(true);
    expect(Value.Check(DescriptorLayer, { modes: { txt2img: { state: 'native' } } })).toBe(false);
  });
});

describe('satisfiesNarrowing', () => {
  it.each([
    [5, { minimum: 1, maximum: 10 }, true],
    [0, { minimum: 1 }, false],
    [1, { exclusiveMinimum: 1 }, false],
    [10, { exclusiveMaximum: 10 }, false],
    [0.3, { multipleOf: 0.1 }, true],
    [0.35, { multipleOf: 0.1 }, false],
    ['euler', { enum: ['euler', 'euler_a'] }, true],
    ['heun', { enum: ['euler'] }, false],
    ['random', { minimum: 0, maximum: 10 }, true],
    ['ab', { minLength: 3 }, false],
    ['🙂🙂', { maxLength: 2 }, true],
    [true, { maximum: 1 }, true],
  ])('%j against %j is %s', (value, narrowing, expected) => {
    expect(satisfiesNarrowing(value, narrowing)).toBe(expected);
  });
});
