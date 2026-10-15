// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Field paths: one grammar naming every canonical field, for capability
 * descriptors and the field report (A5). Generated from the
 * {@link GenerationRequest} schema, so a new field gets a path without anyone
 * remembering to add one.
 *
 * The grammar is dot-separated property names, except that an array of
 * inputs, adapters or passes is entered through its discriminator's value
 * rather than an index: `sampling.steps`, `inputs.ref.weight`,
 * `adapters.lora.weight`, `passes.hires.scale`.
 *
 * - **Collections** are those discriminated arrays per value (`inputs.ref`,
 *   `adapters.lora`, `passes.hires`), which descriptors give
 *   `{state, min, max, media}`. The discriminator itself has no path.
 * - **Fields** are everything else that holds a value. A `SourceRect` is one
 *   value (`inputs.ref.crop`), not four.
 * - **Not listed:** `schema_version` and `mode` (a descriptor is keyed by
 *   mode), and `extensions` (described by the descriptor's own `extensions`
 *   block, per backend kind).
 * - **Experimental** `subjects` and `style` are listed as one path each, marked
 *   experimental, until they are designed at 0.5.
 */

import { KindGuard, type TObject, type TSchema } from '@sinclair/typebox';

import {
  ADAPTER_KINDS,
  Adapter,
  GenerationRequest,
  INPUT_ROLES,
  Input,
  PASS_KINDS,
  PASS_SCHEMAS,
  SourceRect,
} from './generation-request.js';

export interface RequestPath {
  /** The path, e.g. `inputs.ref.weight`. */
  readonly path: string;
  /** `collection` for a discriminated array per value, `field` for a value. */
  readonly kind: 'collection' | 'field';
  /** Present on fields reserved for later design (subjects, style). */
  readonly experimental?: true;
}

/** Top-level properties with no path; see the module comment. */
const UNLISTED: ReadonlySet<string> = new Set(['schema_version', 'mode', 'extensions']);

/** Top-level properties listed as one experimental path. */
const EXPERIMENTAL: ReadonlySet<string> = new Set(['subjects', 'style']);

/**
 * The discriminated arrays: each value of the discriminator, and the schema of
 * the item that value selects. Passes have a schema per kind; inputs and
 * adapters share one shape across values.
 */
const DISCRIMINATED: Readonly<
  Record<string, { readonly key: string; readonly members: readonly [string, TObject][] }>
> = {
  inputs: { key: 'role', members: INPUT_ROLES.map((role) => [role, Input]) },
  adapters: { key: 'kind', members: ADAPTER_KINDS.map((kind) => [kind, Adapter]) },
  passes: { key: 'kind', members: PASS_KINDS.map((kind) => [kind, PASS_SCHEMAS[kind]]) },
};

function isSourceRect(schema: TSchema): boolean {
  return KindGuard.IsObject(schema) && schema.title === SourceRect.title;
}

/** The fields under an object, recursing into nested objects other than a `SourceRect`. */
function objectPaths(schema: TObject, prefix: string, skip?: string): RequestPath[] {
  const paths: RequestPath[] = [];
  for (const [name, property] of Object.entries(schema.properties)) {
    if (name === skip) continue;
    const path = `${prefix}.${name}`;
    if (KindGuard.IsObject(property) && !isSourceRect(property)) {
      paths.push(...objectPaths(property, path));
    } else {
      paths.push({ path, kind: 'field' });
    }
  }
  return paths;
}

/**
 * Every path in a request schema, in schema order. Exported for tests and for
 * descriptor work; {@link REQUEST_PATHS} is its result for
 * {@link GenerationRequest}.
 *
 * @param schema the request schema
 */
export function listRequestPaths(schema: TObject = GenerationRequest): RequestPath[] {
  const paths: RequestPath[] = [];
  for (const [name, property] of Object.entries(schema.properties)) {
    if (UNLISTED.has(name)) continue;
    if (EXPERIMENTAL.has(name)) {
      const kind = KindGuard.IsArray(property) ? 'collection' : 'field';
      paths.push({ path: name, kind, experimental: true });
      continue;
    }
    const discriminated = DISCRIMINATED[name];
    if (discriminated !== undefined) {
      for (const [value, member] of discriminated.members) {
        const path = `${name}.${value}`;
        paths.push({ path, kind: 'collection' });
        paths.push(...objectPaths(member, path, discriminated.key));
      }
    } else if (KindGuard.IsObject(property)) {
      paths.push(...objectPaths(property, name));
    } else if (KindGuard.IsArray(property)) {
      throw new Error(`No path rule for the array \`${name}\`: add it to DISCRIMINATED.`);
    } else {
      paths.push({ path: name, kind: 'field' });
    }
  }
  return paths;
}

/** Every path in {@link GenerationRequest}. */
export const REQUEST_PATHS: readonly RequestPath[] = listRequestPaths();

/** The same paths as strings, for membership checks. */
export const REQUEST_PATH_SET: ReadonlySet<string> = new Set(REQUEST_PATHS.map((p) => p.path));
