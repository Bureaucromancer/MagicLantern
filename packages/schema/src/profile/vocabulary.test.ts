// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import {
  CanonicalSampler,
  CanonicalScheduler,
  isCanonicalSampler,
  isCanonicalScheduler,
  isNativeName,
  parseSamplerName,
  parseSchedulerName,
  SAMPLER_NAME_PATTERN,
  SamplerName,
  SAMPLERS,
  SCHEDULER_NAME_PATTERN,
  SchedulerName,
  SCHEDULERS,
} from './index.js';

describe('the vocabulary', () => {
  it('has no repeated names', () => {
    expect(new Set(SAMPLERS).size).toBe(SAMPLERS.length);
    expect(new Set(SCHEDULERS).size).toBe(SCHEDULERS.length);
  });

  it('contains the names the plan and the profiles rely on', () => {
    for (const name of ['euler', 'euler_a', 'dpm++2m', 'lcm']) expect(SAMPLERS).toContain(name);
    for (const name of ['discrete', 'karras', 'simple']) expect(SCHEDULERS).toContain(name);
  });

  it('accepts each canonical name in its schema and pattern', () => {
    for (const name of SAMPLERS) {
      expect(Value.Check(CanonicalSampler, name)).toBe(true);
      expect(Value.Check(SamplerName, name)).toBe(true);
      expect(isCanonicalSampler(name)).toBe(true);
    }
    for (const name of SCHEDULERS) {
      expect(Value.Check(CanonicalScheduler, name)).toBe(true);
      expect(Value.Check(SchedulerName, name)).toBe(true);
      expect(isCanonicalScheduler(name)).toBe(true);
    }
  });

  it('keeps the two vocabularies apart, except names both have', () => {
    expect(isCanonicalSampler('karras')).toBe(false);
    expect(isCanonicalScheduler('euler')).toBe(false);
    expect(isCanonicalSampler('lcm') && isCanonicalScheduler('lcm')).toBe(true);
  });
});

describe('parsing names', () => {
  it('reads a canonical name', () => {
    expect(parseSamplerName('dpm++2m')).toEqual({ kind: 'canonical', name: 'dpm++2m' });
    expect(parseSchedulerName('karras')).toEqual({ kind: 'canonical', name: 'karras' });
  });

  it('reads a native name, prefix removed, spaces inside kept', () => {
    expect(parseSamplerName('native:dpmpp_2m_sde_gpu')).toEqual({
      kind: 'native',
      name: 'dpmpp_2m_sde_gpu',
    });
    expect(parseSchedulerName('native:Align Your Steps')).toEqual({
      kind: 'native',
      name: 'Align Your Steps',
    });
  });

  it.each([
    ['a misspelt canonical name', 'Euler'],
    ['an unknown name', 'pndm'],
    ['an empty native name', 'native:'],
    ['a native name with leading whitespace', 'native: euler'],
    ['a native name with trailing whitespace', 'native:euler '],
    ['the wrong prefix', 'Native:euler'],
    ['an empty string', ''],
  ])('refuses %s', (_label, name) => {
    expect(parseSamplerName(name)).toBeNull();
    expect(parseSchedulerName(name)).toBeNull();
    expect(Value.Check(SamplerName, name)).toBe(false);
    expect(Value.Check(SchedulerName, name)).toBe(false);
  });

  it('agrees with the patterns on every case', () => {
    const cases = [...SAMPLERS, ...SCHEDULERS, 'native:x', 'native:', 'x', 'dpm++2m ', 'dpm.2m'];
    for (const name of cases) {
      expect(new RegExp(SAMPLER_NAME_PATTERN).test(name), name).toBe(
        parseSamplerName(name) !== null,
      );
      expect(new RegExp(SCHEDULER_NAME_PATTERN).test(name), name).toBe(
        parseSchedulerName(name) !== null,
      );
    }
  });

  it('treats regex metacharacters in canonical names literally', () => {
    expect(parseSamplerName('dpm+2m')).toBeNull();
    expect(new RegExp(SAMPLER_NAME_PATTERN).test('dpm+2m')).toBe(false);
  });

  it('recognises native names on their own', () => {
    expect(isNativeName('native:k_dpmpp_2m')).toBe(true);
    expect(isNativeName('euler')).toBe(false);
  });
});
