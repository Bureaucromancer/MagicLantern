// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The model catalog: where the resolver finds a model and its routes.
 *
 * A seam for Phase 2. Models, backends and routes have no tables until
 * Phase 5, which replaces the in-memory implementation here with one over the
 * install database (`models`, `routes`, `backends`), fed by adapters'
 * `describe()` and `health()`. The interface is what the HTTP layer and the
 * job engine depend on, so that swap touches nothing else.
 *
 * The in-memory catalog does now what the real one will: each route's
 * effective descriptor is its `describe()` result with the probe, override
 * and profile layers merged (A6), the profile layer being the model profile's
 * constraints per mode, and a mode the profile does not support removed.
 */

import type {
  DescriptorLayer,
  GenerationMode,
  ModeLayer,
  RouteDescriptor,
  RouteHealth,
} from '@bureaucromancer/lantern-schema';

import {
  descriptorDigest,
  type MergeNote,
  mergeDescriptor,
  profileLayer,
} from '../descriptor/index.js';
import { modeConstraints, type ProfileRegistry, type ResolvedProfile } from '../profiles/index.js';
import type {
  FieldValues,
  ModelFingerprint,
  ResolverModel,
  RouteCandidate,
} from '../resolver/index.js';

/** Where the resolver finds models. Phase 5 backs it with the install database. */
export interface ModelCatalog {
  /** A model and its routes, or `undefined` for an unknown id. */
  get(id: string): ResolverModel | undefined;
  /** Every model, in a stable order. */
  list(): readonly ResolverModel[];
}

/** One route as configured: its `describe()` result and the layers over it. */
export interface CatalogRoute {
  readonly id: string;
  readonly backend_kind: string;
  readonly priority: number;
  readonly health: RouteHealth;
  /** The adapter's `describe()` result for this route. */
  readonly describe: RouteDescriptor;
  readonly probe?: DescriptorLayer;
  readonly override?: DescriptorLayer;
  readonly fingerprint?: ModelFingerprint;
}

/** One model as configured. */
export interface CatalogModel {
  readonly id: string;
  readonly family: string;
  readonly variant?: string;
  readonly profile_overrides?: Partial<Record<GenerationMode, FieldValues>>;
  readonly routes: readonly CatalogRoute[];
}

/** A model in the catalog, with what merging its routes' descriptors noted. */
export interface CatalogEntry {
  readonly model: ResolverModel;
  /** Layer requests the merge refused or applied in part, by route id. */
  readonly notes: ReadonlyMap<string, readonly MergeNote[]>;
}

/**
 * The profile layer for a route (A6): the profile's constraints for each
 * mode the route serves, and `absent` for a mode the profile does not support.
 *
 * @param profile the model's resolved profile
 * @param describe the route's `describe()` result
 */
export function profileLayerFor(
  profile: ResolvedProfile,
  describe: RouteDescriptor,
): DescriptorLayer {
  const modes: Partial<Record<GenerationMode, ModeLayer>> = {};
  for (const mode of Object.keys(describe.modes) as GenerationMode[]) {
    const narrow = modeConstraints(profile, mode);
    if (narrow === undefined) {
      modes[mode] = { state: 'absent' };
      continue;
    }
    const layer = profileLayer({ [mode]: { narrow } }).modes[mode];
    if (layer !== undefined) modes[mode] = layer;
  }
  return { modes };
}

/**
 * A model as the resolver sees it: each route's descriptor merged and digested.
 *
 * @param model the model as configured
 * @param profiles where its profile comes from
 * @throws Error when the model names a profile that is not loaded, or a
 *   route's `describe()` result is invalid
 */
export function catalogEntry(model: CatalogModel, profiles: ProfileRegistry): CatalogEntry {
  const profile = profiles.resolve(model.family, model.variant);
  if (profile === undefined) {
    throw new Error(`Model ${model.id} names the profile ${model.family}, which is not loaded`);
  }
  const notes = new Map<string, readonly MergeNote[]>();
  const routes: RouteCandidate[] = model.routes.map((route) => {
    const merged = mergeDescriptor(route.describe, {
      ...(route.probe === undefined ? {} : { probe: route.probe }),
      ...(route.override === undefined ? {} : { override: route.override }),
      profile: profileLayerFor(profile, route.describe),
    });
    notes.set(route.id, merged.notes);
    return {
      id: route.id,
      backend_kind: route.backend_kind,
      priority: route.priority,
      health: route.health,
      descriptor: merged.descriptor,
      descriptor_digest: descriptorDigest(merged.descriptor),
      ...(route.fingerprint === undefined ? {} : { fingerprint: route.fingerprint }),
    };
  });
  return {
    model: {
      id: model.id,
      family: model.family,
      ...(model.variant === undefined ? {} : { variant: model.variant }),
      ...(model.profile_overrides === undefined
        ? {}
        : { profile_overrides: model.profile_overrides }),
      routes,
    },
    notes,
  };
}

/** An in-memory catalog over configured models, merged once when built. */
export class InMemoryModelCatalog implements ModelCatalog {
  readonly #entries: ReadonlyMap<string, CatalogEntry>;

  constructor(models: readonly CatalogModel[], profiles: ProfileRegistry) {
    const entries = new Map<string, CatalogEntry>();
    for (const model of models) {
      if (entries.has(model.id)) throw new Error(`Model ${model.id} is listed twice`);
      entries.set(model.id, catalogEntry(model, profiles));
    }
    this.#entries = entries;
  }

  get(id: string): ResolverModel | undefined {
    return this.#entries.get(id)?.model;
  }

  list(): readonly ResolverModel[] {
    return [...this.#entries.values()].map((entry) => entry.model);
  }

  /** What merging a model's route descriptors noted, by route id. */
  notes(id: string): ReadonlyMap<string, readonly MergeNote[]> | undefined {
    return this.#entries.get(id)?.notes;
  }
}
