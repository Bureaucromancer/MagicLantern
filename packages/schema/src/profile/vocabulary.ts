// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The canonical sampler and scheduler vocabulary (A5). Requests, profiles and
 * descriptors name samplers and schedulers in Lantern's vocabulary, and each
 * adapter maps a name to its backend's. The names are sd.cpp's (its
 * `sample_method_t` and `scheduler_t` in `include/stable-diffusion.h`), so the
 * Tier 1 adapter's mapping is the identity; other backends map or narrow them.
 *
 * A backend name the vocabulary lacks is written `native:<name>`, the escape
 * hatch: it is passed to the route as it stands, so it only means something on
 * a route whose backend knows the name. A1111 names contain spaces
 * (`native:DPM++ 2M Karras`), so a native name may too, but it is non-empty and
 * neither starts nor ends with whitespace.
 *
 * sd.cpp's CLI spellings were not verified against a build when this list was
 * written (Phase 2 research); the Tier 1 adapter's contract tests settle them.
 */

import { type Static, Type } from '@sinclair/typebox';

/** sd.cpp's sampling methods, in the order its header declares them. */
export const SAMPLERS = [
  'euler',
  'euler_a',
  'heun',
  'dpm2',
  'dpm++2s_a',
  'dpm++2m',
  'dpm++2mv2',
  'ipndm',
  'ipndm_v',
  'lcm',
  'ddim_trailing',
  'tcd',
  'res_multistep',
  'res_2s',
  'er_sde',
  'euler_cfg_pp',
  'euler_a_cfg_pp',
  'euler_ge',
  'dpm++2m_sde',
  'dpm++2m_sde_bt',
  'lms',
] as const;
export type CanonicalSampler = (typeof SAMPLERS)[number];

/** sd.cpp's schedulers. Some are model-specific (`flux`, `flux2`, `ltx2`, `llada_image`). */
export const SCHEDULERS = [
  'discrete',
  'karras',
  'exponential',
  'ays',
  'gits',
  'sgm_uniform',
  'simple',
  'smoothstep',
  'kl_optimal',
  'lcm',
  'bong_tangent',
  'ltx2',
  'logit_normal',
  'flux2',
  'flux',
  'beta',
  'llada_image',
] as const;
export type CanonicalScheduler = (typeof SCHEDULERS)[number];

/** The prefix of a backend's own name. */
export const NATIVE_PREFIX = 'native:';

/** A native name after its prefix: non-empty, no leading or trailing whitespace. */
const NATIVE_NAME_SOURCE = '\\S(?:.*\\S)?';

/** Matches `native:<name>`. */
export const NATIVE_NAME_PATTERN = `^${NATIVE_PREFIX}${NATIVE_NAME_SOURCE}$`;

const NATIVE_NAME = new RegExp(NATIVE_NAME_PATTERN, 's');

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A pattern matching one of `names` or a native name. */
function namePattern(names: readonly string[]): string {
  return `^(?:${names.map(escapeRegExp).join('|')}|${NATIVE_PREFIX}${NATIVE_NAME_SOURCE})$`;
}

/** Matches a canonical sampler name or `native:<name>`. */
export const SAMPLER_NAME_PATTERN = namePattern(SAMPLERS);

/** Matches a canonical scheduler name or `native:<name>`. */
export const SCHEDULER_NAME_PATTERN = namePattern(SCHEDULERS);

export const CanonicalSampler = Type.Union(
  SAMPLERS.map((name) => Type.Literal(name)),
  { description: "A sampler in Lantern's canonical vocabulary (sd.cpp's names)." },
);

export const CanonicalScheduler = Type.Union(
  SCHEDULERS.map((name) => Type.Literal(name)),
  { description: "A scheduler in Lantern's canonical vocabulary (sd.cpp's names)." },
);

export const SamplerName = Type.String({
  pattern: SAMPLER_NAME_PATTERN,
  description: 'A canonical sampler name, or `native:<name>` for a backend name.',
});
export type SamplerName = Static<typeof SamplerName>;

export const SchedulerName = Type.String({
  pattern: SCHEDULER_NAME_PATTERN,
  description: 'A canonical scheduler name, or `native:<name>` for a backend name.',
});
export type SchedulerName = Static<typeof SchedulerName>;

/** A parsed sampler or scheduler name. */
export type ParsedName<T extends string> =
  | { readonly kind: 'canonical'; readonly name: T }
  | { readonly kind: 'native'; readonly name: string };

/**
 * Whether `name` is `native:<name>` with a well-formed name.
 *
 * @param name the name as written
 */
export function isNativeName(name: string): boolean {
  return NATIVE_NAME.test(name);
}

function parseName<T extends string>(vocabulary: readonly T[], name: string): ParsedName<T> | null {
  if ((vocabulary as readonly string[]).includes(name))
    return { kind: 'canonical', name: name as T };
  if (isNativeName(name)) return { kind: 'native', name: name.slice(NATIVE_PREFIX.length) };
  return null;
}

/**
 * Reads a sampler name: canonical, native (the backend's name, prefix
 * removed), or `null` when it is neither, such as a misspelt canonical name or
 * an empty `native:`.
 *
 * @param name the name as written in a request, profile or descriptor
 */
export function parseSamplerName(name: string): ParsedName<CanonicalSampler> | null {
  return parseName(SAMPLERS, name);
}

/**
 * Reads a scheduler name, as {@link parseSamplerName} reads a sampler's.
 *
 * @param name the name as written in a request, profile or descriptor
 */
export function parseSchedulerName(name: string): ParsedName<CanonicalScheduler> | null {
  return parseName(SCHEDULERS, name);
}

/** Whether `name` is a canonical sampler (not a native one). */
export function isCanonicalSampler(name: string): name is CanonicalSampler {
  return (SAMPLERS as readonly string[]).includes(name);
}

/** Whether `name` is a canonical scheduler (not a native one). */
export function isCanonicalScheduler(name: string): name is CanonicalScheduler {
  return (SCHEDULERS as readonly string[]).includes(name);
}
