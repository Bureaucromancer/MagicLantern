// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The request schema of one field path, so a profile's defaults can be checked
 * against the type the request gives that field. The grammar is
 * `REQUEST_PATHS`': dot-separated names, with an input, adapter or pass array
 * entered through its discriminator value (`inputs.ref.weight`).
 */

import {
  ADAPTER_KINDS,
  Adapter,
  GenerationRequest,
  INPUT_ROLES,
  Input,
  PASS_KINDS,
  PASS_SCHEMAS,
  REQUEST_PATHS,
} from '@bureaucromancer/lantern-schema';
import { KindGuard, type TObject, type TSchema } from '@sinclair/typebox';

/** Each discriminated array's item schema per discriminator value. */
function memberSchema(array: string, value: string): TObject | undefined {
  switch (array) {
    case 'inputs':
      return (INPUT_ROLES as readonly string[]).includes(value) ? Input : undefined;
    case 'adapters':
      return (ADAPTER_KINDS as readonly string[]).includes(value) ? Adapter : undefined;
    case 'passes':
      return (PASS_KINDS as readonly string[]).includes(value)
        ? PASS_SCHEMAS[value as keyof typeof PASS_SCHEMAS]
        : undefined;
    default:
      return undefined;
  }
}

const FIELD_PATHS: ReadonlySet<string> = new Set(
  REQUEST_PATHS.filter((p) => p.kind === 'field' && p.experimental !== true).map((p) => p.path),
);

/**
 * The schema of a field path, or `undefined` when the path names no
 * non-experimental field (a collection, an unknown path, or `subjects`).
 *
 * @param path a field path, e.g. `sampling.steps`
 */
export function requestFieldSchema(path: string): TSchema | undefined {
  if (!FIELD_PATHS.has(path)) return undefined;
  const [head, ...rest] = path.split('.');
  if (head === undefined) return undefined;
  let schema: TSchema | undefined;
  if (head === 'inputs' || head === 'adapters' || head === 'passes') {
    const value = rest.shift();
    schema = value === undefined ? undefined : memberSchema(head, value);
  } else {
    schema = GenerationRequest.properties[head as keyof typeof GenerationRequest.properties];
  }
  for (const name of rest) {
    if (schema === undefined || !KindGuard.IsObject(schema)) return undefined;
    schema = schema.properties[name];
  }
  return schema;
}
