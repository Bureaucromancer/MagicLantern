// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Comparing and combining narrowing values (A6): whether a proposed keyword
 * value narrows or widens the current one, and what a layer that may only do
 * one of those ends up with. Shared by field keywords (`maximum`, `enum`) and
 * collection limits (`max`, `media`), which follow the same orders.
 */

import type { FieldNarrowing } from '@bureaucromancer/lantern-schema';

/** How a keyword orders its values. */
export type KeywordOrder =
  /** Larger is narrower: `minimum`, `exclusiveMinimum`, `minLength`, collection `min`. */
  | 'lower'
  /** Smaller is narrower: `maximum`, `exclusiveMaximum`, `maxLength`, collection `max`, `native_max`. */
  | 'upper'
  /** A subset is narrower: `enum`, collection `media`. */
  | 'set'
  /** A multiple is narrower: `multipleOf`. */
  | 'multiple';

export const KEYWORD_ORDER: Readonly<Record<keyof FieldNarrowing, KeywordOrder>> = {
  minimum: 'lower',
  exclusiveMinimum: 'lower',
  minLength: 'lower',
  maximum: 'upper',
  exclusiveMaximum: 'upper',
  maxLength: 'upper',
  multipleOf: 'multiple',
  enum: 'set',
};

export type Comparison = 'equal' | 'narrower' | 'wider' | 'incomparable';

/** A keyword's value: a bound or a set of allowed values. */
export type KeywordValue = number | readonly (string | number)[];

const MULTIPLE_TOLERANCE = 1e-9;

function isMultiple(value: number, of: number): boolean {
  const quotient = value / of;
  return Math.abs(quotient - Math.round(quotient)) < MULTIPLE_TOLERANCE;
}

/**
 * How a proposed value compares with the current one. A keyword the entry
 * doesn't have yet admits everything, so adding one always narrows.
 *
 * @param order how the keyword orders values
 * @param current the current value, or undefined when the entry has none
 * @param proposed the proposed value
 */
export function compareKeyword(
  order: KeywordOrder,
  current: KeywordValue | undefined,
  proposed: KeywordValue,
): Comparison {
  if (current === undefined) return 'narrower';
  if (order === 'set') {
    const now = new Set(current as readonly (string | number)[]);
    const next = new Set(proposed as readonly (string | number)[]);
    const subset = [...next].every((value) => now.has(value));
    const superset = [...now].every((value) => next.has(value));
    if (subset && superset) return 'equal';
    if (subset) return 'narrower';
    if (superset) return 'wider';
    return 'incomparable';
  }
  const a = current as number;
  const b = proposed as number;
  if (a === b) return 'equal';
  switch (order) {
    case 'lower':
      return b > a ? 'narrower' : 'wider';
    case 'upper':
      return b < a ? 'narrower' : 'wider';
    case 'multiple':
      if (isMultiple(b, a)) return 'narrower';
      if (isMultiple(a, b)) return 'wider';
      return 'incomparable';
  }
}

/** What a layer gets from one keyword: the value to store (if it changes), and a note (if anything was refused). */
export interface KeywordOutcome {
  readonly value?: KeywordValue;
  readonly note?: string;
}

function show(value: KeywordValue): string {
  return JSON.stringify(value);
}

/**
 * The part of a proposed keyword value a layer may apply, given the one
 * direction it may move in: profiles narrow, overrides widen. Where only part
 * of a set moves the right way, that part is applied and the rest noted
 * (intersection for a profile, union for an override); a bound or multiple
 * that moves the wrong way is refused whole.
 *
 * @param direction `narrow` for profiles, `widen` for overrides
 * @param keyword the keyword's name, for notes
 * @param order how the keyword orders values
 * @param current the current value, or undefined
 * @param proposed the proposed value
 */
export function applyKeyword(
  direction: 'narrow' | 'widen',
  keyword: string,
  order: KeywordOrder,
  current: KeywordValue | undefined,
  proposed: KeywordValue,
): KeywordOutcome {
  const comparison = compareKeyword(order, current, proposed);
  if (comparison === 'equal') return {};
  const wanted = direction === 'narrow' ? 'narrower' : 'wider';
  if (comparison === wanted) return { value: proposed };

  if (comparison === 'incomparable' && order === 'set' && current !== undefined) {
    const now = current as readonly (string | number)[];
    const next = proposed as readonly (string | number)[];
    if (direction === 'narrow') {
      const kept = now.filter((value) => next.includes(value));
      const dropped = next.filter((value) => !now.includes(value));
      if (kept.length === 0) {
        return {
          note: `\`${keyword}\` ${show(next)} shares no value with the route's ${show(now)}; not applied`,
        };
      }
      return {
        value: kept,
        note: `\`${keyword}\` values ${show(dropped)} are not on the route; narrowed to ${show(kept)}`,
      };
    }
    const added = next.filter((value) => !now.includes(value));
    const kept = now.filter((value) => !next.includes(value));
    return {
      value: [...now, ...added],
      note: `\`${keyword}\` would drop ${show(kept)}, which only narrowing may do; kept them and added ${show(added)}`,
    };
  }

  const before = current === undefined ? 'none' : show(current);
  return direction === 'narrow'
    ? {
        note: `\`${keyword}\` ${show(proposed)} is not narrower than the route's ${before}; kept the route's`,
      }
    : {
        note: `\`${keyword}\` ${show(proposed)} would narrow the route's ${before}; overrides may only add or widen`,
      };
}
