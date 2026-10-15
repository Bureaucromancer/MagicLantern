// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Filling values by precedence (A3): request > preset > model overrides >
 * profile > descriptor default. The request's own values are never touched;
 * only fields it leaves out are filled, so `effective` carries every value
 * the route takes (L7). A value from a lower layer that the route can't take
 * is passed over for the next layer, with a warning, rather than sent.
 *
 * Not filled:
 * - fields the route ignores, which would change nothing;
 * - `prompt.positive` and `sampling.seed`, which the request must give (the
 *   seed is drawn separately);
 * - experimental `subjects` and `style`;
 * - `geometry` when an `init` or `first_frame` input gives the size (A4): the
 *   size comes from the asset, which the asset store will measure (Phase 3);
 * - `weight` on `init` and `mask` inputs, which take none (A8);
 * - a hires pass's `scale` beside its `target`, or the reverse (A9).
 *
 * A top-level object that filling started but could not complete (a default
 * width with no height) is taken out again, so `effective` stays valid.
 */

import {
  collectionOf,
  DISCRIMINATED_ARRAYS,
  type FieldCapability,
  type FieldNarrowing,
  type FieldSource,
  type GenerationRequest,
  GenerationRequest as GenerationRequestSchema,
  type ModeDescriptor,
  pickNarrowing,
  pointerSegment,
  REQUEST_NODES,
  type ResolutionWarning,
  satisfiesNarrowing,
  UNWEIGHTED_INPUT_ROLES,
} from '@bureaucromancer/lantern-schema';
import { Value } from '@sinclair/typebox/value';

import { isRecord } from './leaves.js';
import type { FieldValues } from './types.js';

/** The layers below the request, in precedence order. */
export interface FillLayers {
  readonly preset: FieldValues;
  readonly model: FieldValues;
  readonly profile: FieldValues;
}

export interface FillResult {
  readonly effective: GenerationRequest;
  /** Where each filled value came from, by pointer. Values the request set are not listed. */
  readonly sources: ReadonlyMap<string, FieldSource>;
  /** A lower layer's value the route can't take, passed over. */
  readonly warnings: readonly ResolutionWarning[];
}

/** Fields the request must give, or the resolver sets another way. */
const NEVER_FILLED: ReadonlySet<string> = new Set(['prompt.positive', 'sampling.seed']);

/** Input roles whose asset gives the output's size (A4). */
const SIZE_GIVING_ROLES: ReadonlySet<string> = new Set(['init', 'first_frame']);

/** Lantern's own fallback where no layer gives a value. */
const BUILTIN: FieldValues = { count: 1 };

/**
 * The narrowing a route applies to a field, as the compiled validator does:
 * none on an ignored field, `count` capped at `emulated_max` (else
 * `native_max`), and an adapter kind's offered ids as an `enum`.
 *
 * @param path the field path
 * @param entry the field's descriptor entry
 * @param mode the mode descriptor, for adapter options
 */
export function routeNarrowing(
  path: string,
  entry: FieldCapability,
  mode?: ModeDescriptor,
): FieldNarrowing {
  if (entry.state === 'ignored') return {};
  const narrowing: FieldNarrowing = { ...pickNarrowing(entry) };
  if (path === 'count') {
    const limit = entry.emulated_max ?? entry.native_max;
    if (limit !== undefined && (narrowing.maximum === undefined || limit < narrowing.maximum)) {
      narrowing.maximum = limit;
    }
  }
  const adapterId = /^adapters\.([a-z_]+)\.id$/.exec(path);
  if (adapterId !== null && mode !== undefined) {
    const kind = adapterId[1] as keyof NonNullable<ModeDescriptor['adapters']>;
    const options = mode.adapters?.[kind]?.options;
    if (options !== undefined) narrowing.enum = options.map((option) => option.id);
  }
  return narrowing;
}

/** One place a field's value goes: the request, or one item of a collection. */
interface Target {
  readonly container: Record<string, unknown>;
  readonly segments: readonly string[];
  readonly pointer: string;
}

function has(container: Record<string, unknown>, segments: readonly string[]): boolean {
  let node: unknown = container;
  for (const segment of segments) {
    if (!isRecord(node) || node[segment] === undefined) return false;
    node = node[segment];
  }
  return true;
}

function put(
  container: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): void {
  let node = container;
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment];
    if (isRecord(next)) {
      node = next;
    } else {
      const created: Record<string, unknown> = {};
      node[segment] = created;
      node = created;
    }
  }
  const last = segments.at(-1);
  if (last !== undefined) node[last] = structuredClone(value);
}

function pointerOf(prefix: string, segments: readonly string[]): string {
  return `${prefix}/${segments.map(pointerSegment).join('/')}`;
}

