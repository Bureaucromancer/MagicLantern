// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { type TObject, type TOptional, type TSchema, Type } from '@sinclair/typebox';

/**
 * A closed object with one optional property per key, typed by key: a mode
 * map, or a collection map keyed by input role. Internal to the descriptor
 * module.
 *
 * @param keys the keys, e.g. `INPUT_ROLES`
 * @param value the schema of each value
 * @param description what the map holds
 */
export function partialRecord<K extends string, T extends TSchema>(
  keys: readonly K[],
  value: T,
  description: string,
): TObject<Record<K, TOptional<T>>> {
  const optional = Type.Optional(value) as TOptional<T>;
  const properties = Object.fromEntries(keys.map((key) => [key, optional])) as Record<
    K,
    TOptional<T>
  >;
  return Type.Object(properties, { additionalProperties: false, description });
}
