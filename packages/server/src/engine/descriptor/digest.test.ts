// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import type { RouteDescriptor } from '@bureaucromancer/lantern-schema';
import { describe, expect, it } from 'vitest';

import { canonicalJson, descriptorDigest } from './digest.js';
import { mergeDescriptor, profileLayer } from './merge.js';
import { ROUTE } from './test-descriptors.js';

/** The same value with every object's keys in reverse order. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reversed(item)]),
  );
}

describe('canonicalJson', () => {
  it.each([
    [{ b: 1, a: [3, { d: null, c: 'x' }] }, '{"a":[3,{"c":"x","d":null}],"b":1}'],
    [{ a: undefined, b: [undefined] }, '{"b":[null]}'],
    [{ é: 1, z: 2, A: 3 }, '{"A":3,"z":2,"é":1}'],
    [[0.1, -0, 1e21, 'line\nbreak'], '[0.1,0,1e+21,"line\\nbreak"]'],
  ])('writes %j as %s', (value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  it.each([[Number.NaN], [Infinity], [() => 1], [Symbol('x')], [10n]])('refuses %s', (value) => {
    expect(() => canonicalJson({ value })).toThrow(TypeError);
  });
});

describe('descriptorDigest', () => {
  it('is a SHA-256 in lowercase hex, pinned for the example route', () => {
    expect(descriptorDigest(ROUTE)).toMatch(/^[0-9a-f]{64}$/);
    // A change here means every stored route_snapshot digest stops matching:
    // only acceptable with a migration note.
    expect(descriptorDigest(ROUTE)).toMatchInlineSnapshot(
      `"ecb9f81396c0ea608dd197de816eb51bbebd0202b3df0322bce6a1e9122317a2"`,
    );
  });

  it('ignores key order', () => {
    expect(descriptorDigest(reversed(ROUTE) as RouteDescriptor)).toBe(descriptorDigest(ROUTE));
  });

  it('changes with any capability, and with option order', () => {
    const digests = new Set([descriptorDigest(ROUTE)]);
    const narrowed = mergeDescriptor(ROUTE, {
      profile: profileLayer({ txt2img: { narrow: { 'sampling.steps': { maximum: 8 } } } }),
    }).descriptor;
    digests.add(descriptorDigest(narrowed));
    const reordered = structuredClone(ROUTE);
    reordered.modes.txt2img!.adapters!.lora!.options!.reverse();
    digests.add(descriptorDigest(reordered));
    const control = structuredClone(ROUTE);
    control.modes.img2img!.control.progress = 'steps';
    digests.add(descriptorDigest(control));
    expect(digests.size).toBe(4);
  });

  it('is the same for the same layers merged twice', () => {
    const layers = {
      profile: profileLayer({ txt2img: { absent: ['sampling.eta'] } }),
    };
    expect(descriptorDigest(mergeDescriptor(ROUTE, layers).descriptor)).toBe(
      descriptorDigest(mergeDescriptor(structuredClone(ROUTE), layers).descriptor),
    );
  });
});
