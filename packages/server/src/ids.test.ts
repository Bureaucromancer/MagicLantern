// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { LIBRARY_ID_PATTERN } from '@bureaucromancer/lantern-schema';
import { describe, expect, it } from 'vitest';

import {
  createUlidGenerator,
  isUlid,
  newId,
  ULID_PATTERN,
  ulid,
  ulidTimestamp,
  type RandomSource,
} from './ids.js';

/** A source that writes the same byte everywhere, to force the increment's edges. */
function filled(byte: number): RandomSource {
  return (bytes) => {
    bytes.fill(byte);
  };
}

describe('ulid', () => {
  it('is 26 Crockford base32 characters', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(ulid()).toMatch(ULID_PATTERN);
    }
  });

  it('encodes the timestamp in the first ten characters', () => {
    const next = createUlidGenerator();
    expect(ulidTimestamp(next(0))).toBe(0);
    expect(ulidTimestamp(next(1_700_000_000_123))).toBe(1_700_000_000_123);
    expect(next(2 ** 48 - 1).slice(0, 10)).toBe('7ZZZZZZZZZ');
  });

  it('matches the reference encoding', () => {
    // The ULID spec's example timestamp, with all-zero randomness.
    const next = createUlidGenerator({ random: filled(0) });
    expect(next(1_469_918_176_385)).toBe('01ARYZ6S410000000000000000');
  });

  it('is strictly increasing within one millisecond', () => {
    const next = createUlidGenerator();
    const ids = Array.from({ length: 10_000 }, () => next(1_700_000_000_000));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(ids.every((id) => ulidTimestamp(id) === 1_700_000_000_000)).toBe(true);
  });

  it('increments the random part by one, carrying across bytes', () => {
    const next = createUlidGenerator({ random: filled(0) });
    const first = next(1000);
    const second = next(1000);
    expect(first.slice(10)).toBe('0000000000000000');
    expect(second.slice(10)).toBe('0000000000000001');

    const carry = createUlidGenerator({
      random: (bytes) => {
        bytes.fill(0);
        bytes[9] = 0xff;
      },
    });
    const before = carry(1000);
    const after = carry(1000);
    expect(after > before).toBe(true);
    expect(after.slice(10)).toBe('0000000000000080');
  });

  it('stays ordered when the clock steps backwards', () => {
    const next = createUlidGenerator();
    const late = next(5000);
    const early = next(4000);
    expect(early > late).toBe(true);
    expect(ulidTimestamp(early)).toBe(5000);
  });

  it('moves to the next millisecond when the random part would overflow', () => {
    const next = createUlidGenerator({ random: filled(0xff) });
    const top = next(1000);
    const after = next(1000);
    expect(top.slice(10)).toBe('ZZZZZZZZZZZZZZZZ');
    expect(after > top).toBe(true);
    expect(ulidTimestamp(after)).toBe(1001);
  });

  it('refuses timestamps outside 48 bits', () => {
    const next = createUlidGenerator();
    expect(() => next(-1)).toThrow(RangeError);
    expect(() => next(2 ** 48)).toThrow(RangeError);
    expect(() => next(1.5)).toThrow(RangeError);
  });

  it('sorts across milliseconds by time', () => {
    const next = createUlidGenerator();
    const ids = [next(1000), next(1001), next(2000), next(1_000_000)];
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('isUlid and ulidTimestamp', () => {
  it('reject what is not a ULID', () => {
    expect(isUlid('01ARYZ6S410000000000000000')).toBe(true);
    expect(isUlid('81ARYZ6S410000000000000000')).toBe(false);
    expect(isUlid('01ARYZ6S41000000000000000I')).toBe(false);
    expect(isUlid('01aryz6s410000000000000000')).toBe(false);
    expect(() => ulidTimestamp('nope')).toThrow(TypeError);
  });
});

describe('newId', () => {
  it('prefixes a ULID', () => {
    const id = newId('job');
    expect(id).toMatch(/^job_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it('makes library ids the API contract accepts', () => {
    expect(new RegExp(LIBRARY_ID_PATTERN).test(newId('lib'))).toBe(true);
  });

  it('refuses a prefix that would make an ambiguous id', () => {
    expect(() => newId('')).toThrow(TypeError);
    expect(() => newId('Lib')).toThrow(TypeError);
    expect(() => newId('lib_x')).toThrow(TypeError);
  });

  it('shares one monotonic sequence across prefixes', () => {
    const a = newId('a');
    const b = newId('a');
    expect(b > a).toBe(true);
  });
});
