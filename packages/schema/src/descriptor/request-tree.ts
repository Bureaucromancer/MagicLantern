// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The request path grammar as a tree: each field and collection path with the
 * schema of its value and whether its parent requires it, plus the plain
 * objects between them (`sampling`, `passes.hires.target`). Descriptor checks
 * use it to tell which keywords suit a field and which fields a mode must
 * list; the validator compiler uses it to find where each narrowing goes.
 *
 * Built from the same {@link GenerationRequest} schema as `REQUEST_PATHS`, by
 * the same rules (see `request/paths.ts`); a test holds the two to the same
 * list in the same order.
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
} from '../request/generation-request.js';

export interface RequestNode {
  /** The path, e.g. `inputs.ref.weight`; for an object, the path its fields share. */
  readonly path: string;
  /**
   * `field` and `collection` as in `REQUEST_PATHS`; `object` for a plain
   * object whose fields are listed one by one (it has no entry of its own).
   */
  readonly kind: 'field' | 'collection' | 'object';
  /** The value's schema; for a collection, its item schema for that value. */
  readonly schema: TSchema;
  /** Whether the enclosing object requires it. Collections are never required. */
  readonly required: boolean;
  /** Fields of an object or a collection item, the discriminator excepted. */
  readonly children: readonly RequestNode[];
  readonly experimental?: true;
}

/** A discriminated array: its key, and the item schema each value selects. */
export interface Discriminated {
  readonly key: string;
  readonly members: readonly (readonly [string, TObject])[];
}

/** The arrays entered through their discriminator's value. */
export const DISCRIMINATED_ARRAYS: Readonly<
  Record<'inputs' | 'adapters' | 'passes', Discriminated>
> = {
  inputs: { key: 'role', members: INPUT_ROLES.map((role) => [role, Input] as const) },
  adapters: { key: 'kind', members: ADAPTER_KINDS.map((kind) => [kind, Adapter] as const) },
  passes: { key: 'kind', members: PASS_KINDS.map((kind) => [kind, PASS_SCHEMAS[kind]] as const) },
};

const UNLISTED: ReadonlySet<string> = new Set(['schema_version', 'mode', 'extensions']);
const EXPERIMENTAL: ReadonlySet<string> = new Set(['subjects', 'style']);

function isSourceRect(schema: TSchema): boolean {
  return KindGuard.IsObject(schema) && schema.title === SourceRect.title;
}

function objectChildren(schema: TObject, prefix: string, skip?: string): RequestNode[] {
  const required = new Set(schema.required ?? []);
  const nodes: RequestNode[] = [];
  for (const [name, property] of Object.entries(schema.properties)) {
    if (name === skip) continue;
    const path = `${prefix}.${name}`;
    const isRequired = required.has(name);
    if (KindGuard.IsObject(property) && !isSourceRect(property)) {
      nodes.push({
        path,
        kind: 'object',
        schema: property,
        required: isRequired,
        children: objectChildren(property, path),
      });
    } else {
      nodes.push({ path, kind: 'field', schema: property, required: isRequired, children: [] });
    }
  }
  return nodes;
}

function buildTree(): RequestNode[] {
  const required = new Set<string>(GenerationRequest.required);
  const nodes: RequestNode[] = [];
  for (const [name, property] of Object.entries(GenerationRequest.properties)) {
    if (UNLISTED.has(name)) continue;
    const isRequired = required.has(name);
    if (EXPERIMENTAL.has(name)) {
      const kind = KindGuard.IsArray(property) ? 'collection' : 'field';
      nodes.push({
        path: name,
        kind,
        schema: property,
        required: false,
        children: [],
        experimental: true,
      });
      continue;
    }
    const discriminated = DISCRIMINATED_ARRAYS[name as keyof typeof DISCRIMINATED_ARRAYS] as
      Discriminated | undefined;
    if (discriminated !== undefined) {
      for (const [value, member] of discriminated.members) {
        const path = `${name}.${value}`;
        nodes.push({
          path,
          kind: 'collection',
          schema: member,
          required: false,
          children: objectChildren(member, path, discriminated.key),
        });
      }
    } else if (KindGuard.IsObject(property)) {
      nodes.push({
        path: name,
        kind: 'object',
        schema: property,
        required: isRequired,
        children: objectChildren(property, name),
      });
    } else {
      nodes.push({
        path: name,
        kind: 'field',
        schema: property,
        required: isRequired,
        children: [],
      });
    }
  }
  return nodes;
}

/** The top-level nodes, in schema order. */
export const REQUEST_TREE: readonly RequestNode[] = buildTree();

function flatten(nodes: readonly RequestNode[]): RequestNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

/** Every node by path, objects included, in schema order. */
export const REQUEST_NODES: ReadonlyMap<string, RequestNode> = new Map(
  flatten(REQUEST_TREE).map((node) => [node.path, node]),
);

/** The JSON types a value at this schema may take, as far as narrowing cares. */
export type NarrowableType = 'number' | 'string';

/**
 * The JSON types a field's schema admits that narrowing keywords apply to:
 * numeric keywords need `number`, length keywords `string`. A union (the seed
 * is `"random"` or an integer) admits both.
 *
 * @param schema a field's schema
 */
export function narrowableTypes(schema: TSchema): ReadonlySet<NarrowableType> {
  const types = new Set<NarrowableType>();
  const visit = (node: Record<string, unknown>): void => {
    const type = node['type'];
    if (type === 'number' || type === 'integer') types.add('number');
    if (type === 'string') types.add('string');
    const anyOf = node['anyOf'];
    if (Array.isArray(anyOf)) for (const member of anyOf) visit(member as Record<string, unknown>);
  };
  visit(schema);
  return types;
}
