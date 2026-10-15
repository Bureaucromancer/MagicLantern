// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/** The resolver's helpers on their own: suggested values, leaves and pointers. */

import { type FieldNarrowing, REQUEST_NODES } from '@bureaucromancer/lantern-schema';
import type { TSchema } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';

import { fieldOfPointer, pointerSegments, requestLeaves, valueAt } from './leaves.js';
import { suggestValue } from './suggest.js';
import { ASSET_A, ASSET_B, txt2img } from './test-resolver.js';

function schemaOf(path: string): TSchema {
  const node = REQUEST_NODES.get(path);
  if (node === undefined) throw new Error(path);
  return node.schema;
}

describe('suggestValue', () => {
  it.each([
    ['clamps to a maximum', 200, 'sampling.steps', { maximum: 150 }, undefined, 150],
    ['clamps to the schema’s own minimum', 0, 'sampling.steps', {}, undefined, 1],
    ['snaps to a multiple', 1000, 'geometry.width', { multipleOf: 64 }, undefined, 1024],
    [
      'snaps inside the bounds',
      2040,
      'geometry.width',
      { maximum: 2000, multipleOf: 64 },
      undefined,
      1984,
    ],
    ['rounds an integer field', 2.6, 'sampling.steps', {}, undefined, 3],
    [
      'snaps a decimal multiple without float noise',
      0.31,
      'sampling.cfg',
      { multipleOf: 0.1 },
      undefined,
      0.3,
    ],
    [
      'takes an integer exclusive bound',
      4,
      'sampling.steps',
      { exclusiveMaximum: 4 },
      undefined,
      3,
    ],
    [
      'gives up on a decimal exclusive bound',
      5,
      'sampling.cfg',
      { exclusiveMaximum: 4 },
      undefined,
      undefined,
    ],
    [
      'takes the nearest number of an enum',
      7,
      'sampling.steps',
      { enum: [4, 8, 20] },
      undefined,
      8,
    ],
    [
      'takes the route default for a string enum',
      'lms',
      'sampling.sampler',
      { enum: ['euler', 'lcm'] },
      'lcm',
      'lcm',
    ],
    [
      'else the first member',
      'lms',
      'sampling.sampler',
      { enum: ['euler', 'lcm'] },
      'heun',
      'euler',
    ],
    [
      'makes none for a string over its length',
      'abcdef',
      'prompt.negative',
      { maxLength: 3 },
      undefined,
      undefined,
    ],
    [
      'makes none for an accepted value',
      20,
      'sampling.steps',
      { maximum: 150 },
      undefined,
      undefined,
    ],
    [
      'makes none when no value is left',
      5,
      'sampling.steps',
      { minimum: 10, maximum: 9 },
      undefined,
      undefined,
    ],
    ['clamps a seed to 2^53 − 1', 2 ** 53, 'sampling.seed', {}, undefined, 2 ** 53 - 1],
  ] as const)('%s', (_label, value, path, narrowing, fallback, expected) => {
    expect(suggestValue(value, schemaOf(path), narrowing as FieldNarrowing, fallback)).toBe(
      expected,
    );
  });
});

describe('requestLeaves', () => {
  it('lists every value with its pointer and field path, discriminators and the mode excepted', () => {
    const request = txt2img({
      inputs: [
        { role: 'init', asset_id: ASSET_A, crop: { x: 0, y: 0, width: 1, height: 1 } },
        { role: 'control', asset_id: ASSET_B, weight: 0.5 },
      ],
      passes: [{ kind: 'hires', target: { width: 2048, height: 2048 } }],
      extensions: { 'a/b': {} },
    });
    expect(requestLeaves(request as unknown as Record<string, unknown>)).toMatchSnapshot();
  });
});

describe('pointers', () => {
  const request = txt2img({
    inputs: [
      { role: 'init', asset_id: ASSET_A },
      { role: 'control', asset_id: ASSET_B, weight: 0.5 },
    ],
  });

  it.each([
    ['/sampling/seed', 'sampling.seed'],
    ['/inputs/1/weight', 'inputs.control.weight'],
    ['/inputs', 'inputs'],
    ['/inputs/7/weight', undefined],
    ['', undefined],
  ])('names %j as the field %j', (pointer, field) => {
    expect(fieldOfPointer(request, pointer)).toBe(field);
  });

  it('reads values and unescapes segments', () => {
    expect(valueAt(request, '/inputs/1/weight')).toBe(0.5);
    expect(valueAt(request, '/inputs/1/weight/x')).toBeUndefined();
    expect(valueAt({ 'a/b': { '~': 1 } }, '/a~1b/~0')).toBe(1);
    expect(pointerSegments('')).toEqual([]);
  });
});
