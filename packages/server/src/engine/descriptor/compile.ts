// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * One route and mode as one JSON Schema (A5): the {@link GenerationRequest}
 * schema with the effective descriptor's narrowing written in, for the
 * daemon's non-rewriting Ajv (rule 5).
 *
 * - **Absent is refused.** A field the mode doesn't list is taken out of its
 *   object, so the closed object refuses it at its own pointer
 *   (`/sampling/eta`). Inside an input, adapter or pass, where one item
 *   schema serves every role or kind, it is a `false` schema for that role
 *   (`/inputs/0/weight`); an unlisted role or kind is refused at its
 *   discriminator (`/inputs/0/role`).
 * - **Narrowing** is intersected with the request schema's own keywords; an
 *   adapter kind with options takes only their ids. `count` is capped at
 *   `emulated_max`, else `native_max`.
 * - **Ignored fields** keep the request schema's type and nothing more:
 *   accepted, and reported as ignored.
 * - **`mode`** is fixed to the mode compiled.
 * - **Extensions** for a backend kind the mode describes must meet its
 *   schema; other kinds stay open, to be reported as ignored.
 * - **Never compiled:** defaults (they belong to the resolver) and reasons.
 *
 * Counting items per role or kind needs `minContains`, which draft-07 lacks,
 * so collection `min` and `max` are checked in code by
 * {@link checkCollectionLimits}; {@link createRequestValidator} runs both.
 */

import {
  type FieldCapability,
  type FieldNarrowing,
  type GenerationMode,
  type GenerationRequest,
  GenerationRequest as GenerationRequestSchema,
  type ModeDescriptor,
  pickNarrowing,
  REQUEST_NODES,
  type RequestNode,
  type RouteDescriptor,
  type ValidationIssue,
  DISCRIMINATED_ARRAYS,
} from '@bureaucromancer/lantern-schema';
import type { Ajv, ErrorObject } from 'ajv';

import { pathOfIssue } from '../../validation/issues.js';
import { KEYWORD_ORDER } from './keywords.js';

/** A JSON Schema as plain data. */
export type JsonSchema = Record<string, unknown>;

type Group = keyof typeof DISCRIMINATED_ARRAYS;

/** The request schema as plain JSON: TypeBox's symbol keys dropped, safe to edit. */
function requestSchema(): JsonSchema {
  return JSON.parse(JSON.stringify(GenerationRequestSchema)) as JsonSchema;
}

function propertiesOf(schema: JsonSchema): Record<string, JsonSchema> {
  return schema['properties'] as Record<string, JsonSchema>;
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1);
}

/** The narrowing keywords for an entry, `count`'s limits folded into `maximum`. */
function narrowingOf(path: string, entry: FieldCapability): JsonSchema {
  if (entry.state === 'ignored') return {};
  const narrowing: JsonSchema = { ...pickNarrowing(entry) };
  if (path === 'count') {
    const limit = entry.emulated_max ?? entry.native_max;
    const maximum = narrowing['maximum'] as number | undefined;
    if (limit !== undefined && (maximum === undefined || limit < maximum)) {
      narrowing['maximum'] = limit;
    }
  }
  return narrowing;
}

/**
 * Write narrowing into a schema in place, intersecting with what it has: the
 * tighter bound wins, sets intersect, and a second `multipleOf` goes in an
 * `allOf`.
 */
function intersect(target: JsonSchema, narrowing: JsonSchema): void {
  for (const [keyword, value] of Object.entries(narrowing)) {
    const existing = target[keyword];
    if (existing === undefined) {
      target[keyword] = value;
      continue;
    }
    switch (KEYWORD_ORDER[keyword as keyof FieldNarrowing]) {
      case 'lower':
        target[keyword] = Math.max(existing as number, value as number);
        break;
      case 'upper':
        target[keyword] = Math.min(existing as number, value as number);
        break;
      case 'set':
        target[keyword] = (existing as unknown[]).filter((member) =>
          (value as unknown[]).includes(member),
        );
        break;
      default:
        target['allOf'] = [
          ...((target['allOf'] as unknown[] | undefined) ?? []),
          { [keyword]: value },
        ];
    }
  }
}

/**
 * Narrow a plain object's fields in place, removing the ones the mode doesn't
 * list. Returns whether any field is left.
 */
