// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The re-run actions (A11), as resolutions. Each is a new job; finished jobs
 * are never reset.
 *
 * - **Reproduce** submits `effective` on the same route. The preflight the plan
 *   asks for (model fingerprint, LoRA paths, generator version) needs
 *   `route_snapshot` and adapters, and arrives with the job engine (Phase 4).
 * - **Re-roll** does the same with a new seed.
 * - **Another route** starts from `canonical`, never `effective`, so the new
 *   route's own defaults apply; extensions for another backend kind are
 *   reported as ignored. It keeps the seed the job ran with, so the two
 *   results compare; "Use settings" (the browser's) does the same.
 * - **Use settings** happens in the browser, from `canonical` and its seed.
 */

import type { GenerationRequest } from '@bureaucromancer/lantern-schema';

import type { Resolver } from './resolver.js';
import type { FieldValues, ResolveOutcome, ResolverModel } from './types.js';

/** What a finished job keeps that a re-run needs (`job_payloads`, `jobs.route_id`). */
export interface RerunSource {
  readonly canonical: GenerationRequest;
  readonly effective: GenerationRequest;
  readonly route: string;
}

function concreteSeed(job: RerunSource): number {
  const seed = job.effective.sampling.seed;
  if (typeof seed !== 'number') throw new Error('A stored effective request has a concrete seed.');
  return seed;
}

/**
 * Reproduce: `effective` again, on the same route.
 *
 * @param resolver the resolver
 * @param job the job to reproduce
 * @param model the model as it is now
 */
export function reproduce(
  resolver: Resolver,
  job: RerunSource,
  model: ResolverModel,
): ResolveOutcome {
  return resolver.resolve({ request: job.effective, model, route: job.route });
}

/**
 * Re-roll: `effective` on the same route with a newly drawn seed, never the
 * job's own.
 */
export function reroll(resolver: Resolver, job: RerunSource, model: ResolverModel): ResolveOutcome {
  const request: GenerationRequest = {
    ...job.effective,
    sampling: { ...job.effective.sampling, seed: 'random' },
  };
  return resolver.resolve({ request, model, route: job.route }, { avoid: concreteSeed(job) });
}

/**
 * Another route: `canonical`, with the job's seed, on another route of the
 * model: the one named, else the route choice rule over every route but the
 * job's.
 *
 * @param route the route to use; absent: the best of the others
 * @param preset the preset the job used, if any
 */
export function anotherRoute(
  resolver: Resolver,
  job: RerunSource,
  model: ResolverModel,
  route?: string,
  preset?: FieldValues,
): ResolveOutcome {
  const request: GenerationRequest = {
    ...job.canonical,
    sampling: { ...job.canonical.sampling, seed: concreteSeed(job) },
  };
  const candidates =
    route === undefined
      ? { ...model, routes: model.routes.filter((candidate) => candidate.id !== job.route) }
      : model;
  return resolver.resolve({
    request,
    model: candidates,
    ...(route === undefined ? {} : { route }),
    ...(preset === undefined ? {} : { preset }),
  });
}
