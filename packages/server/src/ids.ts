// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Row ids: monotonic ULIDs (plan, stack details), optionally behind a type
 * prefix (`lib_01J…`).
 *
 * A ULID is a 48-bit millisecond timestamp and 80 random bits, written as 26
 * Crockford base32 characters, so ids sort by creation time as plain strings.
 * **Monotonic**: within one millisecond (or when the clock steps backwards) the
 * generator increments the previous random part instead of drawing a new one,
 * so ids from one process always sort in the order they were made. That is the
 * property a cursor on `(created_at, id)` relies on, and the reason this is not
 * Node's `randomUUIDv7()`, which measurably reorders within a millisecond.
 *
 * No dependency: the whole algorithm is the encoder and the increment below.
 */

/** Crockford's base32: no I, L, O or U, so ids survive being read aloud or retyped. */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const TIME_LENGTH = 10;
const RANDOM_BYTES = 10;
const TIME_MAX = 2 ** 48 - 1;

/** A ULID: the first character is at most 7, because the timestamp is 48 bits. */
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Prefixes are short lowercase type tags: `lib`, `job`, `proc`. */
const PREFIX_PATTERN = /^[a-z][a-z0-9]*$/;

/** Fills a buffer with random bytes. Injectable so tests can force the edge cases. */
export type RandomSource = (bytes: Uint8Array<ArrayBuffer>) => void;

const cryptoRandom: RandomSource = (bytes) => {
  crypto.getRandomValues(bytes);
};

export interface UlidGeneratorOptions {
  random?: RandomSource;
}

function encodeTime(ms: number): string {
  let out = '';
  let rest = ms;
  for (let i = 0; i < TIME_LENGTH; i += 1) {
    out = ENCODING.charAt(rest % 32) + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/** 80 bits are exactly 16 five-bit characters, so nothing is left over. */
function encodeRandom(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ENCODING.charAt((buffer >>> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}

/** Adds one to a big-endian number in place. False when it wrapped to zero. */
function increment(bytes: Uint8Array): boolean {
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    const value = bytes[i] ?? 0;
    if (value < 0xff) {
      bytes[i] = value + 1;
      return true;
    }
    bytes[i] = 0;
  }
  return false;
}

/**
 * An independent monotonic generator. Stateful by nature (it remembers the last
 * millisecond and random part), so tests that need an uncontaminated sequence
 * make their own; everything else uses {@link ulid}.
 *
 * `now` is a floor rather than a promise: a clock that went backwards keeps the
 * last millisecond seen, trading a little timestamp accuracy for ordering.
 */
export function createUlidGenerator(options: UlidGeneratorOptions = {}): (now?: number) => string {
  const random = options.random ?? cryptoRandom;
  const last: Uint8Array<ArrayBuffer> = new Uint8Array(RANDOM_BYTES);
  let lastMs = -1;

  return function next(now: number = Date.now()): string {
    if (!Number.isSafeInteger(now) || now < 0 || now > TIME_MAX) {
      throw new RangeError(`A ULID timestamp must be an integer in [0, 2^48); got ${String(now)}.`);
    }

    if (now > lastMs) {
      lastMs = now;
      random(last);
    } else if (!increment(last)) {
      // 2^80 ids in one millisecond cannot happen with honest randomness; it
      // means the draw started at the very top. Moving to the next millisecond
      // keeps the order, which is the invariant callers rely on.
      if (lastMs === TIME_MAX) throw new RangeError('ULID timestamp space exhausted.');
      lastMs += 1;
      random(last);
    }

    return encodeTime(lastMs) + encodeRandom(last);
  };
}

/** The shared generator: monotonic across every id this process mints. */
export const ulid = createUlidGenerator();

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

/** The millisecond timestamp a ULID carries. */
export function ulidTimestamp(id: string): number {
  if (!isUlid(id)) throw new TypeError(`Not a ULID: ${id}`);
  let ms = 0;
  for (const char of id.slice(0, TIME_LENGTH)) {
    ms = ms * 32 + ENCODING.indexOf(char);
  }
  return ms;
}

/** A typed id: `newId('lib')` → `lib_01J…`. */
export function newId<P extends string>(prefix: P): `${P}_${string}` {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new TypeError(`An id prefix is lowercase letters and digits; got "${prefix}".`);
  }
  return `${prefix}_${ulid()}`;
}