function narrowObject(schema: JsonSchema, node: RequestNode, mode: ModeDescriptor): boolean {
  const properties = propertiesOf(schema);
  for (const child of node.children) {
    const name = lastSegment(child.path);
    const target = properties[name];
    if (target === undefined) continue;
    if (child.kind === 'object') {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- an unlisted object
      if (!narrowObject(target, child, mode)) delete properties[name];
      continue;
    }
    const entry = mode.fields[child.path];
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- an unlisted field
    if (entry === undefined) delete properties[name];
    else intersect(target, narrowingOf(child.path, entry));
  }
  return Object.keys(properties).length > 0;
}

/**
 * The overlay for one role or kind of a collection item: each field's
 * narrowing, `false` for a field the mode doesn't list. Applied with
 * `if`/`then` beside the item's own schema, so it carries keywords only.
 */
function overlay(
  node: RequestNode,
  itemProperties: Record<string, JsonSchema>,
  mode: ModeDescriptor,
  adapterIds: readonly string[] | undefined,
): Record<string, JsonSchema | false> {
  const result: Record<string, JsonSchema | false> = {};
  for (const child of node.children) {
    const name = lastSegment(child.path);
    const target = itemProperties[name];
    if (target === undefined) continue;
    if (child.kind === 'object') {
      const nested = overlay(child, propertiesOf(target), mode, undefined);
      const listed = child.children.some((leaf) => leaf.path in mode.fields);
      if (!listed) result[name] = false;
      else if (Object.keys(nested).length > 0) result[name] = { properties: nested };
      continue;
    }
    const entry = mode.fields[child.path];
    if (entry === undefined) {
      result[name] = false;
      continue;
    }
    const narrowing = narrowingOf(child.path, entry);
    if (name === 'id' && adapterIds !== undefined) narrowing['enum'] = [...adapterIds];
    if (Object.keys(narrowing).length > 0) result[name] = narrowing;
  }
  return result;
}

function narrowCollection(
  root: Record<string, JsonSchema>,
  group: Group,
  mode: ModeDescriptor,
): void {
  const listed = Object.keys(mode[group] ?? {});
  if (listed.length === 0) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- an unlisted collection
    delete root[group];
    return;
  }
  const { key } = DISCRIMINATED_ARRAYS[group];
  const items = root[group]?.['items'] as JsonSchema;
  const itemProperties = propertiesOf(items);
  const description = itemProperties[key]?.['description'];
  itemProperties[key] = {
    type: 'string',
    enum: listed,
    ...(description === undefined ? {} : { description }),
  };

  const branches: JsonSchema[] = [];
  for (const value of listed) {
    const node = REQUEST_NODES.get(`${group}.${value}`);
    if (node === undefined) continue;
    const options =
      group === 'adapters'
        ? mode.adapters?.[value as 'lora' | 'embedding']?.options?.map((option) => option.id)
        : undefined;
    const properties = overlay(node, itemProperties, mode, options);
    if (Object.keys(properties).length === 0) continue;
    branches.push({
      if: { properties: { [key]: { const: value } }, required: [key] },
      then: { properties },
    });
  }
  if (branches.length > 0) items['allOf'] = branches;
}

/**
 * The JSON Schema for requests to one route in one mode.
 *
 * @param descriptor the route's effective descriptor
 * @param modeName the mode
 * @throws Error when the route doesn't serve the mode
 */
export function compileRequestSchema(
  descriptor: RouteDescriptor,
  modeName: GenerationMode,
): JsonSchema {
  const mode = descriptor.modes[modeName];
  if (mode === undefined) {
    throw new Error(`Route ${descriptor.route} does not serve ${modeName}`);
  }
  const schema = requestSchema();
  const root = propertiesOf(schema);
  root['mode'] = { const: modeName, description: root['mode']?.['description'] };

  for (const [name, property] of Object.entries(root)) {
    if (name === 'schema_version' || name === 'mode') continue;
    if (name === 'extensions') {
      if (mode.extensions !== undefined) property['properties'] = structuredClone(mode.extensions);
      continue;
    }
    if (name in DISCRIMINATED_ARRAYS) {
      narrowCollection(root, name as Group, mode);
      continue;
    }
    const node = REQUEST_NODES.get(name);
    if (node === undefined) continue;
    if (node.kind === 'object') {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- an unlisted object
      if (!narrowObject(property, node, mode)) delete root[name];
      continue;
    }
    const entry = mode.fields[name];
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- an unlisted field
    if (entry === undefined) delete root[name];
    else intersect(property, narrowingOf(name, entry));
  }
  schema['description'] = `A generation request for ${descriptor.route} in ${modeName}.`;
  return schema;
}

