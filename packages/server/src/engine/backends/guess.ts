// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * A guess at a model's profile from its names (A26's proposal card): the
 * file stem, the path, and a manager's own name or checkpoint. Names are all
 * there is, since sd-server reports nothing about architecture, so the
 * guess says how sure it is:
 *
 * - `high`: a name says the family outright (`sd_xl_turbo`, `flux1-schnell`);
 * - `medium`: a likely reading (`z-image` without `turbo`);
 * - `low`: a hint and little more (a lone `xl`);
 * - `none`: nothing matched, so the generic profile.
 *
 * A model registered without a person's confirmation (one Lemonade loads
 * later) takes a `high` or `medium` guess, and the generic profile
 * otherwise; `PATCH /models/{id}` corrects either.
 */

import type { FamilyConfidence, FamilyGuess } from '@bureaucromancer/lantern-schema';

import type { ProfileRegistry } from '../profiles/index.js';

/** The profile for a model nothing describes: every default the backend's own. */
export const GENERIC_FAMILY = 'generic';

interface Rule {
  readonly family: string;
  readonly pattern: RegExp;
  readonly confidence: FamilyConfidence;
  /** The variant the names point to, if they do. */
  readonly variant?: (names: string) => string | undefined;
}

const SEP = '[._\\s-]?';

function kleinVariant(names: string): string | undefined {
  const size = /\b9b\b|[._-]9b/.test(names) ? '9b' : /\b4b\b|[._-]4b/.test(names) ? '4b' : null;
  if (size === null) return undefined;
  return `${names.includes('base') ? 'base' : 'distilled'}-${size}`;
}

function qwenEditVariant(names: string): string | undefined {
  if (names.includes('2511')) return '2511';
  if (names.includes('2509')) return '2509';
  return undefined;
}

/** In order: the first that matches wins, so the specific come before the general. */
const RULES: readonly Rule[] = [
  {
    family: 'flux2-klein',
    pattern: new RegExp(`flux${SEP}2.*klein|klein.*flux${SEP}2`),
    confidence: 'high',
    variant: kleinVariant,
  },
  {
    family: 'qwen-image-edit',
    pattern: new RegExp(`qwen${SEP}image${SEP}edit`),
    confidence: 'high',
    variant: qwenEditVariant,
  },
  { family: 'qwen-image', pattern: new RegExp(`qwen${SEP}image`), confidence: 'high' },
  { family: 'z-image-turbo', pattern: new RegExp(`z${SEP}image${SEP}turbo`), confidence: 'high' },
  { family: 'z-image-turbo', pattern: new RegExp(`(^|[^a-z])z${SEP}image`), confidence: 'medium' },
  { family: 'flux1-schnell', pattern: /flux.*schnell|schnell.*flux/, confidence: 'high' },
  { family: 'flux1-dev', pattern: /flux.*dev|dev.*flux/, confidence: 'high' },
  { family: 'flux1-dev', pattern: new RegExp(`flux${SEP}1`), confidence: 'low' },
  { family: 'sdxl-turbo', pattern: new RegExp(`sd${SEP}xl${SEP}turbo`), confidence: 'high' },
  { family: 'sdxl', pattern: new RegExp(`sd${SEP}xl`), confidence: 'high' },
  { family: 'sdxl', pattern: /(^|[^a-z0-9])xl([^a-z0-9]|$)/, confidence: 'low' },
  {
    family: 'sd15',
    pattern: new RegExp(`v1${SEP}5|sd${SEP}1${SEP}5|stable${SEP}diffusion${SEP}v?1${SEP}5`),
    confidence: 'high',
  },
];

/**
 * The guess for a model, from every name known for it.
 *
 * @param names the stem, path, a manager's name or checkpoint; any may be empty
 * @param profiles the loaded profiles: a family or variant not loaded is not guessed
 */
export function guessFamily(names: readonly string[], profiles: ProfileRegistry): FamilyGuess {
  const joined = names
    .filter((name) => name.length > 0)
    .join(' ')
    .toLowerCase()
    .replaceAll('\\', '/');
  for (const rule of RULES) {
    if (!rule.pattern.test(joined)) continue;
    const profile = profiles.family(rule.family);
    if (profile === undefined) continue;
    const variant = rule.variant?.(joined);
    const known = variant !== undefined && profile.variants?.some((v) => v.id === variant) === true;
    return {
      family: rule.family,
      ...(known ? { variant } : {}),
      confidence: rule.confidence,
      reason: `The name matches ${profile.name}${known ? ` (${variant})` : ''}.`,
    };
  }
  return {
    family: GENERIC_FAMILY,
    confidence: 'none',
    reason: 'No profile matches the name, so the backend’s own defaults apply.',
  };
}

/** Whether a guess is sure enough to register a model with unasked. */
export function trustworthy(guess: FamilyGuess): boolean {
  return guess.confidence === 'high' || guess.confidence === 'medium';
}
