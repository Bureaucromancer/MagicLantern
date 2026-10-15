// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The descriptor rules a schema can't state (A5). Run after schema
 * validation: a descriptor is valid when it passes both.
 *
 * Each issue's `path` is a JSON pointer into the descriptor, e.g.
 * `/modes/txt2img/fields/sampling.steps/maximum`, so an adapter author sees the
 * entry at fault.
 */

import { Value } from '@sinclair/typebox/value';

import type { ValidationIssue } from '../api/errors.js';
import { MODE_REQUIRED_INPUTS } from '../request/check.js';
import type { GenerationMode } from '../request/generation-request.js';
import { REQUEST_PATH_SET } from '../request/paths.js';
import type { FieldCapability, ModeDescriptor, RouteDescriptor } from './descriptor.js';
import { NARROWING_KEYWORDS } from './descriptor.js';
import type { FieldNarrowing } from './narrowing.js';
import { narrowableTypes, REQUEST_NODES, REQUEST_TREE, type RequestNode } from './request-tree.js';

/** One JSON pointer segment (RFC 6901). */
export function pointerSegment(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

const NUMERIC_KEYWORDS: ReadonlySet<keyof FieldNarrowing> = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
]);
const LENGTH_KEYWORDS: ReadonlySet<keyof FieldNarrowing> = new Set(['minLength', 'maxLength']);

/** Slack for `multipleOf` on decimals, which binary floating point can't hold exactly. */
const MULTIPLE_TOLERANCE = 1e-9;

/** The narrowing keywords an entry carries, and nothing else. */
export function pickNarrowing(entry: FieldNarrowing): FieldNarrowing {
  const narrowing: Record<string, unknown> = {};
  for (const keyword of NARROWING_KEYWORDS) {
    if (entry[keyword] !== undefined) narrowing[keyword] = entry[keyword];
  }
  return narrowing;
}

/** Whether an entry carries any narrowing keyword. */
export function hasNarrowing(entry: FieldNarrowing): boolean {
  return NARROWING_KEYWORDS.some((keyword) => entry[keyword] !== undefined);
}

function isMultiple(value: number, of: number): boolean {
  const quotient = value / of;
  return Math.abs(quotient - Math.round(quotient)) < MULTIPLE_TOLERANCE;
}

/**
 * Whether a value meets narrowing keywords, by JSON Schema's rules: numeric
 * keywords constrain only numbers, length keywords only strings, and `enum`
 * every value.
 *
 * @param value the value
 * @param narrowing the keywords
 */
export function satisfiesNarrowing(value: unknown, narrowing: FieldNarrowing): boolean {
  if (narrowing.enum !== undefined && !narrowing.enum.some((member) => member === value)) {
    return false;
  }
  if (typeof value === 'number') {
    const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = narrowing;
    if (minimum !== undefined && value < minimum) return false;
    if (maximum !== undefined && value > maximum) return false;
    if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) return false;
    if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) return false;
    if (multipleOf !== undefined && !isMultiple(value, multipleOf)) return false;
  }
  if (typeof value === 'string') {
    const length = Array.from(value).length; // code points, as JSON Schema counts
    if (narrowing.minLength !== undefined && length < narrowing.minLength) return false;
    if (narrowing.maxLength !== undefined && length > narrowing.maxLength) return false;
  }
  return true;
}

/**
 * Whether numeric bounds leave any value: the lower bound must not pass the
 * upper, and must not meet it when either is exclusive.
 */
function boundsAdmitValue(narrowing: FieldNarrowing): boolean {
  const lower = [narrowing.minimum, narrowing.exclusiveMinimum];
  const upper = [narrowing.maximum, narrowing.exclusiveMaximum];
  for (const [l, lowerExclusive] of [
    [lower[0], false],
    [lower[1], true],
  ] as const) {
    for (const [u, upperExclusive] of [
      [upper[0], false],
      [upper[1], true],
    ] as const) {
      if (l === undefined || u === undefined) continue;
      if (l > u || (l === u && (lowerExclusive || upperExclusive))) return false;
    }
  }
  return true;
}

/** The collection a collection item's field belongs to: `inputs.ref` for `inputs.ref.weight`. */
export function collectionOf(path: string): string | undefined {
  const [head, value] = path.split('.');
  if (head === 'inputs' || head === 'adapters' || head === 'passes') {
    return value === undefined ? undefined : `${head}.${value}`;
  }
  return undefined;
}

/**
 * Whether a path may key a descriptor's `fields`: a field path from
 * `REQUEST_PATHS`, or an experimental path (`subjects`, `style`), which is
 * described as one value until it is designed.
 *
 * @param path a field path
 */
export function isDescriptorFieldPath(path: string): boolean {
  if (!REQUEST_PATH_SET.has(path)) return false;
  const node = REQUEST_NODES.get(path);
  return node !== undefined && (node.kind === 'field' || node.experimental === true);
}

