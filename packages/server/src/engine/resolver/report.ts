// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The field report (A2) and the warnings, both read off `effective`.
 *
 * - **Every leaf is reported** (rule 4): native, emulated or ignored, with
 *   where its value came from, what the request asked for, and what is used.
 * - **A field's state** is its descriptor entry's, weakened by its
 *   collection's (a field of an ignored input is ignored). `count` above the
 *   backend's `native_max` is emulated: Lantern fans the job out.
 * - **Extensions** for a backend kind the route describes are native; any
 *   other kind is ignored, never refused (A11): a request written for one
 *   backend still runs on another.
 * - **Profile warnings** hold when every field their `when` names has a value
 *   in `effective` that satisfies its keywords (for a collection field, any
 *   item's value).
 */

import {
  type CapabilityState,
  DISCRIMINATED_ARRAYS,
  type FieldReport,
  type FieldReportEntry,
  type FieldSource,
  type GenerationMode,
  type GenerationRequest,
  type ModeDescriptor,
  type ProfileWarning,
  type ResolutionWarning,
  satisfiesNarrowing,
  STATE_RANK,
} from '@bureaucromancer/lantern-schema';

import { type Leaf, requestLeaves, valueAt } from './leaves.js';

interface Capability {
  readonly state: CapabilityState;
  readonly reason?: string;
}

function weaker(a: Capability, b: Capability | undefined): Capability {
  return b !== undefined && STATE_RANK[b.state] < STATE_RANK[a.state] ? b : a;
}

function collectionCapability(mode: ModeDescriptor, collection: string): Capability | undefined {
  const [group, value] = collection.split('.') as [keyof typeof DISCRIMINATED_ARRAYS, string];
  const map: Readonly<Record<string, Capability>> | undefined = mode[group];
  return map?.[value];
}

function extensionCapability(kind: string, mode: ModeDescriptor, backendKind: string): Capability {
  if (mode.extensions?.[kind] !== undefined) return { state: 'native' };
  return {
    state: 'ignored',
    reason:
      kind === backendKind
        ? `This route takes no \`${kind}\` extensions in this mode.`
        : `Extensions for another backend kind (\`${kind}\`); this route is \`${backendKind}\`.`,
  };
}

function capabilityOf(leaf: Leaf, mode: ModeDescriptor, backendKind: string): Capability {
  if (leaf.field.startsWith('extensions.')) {
    return extensionCapability(leaf.field.slice('extensions.'.length), mode, backendKind);
  }
  const entry = mode.fields[leaf.field];
  // The compiled validator refuses an unlisted field, so this is a caller's bug.
  if (entry === undefined) throw new Error(`\`${leaf.field}\` is not listed by the route`);
  let capability: Capability = {
    state: entry.state,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
  };
  if (leaf.collection !== undefined) {
    capability = weaker(capability, collectionCapability(mode, leaf.collection));
  }
  if (
    leaf.field === 'count' &&
    capability.state === 'native' &&
    entry.native_max !== undefined &&
    typeof leaf.value === 'number' &&
    leaf.value > entry.native_max
  ) {
    capability = {
      state: 'emulated',
      reason: `The backend makes at most ${String(entry.native_max)} per job; Lantern runs more jobs for the rest.`,
    };
  }
  return capability;
}

/**
 * The field report for a resolved request.
 *
 * @param canonical the request as given
 * @param effective the resolved request
 * @param sources where each filled value came from, by pointer (the rest came from the request)
 * @param mode the route's descriptor for the mode
 * @param backendKind the route's backend kind
 */
export function buildFieldReport(
  canonical: GenerationRequest,
  effective: GenerationRequest,
  sources: ReadonlyMap<string, FieldSource>,
  mode: ModeDescriptor,
  backendKind: string,
): FieldReport {
  const report: FieldReport = {};
  for (const leaf of requestLeaves(effective)) {
    const capability = capabilityOf(leaf, mode, backendKind);
    const source = sources.get(leaf.pointer) ?? 'request';
    const requested = valueAt(canonical, leaf.pointer);
    const entry: FieldReportEntry = {
      field: leaf.field,
      state: capability.state,
      source,
      ...(requested === undefined ? {} : { requested }),
      ...(capability.state === 'ignored' ? {} : { used: leaf.value }),
      ...(capability.reason === undefined ? {} : { reason: capability.reason }),
    };
    report[leaf.pointer] = entry;
  }
  return report;
}

/** Whether a profile warning's condition holds on `effective`. */
function holds(warning: ProfileWarning, leaves: readonly Leaf[]): boolean {
  return Object.entries(warning.when ?? {}).every(([path, narrowing]) =>
    leaves.some((leaf) => leaf.field === path && satisfiesNarrowing(leaf.value, narrowing)),
  );
}

/**
 * The profile's warnings that hold for a resolved request.
 *
 * @param warnings the resolved profile's warnings
 * @param mode the request's mode
 * @param effective the resolved request
 */
export function profileWarnings(
  warnings: readonly ProfileWarning[],
  mode: GenerationMode,
  effective: GenerationRequest,
): ResolutionWarning[] {
  const leaves = requestLeaves(effective);
  return warnings
    .filter((warning) => warning.modes === undefined || warning.modes.includes(mode))
    .filter((warning) => holds(warning, leaves))
    .map((warning) => ({
      code: warning.code,
      message: warning.message,
      source: 'profile' as const,
      ...(warning.when === undefined ? {} : { paths: Object.keys(warning.when) }),
    }));
}
