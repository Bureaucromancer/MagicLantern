// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The resolver's inputs and outputs. Backends, models and routes have no
 * tables yet (Phase 5), so the model and its route candidates are minimal
 * in-memory shapes named after the plan's data model (`models`, `routes`):
 * whoever builds them (the model catalog, tests) supplies each route's
 * effective descriptor, already merged (A6).
 */

import type {
  BlockedReason,
  FieldReport,
  GenerationMode,
  GenerationRequest,
  ResolutionWarning,
  ResolvedRoute,
  RouteDescriptor,
  RouteHealth,
  SkippedRoute,
  ValidationIssue,
} from '@bureaucromancer/lantern-schema';

/** Values by field path (`sampling.steps`, `inputs.control.weight`), one layer of precedence (A3). */
export type FieldValues = Readonly<Record<string, unknown>>;

/**
 * A model's identity, tagged (L4): the file a backend reports, or a
 * manager's own id and definition hash. Compared whole at dispatch.
 */
export type ModelFingerprint =
  | { readonly kind: 'file'; readonly path: string; readonly stem: string }
  | {
      readonly kind: 'manager';
      readonly manager: string;
      readonly model_id: string;
      readonly definition_hash: string;
    };

/** One route of a model, as the resolver sees it (`routes` row, Phase 5). */
export interface RouteCandidate {
  /** `routes.id`. */
  readonly id: string;
  /** The backend kind, e.g. `sdcpp`: the key of its `extensions` block. */
  readonly backend_kind: string;
  /** Higher is tried first; ties go by id. */
  readonly priority: number;
  /** Reachability and load state, kept apart (L2). Only `down` is unhealthy. */
  readonly health: RouteHealth;
  /** The effective descriptor: `describe()` with probe, override and profile layers merged. */
  readonly descriptor: RouteDescriptor;
  /** `routes.descriptor_digest`; computed from `descriptor` when absent. */
  readonly descriptor_digest?: string;
  /** The model's identity on this route (L4), checked again at dispatch (A12). */
  readonly fingerprint?: ModelFingerprint;
}

/** A model, as the resolver sees it (`models` row and its routes, Phase 5). */
export interface ResolverModel {
  /** `models.id`. */
  readonly id: string;
  /** The profile family, e.g. `sdxl`. */
  readonly family: string;
  /** The profile variant; absent: the family's default variant. */
  readonly variant?: string;
  /** `models.profile_overrides`: defaults per mode, the "model overrides" layer (A3). */
  readonly profile_overrides?: Partial<Record<GenerationMode, FieldValues>>;
  readonly routes: readonly RouteCandidate[];
}

/** What to resolve. */
export interface ResolveInput {
  /** The canonical request, unvalidated: the resolver validates it (rule 5). Never mutated. */
  readonly request: unknown;
  readonly model: ResolverModel;
  /** The route to use; absent: the route choice rule. */
  readonly route?: string;
  /** A preset's values by field path, the second layer of precedence. Empty until presets exist. */
  readonly preset?: FieldValues;
}

/** One job of the plan: 0.1 runs one; emulated fan-out (0.3) makes a tree. */
export interface PlannedJob {
  readonly route: string;
  /** Outputs this job makes; output k uses `seed + k` (A1). */
  readonly count: number;
  readonly seed: number;
}

/** A resolved request. */
export interface Resolution {
  /** The canonical request as given, validated. Its seed may be `"random"`. */
  readonly canonical: GenerationRequest;
  /** A valid request with every pixel-affecting value written out (A2, L7). */
  readonly effective: GenerationRequest;
  readonly field_report: FieldReport;
  readonly route: ResolvedRoute;
  readonly warnings: readonly ResolutionWarning[];
  readonly skipped_routes: readonly SkippedRoute[];
  readonly descriptor_digest: string;
  /** The chosen route's model identity, for the check at dispatch. */
  readonly fingerprint?: ModelFingerprint;
  readonly plan: readonly PlannedJob[];
  /**
   * True at submit and in a dry run; false once {@link Resolver.finalise} has
   * checked the route again at dispatch (A12).
   */
  readonly provisional: boolean;
  /** Present when the chosen route is down: the job would wait, queued (A12, L6). */
  readonly blocked_reason?: BlockedReason;
}

/** Why a request did not resolve. */
export type ResolveFailure =
  /** The request is invalid, on its own or on every route; issues point into the request. */
  | {
      readonly kind: 'invalid';
      readonly issues: readonly ValidationIssue[];
      readonly skipped_routes: readonly SkippedRoute[];
    }
  /** The route asked for is not one of the model's. */
  | { readonly kind: 'unknown_route'; readonly route: string }
  /** The model has no routes at all. */
  | { readonly kind: 'no_routes' };

export type ResolveOutcome =
  | { readonly ok: true; readonly resolution: Resolution }
  | { readonly ok: false; readonly failure: ResolveFailure };

/**
 * The wire request an adapter's `prepare` returns (A14): the exact body to
 * send, with `{"$asset": sha256}` placeholders. Opaque to the engine.
 */
export type WireRequest = unknown;

/**
 * The hook the engine calls after finalising, mirroring the adapter
 * interface's pure `prepare(route, req)` (A14). No adapters exist until
 * Phase 5, so nothing implements it yet.
 */
export interface PrepareHook {
  prepare(route: string, effective: GenerationRequest): Promise<WireRequest>;
}

/** What finalising at dispatch gives. */
export type FinaliseOutcome =
  | {
      readonly ok: true;
      readonly resolution: Resolution;
      /** Present when a {@link PrepareHook} was given. */
      readonly wire?: WireRequest;
    }
  | {
      readonly ok: false;
      /** The job goes back to (or stays) queued with this reason (L6). */
      readonly blocked_reason: BlockedReason;
      /** Present when the request no longer validates on the route. */
      readonly issues?: readonly ValidationIssue[];
    };

/**
 * Draws a seed: an integer in [0, limit). `limit` is at most 2^32 (A1), lower
 * when the route narrows `sampling.seed`. Injectable so tests are
 * deterministic.
 */
export type SeedSource = (limit: number) => number;
