// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Flattening a profile and one of its variants into the profile the resolver
 * uses, and the constraints a mode applies.
 */

import type {
  FrameRule,
  GenerationMode,
  Licence,
  ModeRules,
  ModelProfile,
  NarrowingMap,
  NegativePromptRules,
  ProfileModes,
  ProfileSource,
  ProfileVariant,
  ProfileWarning,
  PromptRules,
  ResolutionRules,
} from '@bureaucromancer/lantern-schema';

/** A profile with its variant applied: what the resolver reads. */
export interface ResolvedProfile {
  readonly family: string;
  /** The family's name, or the variant's when one applies. */
  readonly name: string;
  /** The variant applied, if any. */
  readonly variant?: { readonly id: string; readonly name: string };
  readonly licence?: Licence;
  readonly prompt: PromptRules;
  readonly negative_prompt: NegativePromptRules;
  readonly resolution: ResolutionRules;
  readonly frames?: FrameRule;
  /** The supported modes: the family's, plus any the variant adds. */
  readonly modes: ProfileModes;
  readonly warnings: readonly ProfileWarning[];
  readonly sources: readonly ProfileSource[];
  readonly notes: readonly string[];
}

function mergeMode(base: ModeRules | undefined, over: ModeRules | undefined): ModeRules {
  const merged: ModeRules = {};
  const defaults = { ...base?.defaults, ...over?.defaults };
  const constraints = { ...base?.constraints, ...over?.constraints };
  const collections = { ...base?.collections, ...over?.collections };
  if (Object.keys(defaults).length > 0) merged.defaults = defaults;
  if (Object.keys(constraints).length > 0) merged.constraints = constraints;
  if (Object.keys(collections).length > 0) merged.collections = collections;
  return merged;
}

/**
 * Applies a variant: its blocks replace the family's; its modes merge per mode
 * and per path, the variant's entry winning; its warnings, sources and notes
 * follow the family's.
 *
 * @param profile a profile that passed {@link checkModelProfile}
 * @param variant the variant, or `undefined` for the family level
 */
export function applyVariant(profile: ModelProfile, variant?: ProfileVariant): ResolvedProfile {
  const modes: ProfileModes = {};
  const names = new Set([
    ...Object.keys(profile.modes),
    ...Object.keys(variant?.modes ?? {}),
  ]) as Set<GenerationMode>;
  for (const mode of names) modes[mode] = mergeMode(profile.modes[mode], variant?.modes?.[mode]);

  const licence = variant?.licence ?? profile.licence;
  const frames = variant?.frames ?? profile.frames;
  return {
    family: profile.family,
    name: variant?.name ?? profile.name,
    ...(variant === undefined ? {} : { variant: { id: variant.id, name: variant.name } }),
    ...(licence === undefined ? {} : { licence }),
    prompt: variant?.prompt ?? profile.prompt,
    negative_prompt: variant?.negative_prompt ?? profile.negative_prompt,
    resolution: variant?.resolution ?? profile.resolution,
    ...(frames === undefined ? {} : { frames }),
    modes,
    warnings: [...(profile.warnings ?? []), ...(variant?.warnings ?? [])],
    sources: [...profile.sources, ...(variant?.sources ?? [])],
    notes: [...(profile.notes ?? []), ...(variant?.notes ?? [])],
  };
}

/**
 * The narrowing a mode applies: its constraints, with the family's
 * `multiple_of` on `geometry.width` and `geometry.height` (unless a constraint
 * already sets one for that field). `undefined` when the mode is unsupported.
 *
 * @param profile the resolved profile
 * @param mode the mode
 */
export function modeConstraints(
  profile: ResolvedProfile,
  mode: GenerationMode,
): NarrowingMap | undefined {
  const rules = profile.modes[mode];
  if (rules === undefined) return undefined;
  const constraints: NarrowingMap = { ...rules.constraints };
  for (const field of ['geometry.width', 'geometry.height']) {
    const existing = constraints[field];
    if (existing?.multipleOf !== undefined) continue;
    constraints[field] = { ...existing, multipleOf: profile.resolution.multiple_of };
  }
  return constraints;
}
