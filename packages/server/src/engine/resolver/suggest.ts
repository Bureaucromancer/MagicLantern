// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Suggested values for a 422 (A3): the resolver never changes a value the
 * request set, so a value the route can't take is refused, and the issue
 * carries the nearest value it can (the UI snaps to it before submitting).
 *
 * Numbers are clamped to the bounds and snapped to `multipleOf` and to
 * integers; a value outside an `enum` suggests the nearest number, or the
 * route's default, or the first listed value. No suggestion is made where
 * none is obvious (a string over `maxLength`, an exclusive bound on a
 * non-integer).
 */

import { type FieldNarrowing, satisfiesNarrowing } from '@bureaucromancer/lantern-schema';
import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/** Significant digits kept after snapping, so 0.1 × 3 suggests 0.3, not 0.30000000000000004. */
const PRECISION = 12;

/** The numeric keywords of a field's own schema; a union (the seed) contributes its integer member's. */
function schemaBounds(schema: TSchema): { narrowing: FieldNarrowing; integer: boolean } {
  const narrowing: Record<string, number> = {};
  let integer = false;
  const visit = (node: Record<string, unknown>): void => {
    const type = node['type'];
    if (type === 'integer') integer = true;
    if (type === 'integer' || type === 'number') {
      for (const keyword of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
        const value = node[keyword];
        if (typeof value === 'number') narrowing[keyword] = value;
      }
    }
    const anyOf = node['anyOf'];
    if (Array.isArray(anyOf)) for (const member of anyOf) visit(member as Record<string, unknown>);
  };
  visit(schema);
  return { narrowing, integer };
}

function tidy(value: number): number {
  return Number.parseFloat(value.toPrecision(PRECISION));
}

function suggestNumber(value: number, all: FieldNarrowing[], integer: boolean): number | undefined {
  let lower = -Infinity;
  let upper = Infinity;
  let multiple: number | undefined;
  for (const n of all) {
    if (n.minimum !== undefined) lower = Math.max(lower, n.minimum);
    if (n.maximum !== undefined) upper = Math.min(upper, n.maximum);
    if (n.exclusiveMinimum !== undefined) {
      if (!integer) return undefined;
      lower = Math.max(lower, Math.floor(n.exclusiveMinimum) + 1);
    }
    if (n.exclusiveMaximum !== undefined) {
      if (!integer) return undefined;
      upper = Math.min(upper, Math.ceil(n.exclusiveMaximum) - 1);
    }
    if (n.multipleOf !== undefined) multiple = n.multipleOf;
  }
  if (integer) {
    lower = Math.ceil(lower);
    upper = Math.floor(upper);
  }
  let candidate = Math.min(Math.max(value, lower), upper);
  if (multiple !== undefined) {
    candidate = tidy(Math.round(candidate / multiple) * multiple);
    if (candidate < lower) candidate = tidy(candidate + multiple);
    if (candidate > upper) candidate = tidy(candidate - multiple);
  }
  if (integer && !Number.isInteger(candidate)) {
    const rounded = Math.round(candidate);
    candidate = rounded < lower ? rounded + 1 : rounded > upper ? rounded - 1 : rounded;
  }
  return candidate;
}

/**
 * A value close to `value` that the field accepts, or `undefined` when there
 * is no obvious one or `value` is already accepted.
 *
 * @param value the refused value
 * @param schema the field's schema in the request (`REQUEST_NODES`)
 * @param narrowing the route's narrowing for the field, if any
 * @param fallback a value to prefer for an `enum` of strings: the route's default
 */
export function suggestValue(
  value: unknown,
  schema: TSchema,
  narrowing: FieldNarrowing = {},
  fallback?: unknown,
): unknown {
  const own = schemaBounds(schema);
  const all = [own.narrowing, narrowing];
  const accepts = (candidate: unknown): boolean =>
    Value.Check(schema, candidate) && all.every((n) => satisfiesNarrowing(candidate, n));
  if (accepts(value)) return undefined;

  if (narrowing.enum !== undefined) {
    const members = narrowing.enum.filter(accepts);
    if (members.length === 0) return undefined;
    if (typeof value === 'number') {
      const numbers = members.filter((member): member is number => typeof member === 'number');
      if (numbers.length > 0) {
        return numbers.reduce((best, member) =>
          Math.abs(member - value) < Math.abs(best - value) ? member : best,
        );
      }
    }
    return members.includes(fallback as string | number) ? fallback : members[0];
  }

  if (typeof value !== 'number') return undefined;
  const candidate = suggestNumber(value, all, own.integer);
  return candidate !== undefined && candidate !== value && accepts(candidate)
    ? candidate
    : undefined;
}