/** Where a field's value would go in the request: once, or once per item of its collection. */
function targetsOf(effective: Record<string, unknown>, path: string): Target[] {
  const collection = collectionOf(path);
  if (collection === undefined) {
    const segments = path.split('.');
    return [{ container: effective, segments, pointer: pointerOf('', segments) }];
  }
  const [group, value, ...rest] = path.split('.') as [keyof typeof DISCRIMINATED_ARRAYS, string];
  const { key } = DISCRIMINATED_ARRAYS[group];
  const items = effective[group];
  if (!Array.isArray(items)) return [];
  const targets: Target[] = [];
  items.forEach((item: unknown, i) => {
    if (!isRecord(item) || item[key] !== value) return;
    targets.push({
      container: item,
      segments: rest,
      pointer: pointerOf(`/${group}/${String(i)}`, rest),
    });
  });
  return targets;
}

/** Whether a value may not go here, whatever it is (see the module comment). */
function excluded(path: string, target: Target, derivedSize: boolean): boolean {
  if (derivedSize && path.startsWith('geometry.')) return true;
  const input = /^inputs\.([a-z_]+)\.weight$/.exec(path);
  if (input !== null && (UNWEIGHTED_INPUT_ROLES as readonly string[]).includes(input[1] ?? '')) {
    return true;
  }
  if (path === 'passes.hires.scale') return target.container['target'] !== undefined;
  if (path.startsWith('passes.hires.target.')) return target.container['scale'] !== undefined;
  return false;
}

/**
 * A copy with every object's keys in its schema's property order, so a filled
 * value sits where a person reading `effective` expects it rather than at the
 * end. Keys the schema does not name (an extension block's) keep their order.
 */
function inSchemaOrder(value: unknown, schema: Readonly<Record<string, unknown>>): unknown {
  if (Array.isArray(value)) {
    const items = schema['items'];
    return isRecord(items) ? value.map((item: unknown) => inSchemaOrder(item, items)) : value;
  }
  const properties = schema['properties'];
  if (!isRecord(value) || !isRecord(properties)) return value;
  const ordered: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    if (value[name] !== undefined && isRecord(property)) {
      ordered[name] = inSchemaOrder(value[name], property);
    }
  }
  for (const [name, child] of Object.entries(value)) {
    if (!(name in ordered)) ordered[name] = child;
  }
  return ordered;
}

/** Removes top-level objects that filling started but left without a required field. */
function pruneIncomplete(
  effective: Record<string, unknown>,
  canonical: Readonly<Record<string, unknown>>,
  sources: Map<string, FieldSource>,
): void {
  for (const [name, value] of Object.entries(effective)) {
    if (canonical[name] !== undefined || !isRecord(value)) continue;
    const node = REQUEST_NODES.get(name);
    if (node?.kind !== 'object') continue;
    const incomplete = node.children.some(
      (child) => child.required && !has(value, [child.path.slice(name.length + 1)]),
    );
    if (!incomplete) continue;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- an object filling could not complete
    delete effective[name];
    for (const pointer of [...sources.keys()]) {
      if (pointer.startsWith(`/${name}/`)) sources.delete(pointer);
    }
  }
}

/**
 * Fills every field the route takes and the request leaves out.
 *
 * @param canonical the validated canonical request; not mutated
 * @param mode the route's descriptor for the request's mode
 * @param layers the preset, model-override and profile values for the mode
 */
export function fillDefaults(
  canonical: GenerationRequest,
  mode: ModeDescriptor,
  layers: FillLayers,
): FillResult {
  const effective = structuredClone(canonical) as unknown as Record<string, unknown>;
  const sources = new Map<string, FieldSource>();
  const warnings: ResolutionWarning[] = [];
  const derivedSize = (canonical.inputs ?? []).some((input) => SIZE_GIVING_ROLES.has(input.role));

  // In the request schema's order, so the result never depends on the descriptor's key order.
  for (const [path, node] of REQUEST_NODES) {
    const entry = mode.fields[path];
    if (entry === undefined || entry.state === 'ignored') continue;
    if (node.kind !== 'field' || node.experimental === true || NEVER_FILLED.has(path)) continue;

    const narrowing = routeNarrowing(path, entry, mode);
    const candidates: [FieldSource, unknown][] = [
      ['preset', layers.preset[path]],
      ['model', layers.model[path]],
      ['profile', layers.profile[path]],
      ['descriptor', entry.default],
      ['builtin', BUILTIN[path]],
    ];
    const refused = new Set<FieldSource>();

    for (const target of targetsOf(effective, path)) {
      if (has(target.container, target.segments) || excluded(path, target, derivedSize)) continue;
      for (const [source, value] of candidates) {
        if (value === undefined) continue;
        if (Value.Check(node.schema, value) && satisfiesNarrowing(value, narrowing)) {
          put(target.container, target.segments, value);
          sources.set(target.pointer, source);
          break;
        }
        if (!refused.has(source)) {
          refused.add(source);
          warnings.push({
            code: 'default_refused',
            source: 'resolver',
            paths: [path],
            message: `The ${source === 'model' ? "model's" : source} default for \`${path}\` (${JSON.stringify(value)}) is not a value this route takes, so it was passed over.`,
          });
        }
      }
    }
  }

  pruneIncomplete(effective, canonical, sources);
  return {
    effective: inSchemaOrder(effective, GenerationRequestSchema) as GenerationRequest,
    sources,
    warnings,
  };
}
