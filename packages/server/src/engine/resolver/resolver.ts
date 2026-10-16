// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The resolver (plan, "Resolver"): from a canonical request and a model to the
 * request as it will run. The steps, in order:
 *
 * 1. validate against the schema with rule 5's Ajv (unknown fields refused);
 * 2. check the mode's requirements (`checkGenerationRequest`), and that the
 *    model's profile supports the mode;
 * 3. choose the route: the one asked for, else the highest-priority healthy
 *    route on which the request validates. Cold counts as healthy (L2); only
 *    `down` is skipped. When no healthy route takes the request but a down one
 *    does, that one is chosen and the resolution carries a `blocked_reason`:
 *    the job would wait, queued (A12, L6). Each route passed over is listed
 *    with why;
 * 4. fill values by precedence (A3; `fill.ts`), never changing one the
 *    request set: a value the route can't take is a 422 whose issue carries a
 *    suggested value;
 * 5. draw a seed for `"random"`, in [0, 2^32) (A1), or the route's narrower
 *    range;
 * 6. write the field report and the warnings (`report.ts`);
 * 7. plan: one job in 0.1;
 * 8. `prepare` (the wire request) waits for adapters (Phase 5); finalise
 *    takes a {@link PrepareHook} for it.
 *
 * `effective` is checked again before it is returned, against the schema, the
 * mode rules and the route: a resolution that would not resubmit is a bug,
 * and throws.
 *
 * A resolution at submit (or a dry run) is provisional (A12). At dispatch,
 * {@link Resolver.finalise} checks the route's health and the model's identity
 * again and re-runs with the seed already drawn.
 */

import {
  checkGenerationRequest,
  type FieldSource,
  type GenerationMode,
  GenerationRequest as GenerationRequestSchema,
  type GenerationRequest,
  type ModeDescriptor,
  REQUEST_NODES,
  type ResolutionWarning,
  type RouteDescriptor,
  SEED_DRAW_LIMIT,
  type SkippedRoute,
  type ValidationIssue,
} from '@bureaucromancer/lantern-schema';
import type { Ajv, ValidateFunction } from 'ajv';
import { randomInt } from 'node:crypto';

import { issuesOfAjv } from '../../validation/issues.js';
import { canonicalJson, createRequestValidator, descriptorDigest } from '../descriptor/index.js';
import type { ProfileRegistry, ResolvedProfile } from '../profiles/index.js';
import { fillDefaults, routeNarrowing } from './fill.js';
import { fieldOfPointer, valueAt } from './leaves.js';
import { buildFieldReport, profileWarnings } from './report.js';
import { suggestValue } from './suggest.js';
import type {
  FieldValues,
  FinaliseOutcome,
  FinaliseSource,
  PrepareHook,
  Resolution,
  ResolveFailure,
  ResolveInput,
  ResolveOutcome,
  ResolverModel,
  RouteCandidate,
  SeedSource,
} from './types.js';

export interface ResolverOptions {
  /** The daemon's Ajv (`createValidator()`): rule 5's settings. */
  readonly ajv: Ajv;
  /** Where model profiles come from (`builtinProfiles()`). */
  readonly profiles: ProfileRegistry;
  /** Draws seeds; `crypto.randomInt` by default. */
  readonly drawSeed?: SeedSource;
}

/** How to treat a `"random"` seed. */
export type SeedPolicy =
  /** Use this seed instead of drawing: finalising at dispatch keeps the seed drawn at submit. */
  | { readonly fixed: number }
  /** Draw, but never this seed: a re-roll. */
  | { readonly avoid: number };

export interface FinaliseOptions {
  /** The preset the provisional resolution used. */
  readonly preset?: FieldValues;
  /** The adapter's `prepare`, once adapters exist (Phase 5). */
  readonly prepare?: PrepareHook;
}

