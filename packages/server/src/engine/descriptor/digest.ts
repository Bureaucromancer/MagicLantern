// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The effective descriptor's digest, for `route_snapshot` (A6): SHA-256 over
 * canonical JSON, so the same capabilities give the same digest however the
 * descriptor was assembled (key order never matters; array order does, since
 * a route's option order is what the picker shows).
 */

import { createHash } from 'node:crypto';

import type { RouteDescriptor } from '@bureaucromancer/lantern-schema';

/**
 * Canonical JSON: object keys sorted by code unit, no whitespace, properties
 * whose value is `undefined` left out (as `JSON.stringify` does). Numbers use
 * JavaScript's shortest round-trip form, which is deterministic.
 *
 * @param value plain JSON data
 * @throws TypeError on a non-finite number or a value JSON can't hold
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Not JSON: ${String(value)}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new TypeError(`Not JSON: ${typeof value}`);
}

/**
 * The digest of an effective descriptor: lowercase hex SHA-256 of its
 * canonical JSON.
 *
 * @param descriptor the effective descriptor
 */
export function descriptorDigest(descriptor: RouteDescriptor): string {
  return createHash('sha256').update(canonicalJson(descriptor), 'utf8').digest('hex');
}
