// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { describe, expect, it } from 'vitest';

import {
  generateSecret,
  hashPassword,
  SCRYPT_PARAMS,
  scryptMaxmem,
  secretsMatch,
  verifyPassword,
} from './password.js';

describe('hashPassword', () => {
  it('records scrypt and its parameters with the hash', async () => {
    const record = await hashPassword('hunter2');
    expect(record).toMatchObject({ alg: 'scrypt', N: 2 ** 15, r: 8, p: 1, keyLen: 64 });
    expect(record.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(record.hash).toMatch(/^[0-9a-f]{128}$/);
  });

  it('salts every hash differently', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('takes any string, the empty one included', async () => {
    const record = await hashPassword('');
    expect(await verifyPassword('', record)).toBe(true);
    expect(await verifyPassword(' ', record)).toBe(false);
  });
});

describe('verifyPassword', () => {
  it('accepts the password and nothing else', async () => {
    const record = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', record)).toBe(true);
    expect(await verifyPassword('correct horse ', record)).toBe(false);
    expect(await verifyPassword('Correct horse', record)).toBe(false);
  });

  it('verifies with the parameters stored, not the current defaults', async () => {
    // A record written at a lower cost must keep working after the default rises.
    const record = await hashPassword('pw');
    const cheaper = { ...record, N: 2 ** 10 };
    expect(await verifyPassword('pw', cheaper)).toBe(false);
    expect(await verifyPassword('pw', record)).toBe(true);
  });

  it('answers false, without throwing, when the stored hash has another length', async () => {
    const record = await hashPassword('pw');
    expect(await verifyPassword('pw', { ...record, hash: record.hash.slice(0, 64) })).toBe(false);
  });
});

describe('scryptMaxmem', () => {
  it("leaves room above scrypt's 128·N·r", () => {
    const { N, r } = SCRYPT_PARAMS;
    expect(scryptMaxmem(N, r)).toBeGreaterThan(128 * N * r);
  });
});

describe('secrets', () => {
  it('generates distinct url-safe keys', () => {
    const a = generateSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSecret()).not.toBe(a);
  });

  it('compares in constant time, and different lengths are simply unequal', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abc', 'abd')).toBe(false);
    expect(secretsMatch('abc', 'abcd')).toBe(false);
  });
});
