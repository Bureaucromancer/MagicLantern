// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The install-wide password as a scrypt record (SK7). The parameters are stored
 * with the hash, so the cost can be raised later without stranding a record
 * written today.
 *
 * scrypt rather than argon2id because it ships in node:crypto: no native
 * module, and the threat model is a household or homelab install.
 */

import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

import type { PasswordRecord } from '../store/secrets.js';

/**
 * N = 2^15, r = 8, p = 1 (OWASP's floor for scrypt), 64-byte key, 16-byte salt.
 * That needs a little over 32 MiB, Node's default `maxmem`, so the call fails
 * unless {@link scryptMaxmem} sizes it from the parameters.
 */
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, keyLen: 64 } as const;
const SALT_BYTES = 16;

/** scrypt needs 128·N·r bytes; doubled for headroom, as Node counts its own overhead. */
export function scryptMaxmem(N: number, r: number): number {
  return 256 * N * r;
}

function scrypt(
  password: string,
  salt: Buffer,
  keyLen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLen, options, (error, key) => {
      if (error === null) resolve(key);
      else reject(error);
    });
  });
}

/** Any string is a password, the empty one included: a KDF is not where a policy belongs. */
export async function hashPassword(password: string): Promise<PasswordRecord> {
  const { N, r, p, keyLen } = SCRYPT_PARAMS;
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(password, salt, keyLen, { N, r, p, maxmem: scryptMaxmem(N, r) });
  return { alg: 'scrypt', N, r, p, keyLen, salt: salt.toString('hex'), hash: hash.toString('hex') };
}

/** Constant-time check against a record, with its own recorded parameters. */
export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  const expected = Buffer.from(record.hash, 'hex');
  const actual = await scrypt(password, Buffer.from(record.salt, 'hex'), record.keyLen, {
    N: record.N,
    r: record.r,
    p: record.p,
    maxmem: scryptMaxmem(record.N, record.r),
  });
  // timingSafeEqual throws on a length mismatch; a mismatch is simply "no".
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** A random key for signing session cookies (32 bytes, base64url). */
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison, for tokens rather than password hashes. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
