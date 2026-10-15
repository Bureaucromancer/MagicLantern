// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The layered descriptor merge (A6), as pure functions. A route's effective
 * descriptor is its `describe()` result with three layers applied in order,
 * each held to what it may do:
 *
 * 1. **probe** results may only demote: native → emulated → ignored → absent,
 *    for fields, collections and whole modes, and turn `control` down;
 * 2. **user overrides** may only add or widen: new fields, collections, modes,
 *    extension kinds and adapter options; promoted states; wider bounds and
 *    larger sets; `control` turned up (the Tier 3 extension path);
 * 3. **profile constraints** may only narrow, or remove: tighter bounds,
 *    smaller sets (an adapter `id` enum narrows the options), `absent`.
 *
 * Whatever a layer may not do is refused and recorded as a {@link MergeNote};
 * nothing is applied silently. Where a set moves partly the right way, the
 * right part is applied and the rest noted. A change that would leave the
 * mode invalid (removing `sampling.seed`, bounds that admit nothing) is
 * refused with the checker's issues as notes, so the result always passes
 * `checkRouteDescriptor`.
 *
 * Defaults come from `describe()` alone: route overrides change capabilities
 * only (A3), and a profile's defaults take part in the resolver's precedence
 * rather than the descriptor. A route default that narrowing leaves out of
 * range is dropped, with a note.
 *
 * Nothing here depends on a request: the effective descriptor is static, so
 * it can be cached and its digest stored in `route_snapshot`.
 */

import {
  type AdapterCapability,
  type AdapterLayer,
  type AdapterOption,
  checkModeDescriptor,
  checkRouteDescriptor,
  type CollectionLayer,
  collectionOf,
  DescriptorLayer,
  type FieldCapability,
  type FieldLayer,
  type GenerationMode,
  isDescriptorFieldPath,
  type LayerSource,
  ModeControl,
  type ModeDescriptor,
  type ModeLayer,
  NARROWING_KEYWORDS,
  type NarrowingMap,
  pickNarrowing,
  pointerSegment,
  PROGRESS_RANK,
  REQUEST_PATH_SET,
  RouteDescriptor,
  satisfiesNarrowing,
  STATE_RANK,
  type ValidationIssue,
} from '@bureaucromancer/lantern-schema';
import { Value } from '@sinclair/typebox/value';

import { applyKeyword, KEYWORD_ORDER } from './keywords.js';

/** Something a layer asked for that was not applied as written. */
export interface MergeNote {
  readonly layer: LayerSource;
  /** JSON pointer into the layer, e.g. `/modes/txt2img/fields/sampling.steps/maximum`. */
  readonly path: string;
  readonly message: string;
}

/** The layers over a `describe()` result, each optional. Applied probe, override, profile. */
export interface DescriptorLayers {
  readonly probe?: DescriptorLayer;
  readonly override?: DescriptorLayer;
  readonly profile?: DescriptorLayer;
}

export interface MergeResult {
  /** The effective descriptor. */
  readonly descriptor: RouteDescriptor;
  /** Everything a layer asked for that was refused or applied only in part. */
  readonly notes: readonly MergeNote[];
}

