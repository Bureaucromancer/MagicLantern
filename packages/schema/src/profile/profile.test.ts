// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import { MODEL_PROFILE_SCHEMA_VERSION, ModelProfile } from './index.js';

const MINIMAL: ModelProfile = {
  schema_version: MODEL_PROFILE_SCHEMA_VERSION,
  family: 'example',
  name: 'Example',
  licence: { id: 'Apache-2.0', name: 'Apache License 2.0', commercial_use: true, source: 'card' },
  prompt: { dialect: 'natural', source: 'card' },
  negative_prompt: { behaviour: 'cfg', source: 'card' },
  resolution: { multiple_of: 16, source: 'card' },
  modes: { txt2img: {} },
  sources: [{ id: 'card', url: 'https://example.com/card', checked: '2026-10-15' }],
};

function errors(value: unknown): string[] {
  return [...Value.Errors(ModelProfile, value)].map((e) => e.path);
}

describe('ModelProfile', () => {
  it('accepts a minimal profile', () => {
    expect(errors(MINIMAL)).toEqual([]);
  });

  it('accepts every optional block', () => {
    const full: ModelProfile = {
      ...MINIMAL,
      frames: { a: 4, b: 1, min: 5, max: 81, source: 'card' },
      resolution: {
        multiple_of: 16,
        native: { width: 1024, height: 1024 },
        presets: [{ aspect: '16:9', width: 1664, height: 928 }],
        source: 'card',
      },
      modes: {
        txt2img: {
          defaults: { 'sampling.steps': { value: 4, source: 'card', note: 'Distilled.' } },
          constraints: { 'sampling.steps': { minimum: 1, maximum: 8 } },
        },
        edit: { collections: { 'inputs.ref': { min: 1, max: 4, source: 'card' } } },
      },
      warnings: [
        {
          code: 'negative_prompt_ignored',
          modes: ['txt2img'],
          when: { 'sampling.cfg': { maximum: 1 } },
          message: 'Negatives do nothing at CFG 1.',
        },
      ],
      variants: [{ id: 'base-4b', name: 'Base 4B', licence: MINIMAL.licence! }],
      default_variant: 'base-4b',
      notes: ['A note.'],
    };
    expect(errors(full)).toEqual([]);
  });

  it.each([
    ['an unknown property', { ...MINIMAL, extra: 1 }, '/extra'],
    ['an unknown mode', { ...MINIMAL, modes: { paint: {} } }, '/modes/paint'],
    ['an uppercase family id', { ...MINIMAL, family: 'SDXL' }, '/family'],
    [
      'a narrowing keyword that changes the type',
      { ...MINIMAL, modes: { txt2img: { constraints: { 'sampling.steps': { type: 'string' } } } } },
      '/modes/txt2img/constraints/sampling.steps/type',
    ],
    [
      'a default that is an object',
      {
        ...MINIMAL,
        modes: { txt2img: { defaults: { 'sampling.steps': { value: {}, source: 'card' } } } },
      },
      '/modes/txt2img/defaults/sampling.steps/value',
    ],
    [
      'an http source',
      { ...MINIMAL, sources: [{ ...MINIMAL.sources[0]!, url: 'http://x' }] },
      '/sources/0/url',
    ],
    ['no sources', { ...MINIMAL, sources: [] }, '/sources'],
    [
      'an unknown dialect',
      { ...MINIMAL, prompt: { dialect: 'prose', source: 'card' } },
      '/prompt/dialect',
    ],
  ])('refuses %s', (_label, value, path) => {
    expect(errors(value)).toContain(path);
  });
});
