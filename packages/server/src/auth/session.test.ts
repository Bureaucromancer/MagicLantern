// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { describe, expect, it } from 'vitest';

import type { PasswordRecord } from '../store/secrets.js';
import { generateSecret } from './password.js';
import {
  passwordFingerprint,
  SESSION_TTL_MS,
  signPayload,
  signSession,
  verifySession,
} from './session.js';

const KEY = generateSecret();
const RECORD: PasswordRecord = {
  alg: 'scrypt',
  N: 2 ** 15,
  r: 8,
  p: 1,
  keyLen: 64,
  salt: 'aa'.repeat(16),
  hash: 'bb'.repeat(64),
};
const NOW = Date.UTC(2026, 9, 13);

describe('passwordFingerprint', () => {
  it('changes with any part of the record and with the key', () => {
    const base = passwordFingerprint(KEY, RECORD);
    expect(passwordFingerprint(KEY, { ...RECORD })).toBe(base);
    expect(passwordFingerprint(KEY, { ...RECORD, salt: 'cc'.repeat(16) })).not.toBe(base);
    expect(passwordFingerprint(KEY, { ...RECORD, hash: 'dd'.repeat(64) })).not.toBe(base);
    expect(passwordFingerprint(KEY, { ...RECORD, N: 2 ** 16 })).not.toBe(base);
    expect(passwordFingerprint(generateSecret(), RECORD)).not.toBe(base);
  });

  it('does not contain the hash', () => {
    expect(passwordFingerprint(KEY, RECORD)).not.toContain(RECORD.hash.slice(0, 16));
  });
});

describe('signSession and verifySession', () => {
  const fingerprint = passwordFingerprint(KEY, RECORD);

  it('round-trips the issue and expiry times', () => {
    const token = signSession(KEY, fingerprint, NOW);
    expect(verifySession(KEY, fingerprint, token, NOW)).toEqual({
      issuedAt: NOW,
      expiresAt: NOW + SESSION_TTL_MS,
    });
  });

  it('expires after thirty days, to the millisecond', () => {
    const token = signSession(KEY, fingerprint, NOW);
    expect(verifySession(KEY, fingerprint, token, NOW + SESSION_TTL_MS - 1)).not.toBeNull();
    expect(verifySession(KEY, fingerprint, token, NOW + SESSION_TTL_MS)).toBeNull();
  });

  it('is refused under another key or another password record', () => {
    const token = signSession(KEY, fingerprint, NOW);
    expect(verifySession(generateSecret(), fingerprint, token, NOW)).toBeNull();
    const changed = passwordFingerprint(KEY, { ...RECORD, salt: 'ee'.repeat(16) });
    expect(verifySession(KEY, changed, token, NOW)).toBeNull();
  });

  it('is refused when re-signed by someone without the key', () => {
    const token = signSession(KEY, fingerprint, NOW);
    const [body = ''] = token.split('.');
    expect(verifySession(KEY, fingerprint, `${body}.${'A'.repeat(43)}`, NOW)).toBeNull();
  });

  it('is refused when correctly signed but not the current version or shape', () => {
    const good = { v: 1, iat: NOW, exp: NOW + 1000, pw: fingerprint };
    expect(verifySession(KEY, fingerprint, signPayload(KEY, good), NOW)).not.toBeNull();
    for (const payload of [
      { ...good, v: 2 },
      { ...good, exp: String(NOW + 1000) },
      { ...good, iat: NOW + 2000 },
      { v: 1, iat: NOW, exp: NOW + 1000 },
      null,
      [],
      'x',
    ]) {
      expect(
        verifySession(KEY, fingerprint, signPayload(KEY, payload), NOW),
        JSON.stringify(payload),
      ).toBeNull();
    }
  });

  it.each([undefined, '', '.', 'abc', 'abc.', '.abc', '!!!.???'])(
    'treats %j as no session',
    (token) => {
      expect(verifySession(KEY, fingerprint, token, NOW)).toBeNull();
    },
  );
});