/** A `describe()` result that fails its schema or checks: an adapter bug, never a layer's. */
export class InvalidDescriptorError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(
      `Invalid route descriptor: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
    );
    this.name = 'InvalidDescriptorError';
    this.issues = issues;
  }
}

/** The order layers are applied in. */
export const LAYER_ORDER: readonly LayerSource[] = ['probe', 'override', 'profile'];

const WHAT_MAY: Readonly<Record<LayerSource, string>> = {
  probe: 'probes may only demote',
  override: 'overrides may only add or widen',
  profile: 'profiles may only narrow or remove',
};

type Notes = MergeNote[];

function issuesOf(descriptor: RouteDescriptor): ValidationIssue[] {
  const schemaIssues = [...Value.Errors(RouteDescriptor, descriptor)].map((error) => ({
    path: error.path,
    message: error.message,
  }));
  return schemaIssues.length > 0 ? schemaIssues : checkRouteDescriptor(descriptor);
}

/**
 * Issues a candidate mode has that the mode before the change did not, so a
 * change is judged only on what it broke.
 */
function newIssues(
  mode: GenerationMode,
  before: ModeDescriptor,
  after: ModeDescriptor,
): ValidationIssue[] {
  const key = (issue: ValidationIssue): string => `${issue.path}\u0000${issue.message}`;
  const known = new Set(checkModeDescriptor(mode, before).map(key));
  return checkModeDescriptor(mode, after).filter((issue) => !known.has(key(issue)));
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

type EntryState = keyof typeof STATE_RANK;

/** Whether a source may move an entry from one state to another. */
function mayChangeState(source: LayerSource, from: EntryState, to: EntryState): boolean {
  switch (source) {
    case 'probe':
      return STATE_RANK[to] < STATE_RANK[from];
    case 'override':
      return STATE_RANK[to] > STATE_RANK[from];
    case 'profile':
      return to === 'absent';
  }
}

function stateNote(source: LayerSource, from: EntryState, to: EntryState): string {
  return source === 'profile'
    ? `\`${to}\`: ${WHAT_MAY.profile}; they do not change states`
    : `\`${from}\` to \`${to}\`: ${WHAT_MAY[source]}`;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** A field entry after one layer: the new entry, or null when removed. */
function applyField(
  source: LayerSource,
  path: string,
  current: FieldCapability,
  layer: FieldLayer,
  mode: ModeDescriptor,
  at: string,
  notes: Notes,
): FieldCapability | null {
  const next: FieldCapability = structuredClone(current);
  const note = (key: string, message: string): void => {
    notes.push({ layer: source, path: `${at}/${key}`, message });
  };

  let stateChanged = false;
  if (layer.state !== undefined && layer.state !== current.state) {
    if (!mayChangeState(source, current.state, layer.state)) {
      note('state', stateNote(source, current.state, layer.state));
    } else if (layer.state === 'absent') {
      return null;
    } else {
      next.state = layer.state;
      stateChanged = true;
      if (layer.state === 'ignored') {
        // An ignored field takes no narrowing, and its default means nothing.
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- each narrowing keyword
        for (const keyword of NARROWING_KEYWORDS) delete next[keyword];
        delete next.default;
      }
    }
  }

  if (layer.reason !== undefined && layer.reason !== current.reason) {
    if (stateChanged) next.reason = layer.reason;
    else note('reason', 'a reason changes only with the state it explains');
  }
  if (stateChanged && layer.reason === undefined && next.state === 'native') delete next.reason;

  if (layer.default !== undefined) {
    note(
      'default',
      source === 'profile'
        ? "a profile's defaults apply in the resolver's precedence, not the descriptor"
        : 'defaults come from the route alone; layers change capabilities (A3)',
    );
  }

  for (const key of ['native_max', 'emulated_max'] as const) {
    const proposed = layer[key];
    if (proposed === undefined) continue;
    if (source !== 'override') {
      note(
        key,
        source === 'profile'
          ? 'profiles narrow `count` with `maximum`'
          : `${WHAT_MAY.probe}; a probe changes states, not limits`,
      );
      continue;
    }
    const outcome = applyKeyword('widen', key, 'upper', current[key], proposed);
    if (outcome.value !== undefined) next[key] = outcome.value as number;
    if (outcome.note !== undefined) note(key, outcome.note);
  }

  const adapterId = /^adapters\.(lora|embedding)\.id$/.exec(path);
  const adapterKind = adapterId?.[1] as 'lora' | 'embedding' | undefined;
  for (const keyword of NARROWING_KEYWORDS) {
    const proposed = layer[keyword];
    if (proposed === undefined) continue;
    if (source === 'probe') {
      note(keyword, `${WHAT_MAY.probe}; a probe changes states, not values`);
      continue;
    }
    if (next.state === 'ignored') {
      note(keyword, 'the field is ignored, so there is nothing to narrow or widen');
      continue;
    }
    if (
      keyword === 'enum' &&
      adapterKind !== undefined &&
      mode.adapters?.[adapterKind]?.options !== undefined
    ) {
      // The ids are the options: a profile narrows by filtering them, in applyAdapterIds.
      if (source === 'override') {
        note(keyword, `add adapters through \`adapters.${adapterKind}.options\``);
      }
      continue;
    }
    const direction = source === 'profile' ? 'narrow' : 'widen';
    const outcome = applyKeyword(
      direction,
      keyword,
      KEYWORD_ORDER[keyword],
      current[keyword],
      proposed,
    );
    if (outcome.value !== undefined) (next as Record<string, unknown>)[keyword] = outcome.value;
    if (outcome.note !== undefined) note(keyword, outcome.note);
  }

  if (next.default !== undefined && !satisfiesNarrowing(next.default, pickNarrowing(next))) {
    note(
      'default',
      `the route's default ${JSON.stringify(next.default)} is outside the narrowed values; dropped`,
    );
    delete next.default;
  }
  return next;
}

/** A profile's `enum` on `adapters.<kind>.id` where the route lists options: keep only those options. */
function applyAdapterIds(
  path: string,
  layer: FieldLayer,
  mode: ModeDescriptor,
  at: string,
  notes: Notes,
): void {
  const match = /^adapters\.(lora|embedding)\.id$/.exec(path);
  const kind = match?.[1] as 'lora' | 'embedding' | undefined;
  const collection = kind === undefined ? undefined : mode.adapters?.[kind];
  if (layer.enum === undefined || collection?.options === undefined) return;
  const wanted = new Set(layer.enum);
  const kept = collection.options.filter((option) => wanted.has(option.id));
  const offered = new Set(collection.options.map((option) => option.id));
  const missing = layer.enum.filter((id) => typeof id !== 'string' || !offered.has(id));
  if (kept.length === 0) {
    notes.push({
      layer: 'profile',
      path: `${at}/enum`,
      message: `none of ${JSON.stringify(layer.enum)} is offered by the route; not applied`,
    });
    return;
  }
  if (missing.length > 0) {
    notes.push({
      layer: 'profile',
      path: `${at}/enum`,
      message: `${JSON.stringify(missing)} are not offered by the route; narrowed to the rest`,
    });
  }
  collection.options = kept;
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

const COLLECTION_KEYWORDS = [
  ['min', 'lower'],
  ['max', 'upper'],
  ['media', 'set'],
] as const;

function applyOptions(
  current: AdapterCapability,
  proposed: readonly AdapterOption[],
  at: string,
  notes: Notes,
): AdapterOption[] | undefined {
  if (current.options === undefined) {
    notes.push({
      layer: 'override',
      path: at,
      message: 'the route takes any id here; listing options would narrow it',
    });
    return undefined;
  }
  const options = structuredClone(current.options);
  proposed.forEach((option, i) => {
    const existing = options.find((candidate) => candidate.id === option.id);
    if (existing === undefined) {
      options.push(structuredClone(option));
      return;
    }
    for (const [key, value] of Object.entries(option) as [keyof AdapterOption, unknown][]) {
      const before = existing[key];
      if (before === undefined) {
        (existing as Record<string, unknown>)[key] = structuredClone(value);
      } else if (JSON.stringify(before) !== JSON.stringify(value)) {
        notes.push({
          layer: 'override',
          path: `${at}/${String(i)}/${key}`,
          message: `\`${option.id}\` already has ${key} ${JSON.stringify(before)}; overrides may add to an option, not change it`,
        });
      }
    }
  });
  return options;
}

/** A collection entry after one layer; a plain collection is an adapter entry without options. */
function applyCollection(
  source: LayerSource,
  current: AdapterCapability,
  layer: AdapterLayer,
  at: string,
  notes: Notes,
): AdapterCapability | null {
  const next = structuredClone(current);
  const note = (key: string, message: string): void => {
    notes.push({ layer: source, path: `${at}/${key}`, message });
  };

  let stateChanged = false;
  if (layer.state !== undefined && layer.state !== current.state) {
    if (!mayChangeState(source, current.state, layer.state)) {
      note('state', stateNote(source, current.state, layer.state));
    } else if (layer.state === 'absent') {
      return null;
    } else {
      next.state = layer.state;
      stateChanged = true;
    }
  }
  if (layer.reason !== undefined && layer.reason !== current.reason) {
    if (stateChanged) next.reason = layer.reason;
    else note('reason', 'a reason changes only with the state it explains');
  }

  for (const [key, order] of COLLECTION_KEYWORDS) {
    const proposed = layer[key];
    if (proposed === undefined) continue;
    if (source === 'probe') {
      note(key, `${WHAT_MAY.probe}; a probe changes states, not limits`);
      continue;
    }
    const direction = source === 'profile' ? 'narrow' : 'widen';
    const outcome = applyKeyword(direction, key, order, current[key], proposed);
    if (outcome.value !== undefined) (next as Record<string, unknown>)[key] = outcome.value;
    if (outcome.note !== undefined) note(key, outcome.note);
  }

  if (layer.options !== undefined) {
    if (source !== 'override') {
      note(
        'options',
        source === 'profile'
          ? 'profiles narrow adapters with an `enum` on the `id` field'
          : `${WHAT_MAY.probe}; a probe changes states, not options`,
      );
    } else {
      const options = applyOptions(current, layer.options, `${at}/options`, notes);
      if (options !== undefined) next.options = options;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

function applyControl(
  source: LayerSource,
  control: ModeControl,
  layer: Partial<ModeControl>,
  at: string,
  notes: Notes,
): ModeControl {
  const next = { ...control };
  const rank = {
    cancel_queued: (value: boolean) => Number(value),
    cancel_running: (value: boolean) => Number(value),
  };
  const consider = (key: keyof ModeControl, from: number, to: number, apply: () => void): void => {
    if (from === to) return;
    const allowed = source === 'probe' ? to < from : source === 'override' ? to > from : false;
    if (allowed) {
      apply();
    } else {
      notes.push({
        layer: source,
        path: `${at}/${key}`,
        message: `${JSON.stringify(control[key])} to ${JSON.stringify(layer[key])}: ${source === 'profile' ? 'profiles do not change control' : WHAT_MAY[source]}`,
      });
    }
  };
  for (const key of ['cancel_queued', 'cancel_running'] as const) {
    const proposed = layer[key];
    if (proposed === undefined) continue;
    consider(key, rank[key](control[key]), rank[key](proposed), () => {
      next[key] = proposed;
    });
  }
  const progress = layer.progress;
  if (progress !== undefined) {
    consider('progress', PROGRESS_RANK[control.progress], PROGRESS_RANK[progress], () => {
      next.progress = progress;
    });
  }
  return next;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

type CollectionGroup = 'inputs' | 'adapters' | 'passes';
const COLLECTION_GROUPS: readonly CollectionGroup[] = ['inputs', 'adapters', 'passes'];

function groupOf(mode: ModeDescriptor, group: CollectionGroup): Record<string, AdapterCapability> {
  return mode[group] ?? {};
}

function setGroupEntry(
  mode: ModeDescriptor,
  group: CollectionGroup,
  key: string,
  entry: AdapterCapability | null,
): void {
  const map = { ...groupOf(mode, group) };
  if (entry === null) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- removing a collection by key
    delete map[key];
    // Its fields go with it: `inputs.ref.weight` means nothing without `inputs.ref`.
    for (const path of Object.keys(mode.fields)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- removing a field by path
      if (path.startsWith(`${group}.${key}.`)) delete mode.fields[path];
    }
  } else {
    map[key] = entry;
  }
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- an emptied collection map
  if (Object.keys(map).length === 0) delete mode[group];
  else (mode as Record<string, unknown>)[group] = map;
}

/** A new entry built from a layer entry, for an override's additions. */
function newEntry(
  layer: { state?: string; default?: unknown },
  at: string,
  notes: Notes,
): Record<string, unknown> | undefined {
  if (layer.state === undefined || layer.state === 'absent') {
    notes.push({ layer: 'override', path: at, message: 'a new entry needs a state' });
    return undefined;
  }
  const entry = structuredClone(layer) as Record<string, unknown>;
  if (entry['default'] !== undefined) {
    notes.push({
      layer: 'override',
      path: `${at}/default`,
      message: 'defaults come from the route alone; layers change capabilities (A3)',
    });
    delete entry['default'];
  }
  return entry;
}

/**
 * Additions: entries the mode doesn't have yet. Only overrides may add, and
 * an override's additions are applied together (a new collection needs its
 * required fields in the same layer) and refused together if the result
 * fails the checks.
 */
function applyAdditions(
  source: LayerSource,
  modeName: GenerationMode,
  mode: ModeDescriptor,
  layer: ModeLayer,
  at: string,
  notes: Notes,
): ModeDescriptor {
  const candidate = structuredClone(mode);
  let added = 0;
  const refuse = (path: string, what: string): void => {
    notes.push({
      layer: source,
      path,
      message:
        source === 'profile'
          ? `${what} is not on this route, so there is nothing to narrow`
          : `${what} is not on this route; ${WHAT_MAY[source]}`,
    });
  };

  for (const [path, entry] of Object.entries(layer.fields ?? {})) {
    if (path in mode.fields) continue;
    const entryAt = `${at}/fields/${pointerSegment(path)}`;
    if (!isDescriptorFieldPath(path)) {
      notes.push({
        layer: source,
        path: entryAt,
        message: REQUEST_PATH_SET.has(path)
          ? `\`${path}\` is a collection: give it under \`${path.split('.')[0] ?? path}\``
          : `\`${path}\` is not a request field path`,
      });
      continue;
    }
    if (entry.state === 'absent') continue; // already absent
    if (source !== 'override') {
      refuse(entryAt, `\`${path}\``);
      continue;
    }
    const created = newEntry(entry, entryAt, notes) as FieldCapability | undefined;
    if (created !== undefined) {
      candidate.fields[path] = created;
      added += 1;
    }
  }

  for (const group of COLLECTION_GROUPS) {
    for (const [key, entry] of Object.entries(layer[group] ?? {}) as [string, AdapterLayer][]) {
      if (key in groupOf(mode, group)) continue;
      const entryAt = `${at}/${group}/${key}`;
      if (entry.state === 'absent') continue;
      if (source !== 'override') {
        refuse(entryAt, `\`${group}.${key}\``);
        continue;
      }
      const created = newEntry(entry, entryAt, notes) as AdapterCapability | undefined;
      if (created !== undefined) {
        setGroupEntry(candidate, group, key, created);
        added += 1;
      }
    }
  }

  for (const [kind, schema] of Object.entries(layer.extensions ?? {})) {
    const entryAt = `${at}/extensions/${pointerSegment(kind)}`;
    if (mode.extensions?.[kind] !== undefined) {
      notes.push({
        layer: source,
        path: entryAt,
        message:
          source === 'override'
            ? 'the route already defines this extension; overrides may add kinds, not replace them'
            : `${WHAT_MAY[source]}; extensions are the route's and overrides'`,
      });
      continue;
    }
    if (source !== 'override') {
      refuse(entryAt, `the \`${kind}\` extension`);
      continue;
    }
    candidate.extensions = { ...candidate.extensions, [kind]: structuredClone(schema) };
    added += 1;
  }

  if (added === 0) return mode;
  const issues = newIssues(modeName, mode, candidate);
  if (issues.length === 0) return candidate;
  for (const issue of issues) {
    notes.push({
      layer: source,
      path: at,
      message: `the additions to ${modeName} were refused together: ${issue.path} ${issue.message}`,
    });
  }
  return mode;
}

/**
 * Changes to entries the mode had before this layer, one at a time, each refused if it
 * would leave the mode failing a check it passed before.
 */
function applyChanges(
  source: LayerSource,
  modeName: GenerationMode,
  original: ModeDescriptor,
  start: ModeDescriptor,
  layer: ModeLayer,
  at: string,
  notes: Notes,
): ModeDescriptor {
  let mode = start;
  const attempt = (entryAt: string, change: (candidate: ModeDescriptor, notes: Notes) => void) => {
    const candidate = structuredClone(mode);
    const entryNotes: Notes = [];
    change(candidate, entryNotes);
    const issues = newIssues(modeName, mode, candidate);
    if (issues.length === 0) {
      mode = candidate;
      notes.push(...entryNotes);
      return;
    }
    for (const issue of issues) {
      notes.push({
        layer: source,
        path: entryAt,
        message: `refused, because it would leave the mode invalid: ${issue.path} ${issue.message}`,
      });
    }
  };

  // Fields first, so a profile that narrows a collection's field and then
  // removes the collection isn't told the field is gone.
  for (const [path, entry] of Object.entries(layer.fields ?? {})) {
    if (!(path in original.fields)) continue; // an addition, applied already
    const entryAt = `${at}/fields/${pointerSegment(path)}`;
    attempt(entryAt, (candidate, entryNotes) => {
      const current = candidate.fields[path];
      if (current === undefined) return; // removed with its collection by an earlier entry
      const next = applyField(source, path, current, entry, candidate, entryAt, entryNotes);
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- removing a field by path
      if (next === null) delete candidate.fields[path];
      else candidate.fields[path] = next;
      if (source === 'profile' && next !== null) {
        applyAdapterIds(path, entry, candidate, entryAt, entryNotes);
      }
    });
  }

  for (const group of COLLECTION_GROUPS) {
    for (const [key, entry] of Object.entries(layer[group] ?? {}) as [string, AdapterLayer][]) {
      if (!(key in groupOf(original, group))) continue;
      const entryAt = `${at}/${group}/${key}`;
      attempt(entryAt, (candidate, entryNotes) => {
        const current = groupOf(candidate, group)[key];
        if (current === undefined) return;
        const next = applyCollection(source, current, entry, entryAt, entryNotes);
        setGroupEntry(candidate, group, key, next);
      });
    }
  }

  if (layer.control !== undefined) {
    const control = layer.control;
    attempt(`${at}/control`, (candidate, entryNotes) => {
      candidate.control = applyControl(
        source,
        candidate.control,
        control,
        `${at}/control`,
        entryNotes,
      );
    });
  }
  return mode;
}

/** A mode the route doesn't have, which only an override may add, with a complete `control`. */
function addMode(
  modeName: GenerationMode,
  layer: ModeLayer,
  at: string,
  notes: Notes,
): ModeDescriptor | undefined {
  if (!Value.Check(ModeControl, layer.control)) {
    notes.push({
      layer: 'override',
      path: `${at}/control`,
      message: 'a new mode needs a complete `control`',
    });
    return undefined;
  }
  const empty: ModeDescriptor = { fields: {}, control: structuredClone(layer.control) };
  const modeNotes: Notes = [];
  const mode = applyAdditions('override', modeName, empty, layer, at, modeNotes);
  // An empty mode fails the required-field checks, so judge the result whole.
  const issues = checkModeDescriptor(modeName, mode);
  if (issues.length > 0) {
    for (const issue of issues) {
      notes.push({
        layer: 'override',
        path: at,
        message: `the new mode ${modeName} was refused: ${issue.path} ${issue.message}`,
      });
    }
    return undefined;
  }
  notes.push(...modeNotes);
  return mode;
}

/**
 * One layer over a descriptor, held to what its source may do. The input is
 * not changed.
 *
 * @param descriptor a valid descriptor (a `describe()` result or an earlier merge)
 * @param layer the layer
 * @param source where the layer comes from, which decides what it may do
 */
export function applyLayer(
  descriptor: RouteDescriptor,
  layer: DescriptorLayer,
  source: LayerSource,
): MergeResult {
  const notes: Notes = [];
  const layerErrors = [...Value.Errors(DescriptorLayer, layer)];
  if (layerErrors.length > 0) {
    for (const error of layerErrors) {
      notes.push({
        layer: source,
        path: error.path,
        message: `the layer is malformed, so none of it was applied: ${error.message}`,
      });
    }
    return { descriptor, notes };
  }

  const result: RouteDescriptor = structuredClone(descriptor);
  for (const [modeName, modeLayer] of Object.entries(layer.modes) as [
    GenerationMode,
    ModeLayer,
  ][]) {
    const at = `/modes/${modeName}`;
    const current = result.modes[modeName];

    if (modeLayer.state === 'absent') {
      if (current === undefined) continue;
      if (source === 'override') {
        notes.push({
          layer: source,
          path: `${at}/state`,
          message: `${WHAT_MAY.override}, so a mode can't be removed`,
        });
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- removing a mode by name
      delete result.modes[modeName];
      continue;
    }

    if (current === undefined) {
      if (source !== 'override') {
        notes.push({
          layer: source,
          path: at,
          message:
            source === 'profile'
              ? `${modeName} is not on this route, so there is nothing to narrow`
              : `${modeName} is not on this route; ${WHAT_MAY.probe}`,
        });
        continue;
      }
      const added = addMode(modeName, modeLayer, at, notes);
      if (added !== undefined) result.modes[modeName] = added;
      continue;
    }

    const withAdditions = applyAdditions(source, modeName, current, modeLayer, at, notes);
    result.modes[modeName] = applyChanges(
      source,
      modeName,
      current,
      withAdditions,
      modeLayer,
      at,
      notes,
    );
  }
  return { descriptor: result, notes };
}

/**
 * The effective descriptor: `describe()`'s result with each layer applied in
 * {@link LAYER_ORDER}, and every refusal noted.
 *
 * @param base the route's `describe()` result
 * @param layers the probe result, user override and profile constraints, each optional
 * @throws InvalidDescriptorError when `base` fails its schema or checks
 */
export function mergeDescriptor(base: RouteDescriptor, layers: DescriptorLayers = {}): MergeResult {
  const issues = issuesOf(base);
  if (issues.length > 0) throw new InvalidDescriptorError(issues);
  let descriptor = base;
  const notes: MergeNote[] = [];
  for (const source of LAYER_ORDER) {
    const layer = layers[source];
    if (layer === undefined) continue;
    const result = applyLayer(descriptor, layer, source);
    descriptor = result.descriptor;
    notes.push(...result.notes);
  }
  return { descriptor, notes };
}

/** A profile's constraints for one mode: narrowing per field path, and paths to remove. */
export interface ModeConstraints {
  readonly narrow?: NarrowingMap;
  /** Field or collection paths (`sampling.eta`, `adapters.embedding`) the model doesn't take. */
  readonly absent?: readonly string[];
}

/**
 * Profile constraints as a layer, for {@link mergeDescriptor}'s `profile`. A
 * collection path (`inputs.ref`) is removed as a collection; anything else
 * goes under `fields`, where the merge notes a path that isn't a field.
 *
 * @param byMode constraints per mode
 */
export function profileLayer(
  byMode: Partial<Record<GenerationMode, ModeConstraints>>,
): DescriptorLayer {
  const modes: Record<string, ModeLayer> = {};
  for (const [modeName, constraints] of Object.entries(byMode)) {
    const fields: Record<string, FieldLayer> = {};
    const groups: Partial<Record<CollectionGroup, Record<string, CollectionLayer>>> = {};
    for (const [path, narrowing] of Object.entries(constraints.narrow ?? {})) {
      fields[path] = { ...narrowing };
    }
    for (const path of constraints.absent ?? []) {
      const collection = collectionOf(path);
      if (collection === path) {
        const [group, key] = path.split('.') as [CollectionGroup, string];
        groups[group] = { ...groups[group], [key]: { state: 'absent' } };
      } else {
        fields[path] = { state: 'absent' };
      }
    }
    modes[modeName] = { fields, ...groups };
  }
  return { modes };
}