export interface Resolver {
  /**
   * Resolves a canonical request. Never throws for a bad request: refusals
   * are a failed outcome. Throws only on a caller's bug (an unknown profile
   * family, an invalid descriptor).
   */
  resolve(input: ResolveInput, seed?: SeedPolicy): ResolveOutcome;
  /**
   * Finalises a provisional resolution at dispatch (A12): the route must still
   * exist, not be down, and serve the same model; then the request is resolved
   * again on it with the seed drawn at submit, and prepared.
   *
   * @param provisional the resolution made at submit
   * @param model the model as it is now
   */
  finalise(
    provisional: FinaliseSource,
    model: ResolverModel,
    options?: FinaliseOptions,
  ): Promise<FinaliseOutcome>;
}

/** How many draws a re-roll makes to avoid the old seed before giving up. */
const REROLL_ATTEMPTS = 16;

function defaultDrawSeed(limit: number): number {
  return randomInt(limit);
}

function byPriority(a: RouteCandidate, b: RouteCandidate): number {
  return b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function invalid(
  issues: readonly ValidationIssue[],
  skipped: readonly SkippedRoute[] = [],
): ResolveOutcome {
  return { ok: false, failure: { kind: 'invalid', issues, skipped_routes: skipped } };
}

function failure(failure: ResolveFailure): ResolveOutcome {
  return { ok: false, failure };
}

/**
 * Adds a suggested value to each issue about a value the field's bounds
 * refuse. The route's narrowing applies when there is a route.
 */
function withSuggestions(
  issues: readonly ValidationIssue[],
  request: unknown,
  mode?: ModeDescriptor,
): ValidationIssue[] {
  return issues.map((issue) => {
    const field = fieldOfPointer(request, issue.path);
    const node = field === undefined ? undefined : REQUEST_NODES.get(field);
    if (field === undefined || node?.kind !== 'field') return issue;
    const value = valueAt(request, issue.path);
    if (value === undefined) return issue;
    const entry = mode?.fields[field];
    const narrowing = entry === undefined ? {} : routeNarrowing(field, entry, mode);
    const suggested = suggestValue(value, node.schema, narrowing, entry?.default);
    return suggested === undefined ? issue : { ...issue, suggested };
  });
}

/** The values a layer gives, as a plain record. */
function profileDefaults(profile: ResolvedProfile, mode: GenerationMode): FieldValues {
  const defaults = profile.modes[mode]?.defaults ?? {};
  return Object.fromEntries(Object.entries(defaults).map(([path, entry]) => [path, entry.value]));
}

/** The range a seed is drawn from: [0, 2^32), narrowed by the route's bounds on `sampling.seed`. */
function seedRange(mode: ModeDescriptor): { lower: number; upper: number } {
  const entry = mode.fields['sampling.seed'];
  let lower = 0;
  let upper = SEED_DRAW_LIMIT;
  if (entry !== undefined && entry.state !== 'ignored') {
    if (entry.minimum !== undefined) lower = Math.max(lower, Math.ceil(entry.minimum));
    if (entry.exclusiveMinimum !== undefined) {
      lower = Math.max(lower, Math.floor(entry.exclusiveMinimum) + 1);
    }
    if (entry.maximum !== undefined) upper = Math.min(upper, Math.floor(entry.maximum) + 1);
    if (entry.exclusiveMaximum !== undefined) {
      upper = Math.min(upper, Math.ceil(entry.exclusiveMaximum));
    }
  }
  return { lower, upper };
}

function seedOf(provisional: FinaliseSource): number {
  const seed = provisional.effective.sampling.seed;
  if (typeof seed !== 'number') throw new Error('A provisional resolution has a concrete seed.');
  return seed;
}

export function createResolver(options: ResolverOptions): Resolver {
  const { ajv, profiles } = options;
  const drawSeed = options.drawSeed ?? defaultDrawSeed;
  const validateSchema: ValidateFunction = ajv.compile(GenerationRequestSchema);
  const digests = new WeakMap<RouteDescriptor, string>();
  const validators = new Map<string, (request: unknown) => ValidationIssue[]>();

  function digestOf(route: RouteCandidate): string {
    if (route.descriptor_digest !== undefined) return route.descriptor_digest;
    let digest = digests.get(route.descriptor);
    if (digest === undefined) {
      digest = descriptorDigest(route.descriptor);
      digests.set(route.descriptor, digest);
    }
    return digest;
  }

  /** The issues of a request on a route, with suggestions. */
  function routeIssues(route: RouteCandidate, mode: GenerationMode, request: GenerationRequest) {
    const key = `${digestOf(route)}:${mode}`;
    let validate = validators.get(key);
    if (validate === undefined) {
      validate = createRequestValidator(ajv, route.descriptor, mode);
      validators.set(key, validate);
    }
    return withSuggestions(validate(request), request, route.descriptor.modes[mode]);
  }

  function draw(range: { lower: number; upper: number }, policy?: SeedPolicy): number {
    if (policy !== undefined && 'fixed' in policy) return policy.fixed;
    const span = range.upper - range.lower;
    const attempts = policy === undefined || span <= 1 ? 1 : REROLL_ATTEMPTS;
    let seed = range.lower;
    for (let i = 0; i < attempts; i += 1) {
      const drawn = drawSeed(span);
      if (!Number.isInteger(drawn) || drawn < 0 || drawn >= span) {
        throw new RangeError(
          `The seed source drew ${String(drawn)}, outside [0, ${String(span)}).`,
        );
      }
      seed = range.lower + drawn;
      if (seed !== policy?.avoid) break;
    }
    return seed;
  }

  function resolve(input: ResolveInput, seedPolicy?: SeedPolicy): ResolveOutcome {
    // 1. The schema, with rule 5's Ajv.
    if (!validateSchema(input.request)) {
      return invalid(withSuggestions(issuesOfAjv(validateSchema.errors ?? []), input.request));
    }
    const canonical = input.request as GenerationRequest;

    // 2. The mode's rules, and the model's support for the mode.
    const ruleIssues = checkGenerationRequest(canonical);
    if (ruleIssues.length > 0) return invalid(ruleIssues);
    const { model } = input;
    const profile = profiles.resolve(model.family, model.variant);
    if (profile === undefined) {
      throw new Error(
        `Model ${model.id} names the profile ${model.family}${model.variant === undefined ? '' : `/${model.variant}`}, which is not loaded`,
      );
    }
    const modeName = canonical.mode;
    if (profile.modes[modeName] === undefined) {
      return invalid([{ path: '/mode', message: `${profile.name} does not support ${modeName}` }]);
    }

    // 3. The route.
    if (model.routes.length === 0) return failure({ kind: 'no_routes' });
    let candidates: RouteCandidate[];
    if (input.route === undefined) {
      candidates = [...model.routes].sort(byPriority);
    } else {
      const asked = model.routes.find((route) => route.id === input.route);
      if (asked === undefined) return failure({ kind: 'unknown_route', route: input.route });
      candidates = [asked];
    }
    const explicit = input.route !== undefined;

    const skipped: SkippedRoute[] = [];
    let chosen: RouteCandidate | undefined;
    let fallback: RouteCandidate | undefined;
    let firstIssues: ValidationIssue[] | undefined;
    for (const route of candidates) {
      if (route.descriptor.modes[modeName] === undefined) {
        skipped.push({ route: route.id, reason: 'mode_unsupported' });
        continue;
      }
      const issues = routeIssues(route, modeName, canonical);
      const down = route.health.status === 'down' && !explicit;
      if (issues.length > 0) {
        firstIssues ??= issues;
        skipped.push({ route: route.id, reason: 'invalid', issues });
        continue;
      }
      if (down) {
        fallback ??= route;
        skipped.push({ route: route.id, reason: 'down' });
        continue;
      }
      chosen = route;
      break;
    }
    if (chosen === undefined && fallback !== undefined) {
      const id = fallback.id;
      chosen = fallback;
      skipped.splice(
        skipped.findIndex((entry) => entry.route === id),
        1,
      );
    }
    if (chosen === undefined) {
      const issues = firstIssues ?? [
        {
          path: '/mode',
          message: explicit
            ? `route ${input.route ?? ''} does not serve ${modeName}`
            : `no route of model ${model.id} serves ${modeName}`,
        },
      ];
      return invalid(issues, skipped);
    }
    const mode = chosen.descriptor.modes[modeName];
    // Checked when the route was chosen.
    if (mode === undefined) throw new Error(`Route ${chosen.id} lost ${modeName}`);

    // 4. Values by precedence.
    const filled = fillDefaults(canonical, mode, {
      preset: input.preset ?? {},
      model: model.profile_overrides?.[modeName] ?? {},
      profile: profileDefaults(profile, modeName),
    });
    const effective = filled.effective;
    const sources = new Map<string, FieldSource>(filled.sources);

    // 5. The seed.
    if (canonical.sampling.seed === 'random') {
      effective.sampling.seed = draw(seedRange(mode), seedPolicy);
      sources.set('/sampling/seed', 'drawn');
    }

    // `effective` must resubmit as it stands (A2).
    const recheck = validateSchema(effective)
      ? [...checkGenerationRequest(effective), ...routeIssues(chosen, modeName, effective)]
      : issuesOfAjv(validateSchema.errors ?? []);
    if (recheck.length > 0) {
      throw new Error(
        `The effective request does not validate on ${chosen.id}: ${recheck.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
      );
    }

    // 6. The field report and the warnings.
    const field_report = buildFieldReport(canonical, effective, sources, mode, chosen.backend_kind);
    const warnings: ResolutionWarning[] = [
      ...filled.warnings,
      ...profileWarnings(profile.warnings, modeName, effective),
    ];
    const down = chosen.health.status === 'down';
    if (down) {
      warnings.push({
        code: 'route_down',
        source: 'resolver',
        message: `Route ${chosen.id} is down; a job would wait, queued, until it is back.`,
      });
    }

    // 7. The plan: one job in 0.1; emulated fan-out arrives at 0.3.
    const seed = effective.sampling.seed as number;
    const plan = [{ route: chosen.id, count: effective.count ?? 1, seed }];

    const resolution: Resolution = {
      canonical,
      effective,
      field_report,
      route: {
        id: chosen.id,
        backend_kind: chosen.backend_kind,
        priority: chosen.priority,
        health: chosen.health,
      },
      warnings,
      skipped_routes: skipped,
      descriptor_digest: digestOf(chosen),
      ...(chosen.fingerprint === undefined ? {} : { fingerprint: chosen.fingerprint }),
      plan,
      provisional: true,
      ...(down
        ? { blocked_reason: { code: 'routes_down', detail: `Route ${chosen.id} is down.` } }
        : {}),
    };
    return { ok: true, resolution };
  }

  async function finalise(
    provisional: FinaliseSource,
    model: ResolverModel,
    finaliseOptions: FinaliseOptions = {},
  ): Promise<FinaliseOutcome> {
    const routeId = provisional.route.id;
    const route = model.routes.find((candidate) => candidate.id === routeId);
    if (route === undefined) {
      return {
        ok: false,
        blocked_reason: { code: 'route_missing', detail: `Route ${routeId} is gone.` },
      };
    }
    if (route.health.status === 'down') {
      return {
        ok: false,
        blocked_reason: { code: 'routes_down', detail: `Route ${routeId} is down.` },
      };
    }
    const before =
      provisional.fingerprint === undefined ? null : canonicalJson(provisional.fingerprint);
    const now = route.fingerprint === undefined ? null : canonicalJson(route.fingerprint);
    if (before !== now) {
      return {
        ok: false,
        blocked_reason: {
          code: 'identity_changed',
          detail: `Route ${routeId} no longer serves the model it served at submit.`,
        },
      };
    }

    const outcome = resolve(
      {
        request: provisional.canonical,
        model,
        route: routeId,
        ...(finaliseOptions.preset === undefined ? {} : { preset: finaliseOptions.preset }),
      },
      { fixed: seedOf(provisional) },
    );
    if (!outcome.ok) {
      const issues = outcome.failure.kind === 'invalid' ? outcome.failure.issues : [];
      return {
        ok: false,
        blocked_reason: {
          code: 'request_invalid',
          detail: `The request no longer validates on route ${routeId}.`,
        },
        issues,
      };
    }
    const resolution: Resolution = { ...outcome.resolution, provisional: false };
    if (finaliseOptions.prepare === undefined) return { ok: true, resolution };
    const wire = await finaliseOptions.prepare.prepare(routeId, resolution.effective);
    return { ok: true, resolution, wire };
  }

  return { resolve, finalise };
}
