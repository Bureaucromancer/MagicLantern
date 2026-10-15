// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * A request's values by field path and by JSON pointer. The field-path grammar
 * (`REQUEST_PATHS`) names a field for every item of a role or kind
 * (`inputs.ref.weight`); a pointer names one value (`/inputs/1/weight`). The
 * field report is keyed by pointer and carries the field path, so the
 * descriptor entry is one lookup away.
 */

import {
  DISCRIMINATED_ARRAYS,
  pointerSegment,
  REQUEST_NODES,
} from '@bureaucromancer/lantern-schema';

/** One value in a request. */
export interface Leaf {
  /** JSON pointer, e.g. `/inputs/1/weight`. */
  readonly pointer: string;
  /** Field path, e.g. `inputs.ref.weight`; `extensions.<kind>` for an extension block. */
  readonly field: string;
  /** The collection the value belongs to, e.g. `inputs.ref`. */
  readonly collection?: string;
  readonly value: unknown;
}

type Group = keyof typeof DISCRIMINATED_ARRAYS;

function isGroup(name: string): name is Group {
  return name in DISCRIMINATED_ARRAYS;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Top-level properties that are not values: the version and the mode. */
const NOT_VALUES: ReadonlySet<string> = new Set(['schema_version', 'mode']);

function objectLeaves(
  object: Record<string, unknown>,
  pointer: string,
  field: string,
  collection: string | undefined,
  skip?: string,
): Leaf[] {
  const leaves: Leaf[] = [];
  for (const [name, value] of Object.entries(object)) {
    if (name === skip || value === undefined) continue;
    const childPointer = `${pointer}/${pointerSegment(name)}`;
    const childField = `${field}.${name}`;
    const node = REQUEST_NODES.get(childField);
    if (node?.kind === 'object' && isRecord(value)) {
      leaves.push(...objectLeaves(value, childPointer, childField, collection));
    } else {
      leaves.push({
        pointer: childPointer,
        field: childField,
        ...(collection === undefined ? {} : { collection }),
        value,
      });
    }
  }
  return leaves;
}

/**
 * Every value in a request, in property order: each field (a `SourceRect`
 * and the experimental `subjects` and `style` count as one value), and each
 * backend kind's `extensions` block as one value. The version, the mode and
 * the discriminators (`role`, `kind`) are not values.
 *
 * @param request a request that passed schema validation
 */
export function requestLeaves(request: Readonly<Record<string, unknown>>): Leaf[] {
  const leaves: Leaf[] = [];
  for (const [name, value] of Object.entries(request)) {
    if (NOT_VALUES.has(name) || value === undefined) continue;
    const pointer = `/${pointerSegment(name)}`;
    if (name === 'extensions' && isRecord(value)) {
      for (const [kind, block] of Object.entries(value)) {
        leaves.push({
          pointer: `${pointer}/${pointerSegment(kind)}`,
          field: `extensions.${kind}`,
          value: block,
        });
      }
    } else if (isGroup(name) && Array.isArray(value)) {
      const { key } = DISCRIMINATED_ARRAYS[name];
      value.forEach((item: unknown, i) => {
        if (!isRecord(item)) return;
        const collection = `${name}.${String(item[key])}`;
        leaves.push(...objectLeaves(item, `${pointer}/${String(i)}`, collection, collection, key));
      });
    } else if (REQUEST_NODES.get(name)?.kind === 'object' && isRecord(value)) {
      leaves.push(...objectLeaves(value, pointer, name, undefined));
    } else {
      leaves.push({ pointer, field: name, value });
    }
  }
  return leaves;
}

/** A JSON pointer's segments, unescaped. `''` is the whole document. */
export function pointerSegments(pointer: string): string[] {
  if (pointer === '') return [];
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/** The value at a JSON pointer, or `undefined`. */
export function valueAt(document: unknown, pointer: string): unknown {
  let current: unknown = document;
  for (const segment of pointerSegments(pointer)) {
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (isRecord(current)) current = current[segment];
    else return undefined;
  }
  return current;
}

/**
 * The field path a pointer into a request names: array indices under
 * `inputs`, `adapters` and `passes` become the item's role or kind
 * (`/inputs/1/weight` → `inputs.ref.weight`). `undefined` when the pointer
 * runs through something the request does not have.
 *
 * @param request the request the pointer points into
 * @param pointer the pointer
 */
export function fieldOfPointer(request: unknown, pointer: string): string | undefined {
  const segments = pointerSegments(pointer);
  const [head, index, ...rest] = segments;
  if (head === undefined) return undefined;
  if (isGroup(head)) {
    if (index === undefined) return head;
    const item = valueAt(request, `/${head}/${index}`);
    if (!isRecord(item)) return undefined;
    const value = item[DISCRIMINATED_ARRAYS[head].key];
    if (typeof value !== 'string') return undefined;
    return [head, value, ...rest].join('.');
  }
  return segments.join('.');
}