/**
 * Whether a collection path is listed in a mode: `inputs.ref` in `inputs`,
 * `adapters.lora` in `adapters`, `passes.hires` in `passes`.
 */
export function isCollectionListed(mode: ModeDescriptor, collection: string): boolean {
  const [head, value] = collection.split('.') as [string, string];
  const map = head === 'inputs' ? mode.inputs : head === 'adapters' ? mode.adapters : mode.passes;
  return map !== undefined && value in map;
}

function checkModeFieldPaths(mode: ModeDescriptor, at: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const path of Object.keys(mode.fields)) {
    const fieldAt = `${at}/fields/${pointerSegment(path)}`;
    if (!REQUEST_PATH_SET.has(path)) {
      issues.push({ path: fieldAt, message: `\`${path}\` is not a request field path` });
    } else if (!isDescriptorFieldPath(path)) {
      const group = path.split('.')[0] ?? path;
      issues.push({
        path: fieldAt,
        message: `\`${path}\` is a collection: list it under \`${group}\`, not \`fields\``,
      });
    }
  }
  return issues;
}

/**
 * The descriptor-path rule on its own: every key of every mode's `fields` is
 * a field path in `REQUEST_PATH_SET` (see {@link isDescriptorFieldPath}).
 * {@link checkRouteDescriptor} includes it.
 *
 * @param descriptor a descriptor that passed the schema
 */
export function checkDescriptorPaths(descriptor: RouteDescriptor): ValidationIssue[] {
  return Object.entries(descriptor.modes).flatMap(([mode, modeDescriptor]) =>
    checkModeFieldPaths(modeDescriptor, `/modes/${mode}`),
  );
}

function checkField(
  path: string,
  entry: FieldCapability,
  mode: ModeDescriptor,
  at: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const node = REQUEST_NODES.get(path);
  if (node === undefined) return issues;

  const collection = collectionOf(path);
  if (collection !== undefined && !isCollectionListed(mode, collection)) {
    issues.push({ path: at, message: `its collection \`${collection}\` is not listed` });
  }

  if (path !== 'count') {
    for (const key of ['native_max', 'emulated_max'] as const) {
      if (entry[key] !== undefined) {
        issues.push({ path: `${at}/${key}`, message: 'only `count` takes this' });
      }
    }
  } else if (
    entry.native_max !== undefined &&
    entry.emulated_max !== undefined &&
    entry.emulated_max < entry.native_max
  ) {
    issues.push({ path: `${at}/emulated_max`, message: 'must be at least `native_max`' });
  }

  const narrowing = pickNarrowing(entry);
  if (entry.state === 'ignored') {
    for (const keyword of Object.keys(narrowing)) {
      issues.push({ path: `${at}/${keyword}`, message: 'an ignored field takes no narrowing' });
    }
  }

  const types = narrowableTypes(node.schema);
  for (const keyword of Object.keys(narrowing) as (keyof FieldNarrowing)[]) {
    if (NUMERIC_KEYWORDS.has(keyword) && !types.has('number')) {
      issues.push({ path: `${at}/${keyword}`, message: `\`${path}\` is not a number` });
    }
    if (LENGTH_KEYWORDS.has(keyword) && !types.has('string')) {
      issues.push({ path: `${at}/${keyword}`, message: `\`${path}\` is not a string` });
    }
  }
  if (!boundsAdmitValue(narrowing)) {
    issues.push({ path: at, message: 'the bounds admit no value' });
  }
  if (
    narrowing.minLength !== undefined &&
    narrowing.maxLength !== undefined &&
    narrowing.minLength > narrowing.maxLength
  ) {
    issues.push({ path: `${at}/minLength`, message: 'must be at most `maxLength`' });
  }
  const bounds = { ...narrowing };
  delete bounds.enum;
  narrowing.enum?.forEach((member, i) => {
    if (!Value.Check(node.schema, member) || !satisfiesNarrowing(member, bounds)) {
      issues.push({
        path: `${at}/enum/${String(i)}`,
        message: `${JSON.stringify(member)} is not a value \`${path}\` can take here`,
      });
    }
  });

  if (
    entry.default !== undefined &&
    (!Value.Check(node.schema, entry.default) || !satisfiesNarrowing(entry.default, narrowing))
  ) {
    issues.push({ path: `${at}/default`, message: 'is not a value the field can take here' });
  }

  const adapterId = /^adapters\.([a-z_]+)\.id$/.exec(path);
  if (adapterId !== null && narrowing.enum !== undefined) {
    const kind = adapterId[1] as keyof NonNullable<ModeDescriptor['adapters']>;
    if (mode.adapters?.[kind]?.options !== undefined) {
      issues.push({
        path: `${at}/enum`,
        message: `\`adapters.${kind}\` lists options: narrow its ids there, not with \`enum\``,
      });
    }
  }
  return issues;
}