/**
 * Collection `min` and `max` per role or kind, which the compiled schema
 * can't count. Issues point at the array (`/inputs`), or at the request when
 * a required collection is missing altogether.
 *
 * @param request a request that passed the compiled schema
 * @param mode the mode's effective descriptor
 */
export function checkCollectionLimits(
  request: GenerationRequest,
  mode: ModeDescriptor,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const group of Object.keys(DISCRIMINATED_ARRAYS) as Group[]) {
    const { key } = DISCRIMINATED_ARRAYS[group];
    const items = (request[group] ?? []) as readonly Record<string, unknown>[];
    for (const [value, entry] of Object.entries(mode[group] ?? {})) {
      const count = items.filter((item) => item[key] === value).length;
      const noun = `\`${value}\` ${group === 'inputs' ? 'input' : group === 'adapters' ? 'adapter' : 'pass'}`;
      if (entry.max !== undefined && count > entry.max) {
        issues.push({
          path: `/${group}`,
          message: `at most ${String(entry.max)} ${noun}${entry.max === 1 ? '' : 's'} on this route`,
        });
      }
      if (entry.min !== undefined && count < entry.min) {
        issues.push({
          path: `/${group}`,
          message: `at least ${String(entry.min)} ${noun}${entry.min === 1 ? '' : 's'} on this route`,
        });
      }
    }
  }
  return issues;
}

/** Whether a JSON pointer names a request path, so an unlisted field reads as unsupported rather than unknown. */
function isRequestField(pointer: string): boolean {
  const path = pointer
    .split('/')
    .slice(1)
    .filter((segment) => !/^\d+$/.test(segment))
    .join('.');
  return REQUEST_NODES.has(path) || path in DISCRIMINATED_ARRAYS;
}

/**
 * Ajv's errors as 422 issues: one per pointer, in order. An `if` error only
 * repeats its `then` branch's errors at the item, so it is dropped; a field
 * the request schema has but the route doesn't list reads as unsupported.
 *
 * @param errors Ajv's errors for the compiled schema
 * @param modeName the mode, for messages
 */
export function issuesFromErrors(
  errors: readonly ErrorObject[],
  modeName: GenerationMode,
): ValidationIssue[] {
  const issues = new Map<string, ValidationIssue>();
  for (const error of errors) {
    if (error.keyword === 'if') continue;
    const path = pathOfIssue(error);
    if (issues.has(path)) continue;
    let message = error.message ?? 'is invalid';
    if (error.keyword === 'false schema') {
      message = `is not supported by this route in ${modeName}`;
    } else if (error.keyword === 'additionalProperties') {
      message = isRequestField(path)
        ? `is not supported by this route in ${modeName}`
        : 'is not a known field';
    } else if (error.keyword === 'required') {
      message = 'is required';
    }
    issues.set(path, { path, message });
  }
  return [...issues.values()];
}

/**
 * A validator for one route and mode: the compiled schema on the given Ajv,
 * then the collection limits. Compiles once; cache it by descriptor digest.
 *
 * @param ajv the daemon's Ajv (`createValidator()`)
 * @param descriptor the route's effective descriptor
 * @param modeName the mode
 * @returns a function from a request body to its issues, empty when valid
 */
export function createRequestValidator(
  ajv: Ajv,
  descriptor: RouteDescriptor,
  modeName: GenerationMode,
): (request: unknown) => ValidationIssue[] {
  const validate = ajv.compile(compileRequestSchema(descriptor, modeName));
  const mode = descriptor.modes[modeName];
  return (request) => {
    if (!validate(request)) return issuesFromErrors(validate.errors ?? [], modeName);
    // compileRequestSchema threw if the route lacks the mode.
    return mode === undefined ? [] : checkCollectionLimits(request as GenerationRequest, mode);
  };
}
