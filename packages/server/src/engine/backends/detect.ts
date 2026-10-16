// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Autodetect (A32) as a list of probes (L9): each kind looks for itself by
 * path, at its default addresses on this machine or at a URL a person typed.
 * A find becomes a proposal card (A26): the models it serves now, each with
 * the model Lantern already has for its fingerprint and a family guess.
 * Nothing is added; `POST /backends` does that with the card's choices.
 */

import type {
  DetectedBackend,
  DetectResponse,
  ProbeOutcome,
} from '@bureaucromancer/lantern-schema';

import type { FetchLike } from '../../adapters/shared/index.js';
import type { BackendKindDefinition, ProbeResult } from './kinds.js';
import { normaliseBaseUrl, type BackendRegistry } from './registry.js';

export interface DetectOptions {
  /** A URL to test as every kind; absent: each kind's default addresses. */
  readonly url?: string;
  readonly fetch?: FetchLike;
}

function proposal(
  registry: BackendRegistry,
  definition: BackendKindDefinition,
  baseUrl: string,
  result: Extract<ProbeResult, { found: true }>,
): DetectedBackend {
  return {
    kind: definition.kind,
    base_url: baseUrl,
    name: `${definition.name} at ${baseUrl}`,
    registered: registry.registeredAt(definition.kind, baseUrl) ?? null,
    detail: result.detail,
    models: result.models.map((model) => ({
      name:
        model.managerRef ??
        (model.identity.kind === 'file' ? model.identity.stem : model.identity.model_id),
      fingerprint: model.identity,
      ...(model.managerRef === undefined ? {} : { manager_ref: model.managerRef }),
      existing: registry.modelByFingerprint(model.identity) ?? null,
      guess: registry.guess(model.identity, model.hints),
    })),
  };
}

/**
 * Runs the probes, all at once.
 *
 * @param registry what is registered already, and the guesser
 * @param options a URL to test, and the `fetch` to use
 */
export async function detectBackends(
  registry: BackendRegistry,
  options: DetectOptions = {},
): Promise<DetectResponse> {
  const fetchImpl: FetchLike = options.fetch ?? registry.kinds.fetch;
  const jobs: { definition: BackendKindDefinition; baseUrl: string }[] = [];
  for (const definition of registry.kinds.list()) {
    const urls = options.url === undefined ? definition.defaultUrls : [options.url];
    for (const url of urls) jobs.push({ definition, baseUrl: normaliseBaseUrl(url) });
  }
  const results = await Promise.all(
    jobs.map(async (job) => ({
      ...job,
      result: await job.definition.probe(fetchImpl, job.baseUrl),
    })),
  );
  const candidates: DetectedBackend[] = [];
  const probes: ProbeOutcome[] = [];
  for (const { definition, baseUrl, result } of results) {
    probes.push({
      kind: definition.kind,
      url: result.url,
      found: result.found,
      ...(result.found ? {} : { detail: result.detail }),
    });
    if (result.found) candidates.push(proposal(registry, definition, baseUrl, result));
  }
  return { candidates, probes };
}