/**
 * Required fields must be listed: a mode that left `sampling.seed` out could
 * accept no request. The rule follows presence: a required field of the
 * request is always needed, and a required field of an optional object or a
 * collection item (`geometry.height`, `inputs.ref.asset_id`) is needed once
 * anything of that object or collection is listed.
 */
function checkRequiredFields(mode: ModeDescriptor, at: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const listed = (path: string): boolean =>
    path in mode.fields ||
    Object.keys(mode.fields).some((field) => field.startsWith(`${path}.`)) ||
    (collectionOf(path) === path && isCollectionListed(mode, path));

  const visit = (nodes: readonly RequestNode[]): void => {
    for (const node of nodes) {
      const present = node.required || listed(node.path);
      if (!present) continue;
      if (node.kind === 'field' && !(node.path in mode.fields)) {
        issues.push({
          path: `${at}/fields`,
          message: `\`${node.path}\` is required by the request, so the mode must list it`,
        });
      }
      visit(node.children);
    }
  };
  visit(REQUEST_TREE);
  return issues;
}

function checkCollections(
  modeName: GenerationMode,
  mode: ModeDescriptor,
  at: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const groups = [
    ['inputs', mode.inputs],
    ['adapters', mode.adapters],
    ['passes', mode.passes],
  ] as const;
  for (const [group, map] of groups) {
    for (const [key, entry] of Object.entries(map ?? {})) {
      const entryAt = `${at}/${group}/${key}`;
      if (entry.min !== undefined && entry.max !== undefined && entry.min > entry.max) {
        issues.push({ path: `${entryAt}/min`, message: 'must be at most `max`' });
      }
    }
  }

  for (const [kind, entry] of Object.entries(mode.adapters ?? {})) {
    const seen = new Set<string>();
    entry.options?.forEach((option, i) => {
      if (seen.has(option.id)) {
        issues.push({
          path: `${at}/adapters/${kind}/options/${String(i)}/id`,
          message: `\`${option.id}\` is listed twice`,
        });
      }
      seen.add(option.id);
    });
  }

  for (const role of MODE_REQUIRED_INPUTS[modeName]) {
    if (mode.inputs?.[role] === undefined) {
      issues.push({
        path: `${at}/inputs`,
        message: `${modeName} needs a \`${role}\` input, so the mode must list it`,
      });
    }
  }
  if (modeName === 'upscale' && mode.passes?.upscale === undefined) {
    issues.push({
      path: `${at}/passes`,
      message: 'upscale needs an `upscale` pass, so the mode must list it',
    });
  }

  for (const [kind, schema] of Object.entries(mode.extensions ?? {})) {
    if (schema['type'] !== 'object') {
      issues.push({
        path: `${at}/extensions/${pointerSegment(kind)}/type`,
        message: 'an extension schema must have `type: "object"`',
      });
    }
  }
  return issues;
}

/**
 * Every rule for one mode that its schema leaves to code.
 *
 * @param modeName the mode
 * @param mode a mode descriptor that passed the schema
 * @param at the JSON pointer to the mode descriptor
 */
export function checkModeDescriptor(
  modeName: GenerationMode,
  mode: ModeDescriptor,
  at = `/modes/${modeName}`,
): ValidationIssue[] {
  const issues = checkModeFieldPaths(mode, at);
  for (const [path, entry] of Object.entries(mode.fields)) {
    issues.push(...checkField(path, entry, mode, `${at}/fields/${pointerSegment(path)}`));
  }
  issues.push(...checkRequiredFields(mode, at));
  issues.push(...checkCollections(modeName, mode, at));
  return issues;
}

/**
 * Every rule the {@link RouteDescriptor} schema leaves to code:
 * - `fields` keys are field paths of the request (`checkDescriptorPaths`);
 * - a collection item's field is listed only with its collection, and a
 *   required field is listed wherever its object is (`sampling.seed` always);
 * - narrowing suits the field's type, admits some value, is absent on an
 *   ignored field, and any `default` meets it;
 * - `native_max` and `emulated_max` only on `count`, in that order;
 * - collection `min` ≤ `max`, adapter option ids unique and narrowed through
 *   the options rather than an `enum`;
 * - each mode lists the inputs (and for upscale, the pass) it requires;
 * - extension schemas are objects.
 *
 * @param descriptor a descriptor that passed schema validation
 * @returns the issues, empty when the descriptor is valid
 */
export function checkRouteDescriptor(descriptor: RouteDescriptor): ValidationIssue[] {
  return (Object.entries(descriptor.modes) as [GenerationMode, ModeDescriptor][]).flatMap(
    ([mode, modeDescriptor]) => checkModeDescriptor(mode, modeDescriptor),
  );
}
