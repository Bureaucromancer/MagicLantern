// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Loading model profiles, and looking them up by family and variant.
 *
 * The built-in profiles are the JSON files in the repository's `profiles/`
 * directory, compiled into the daemon as `builtin.generated.ts` by
 * `scripts/generate-profiles.ts`. That way they ship inside `dist` with no
 * file to find at run time (the installed tarball holds the server package
 * only, and request-time code has no filesystem access), and a test keeps the
 * module and the JSON identical. Each profile is validated when loaded,
 * against the schema and then {@link checkModelProfile}, so a bad edit fails
 * loudly rather than reaching the resolver.
 */

import {
  type GenerationMode,
  ModelProfile,
  type ValidationIssue,
} from '@bureaucromancer/lantern-schema';

import { createValidator } from '../../validation/ajv.js';
import { BUILTIN_PROFILE_DATA } from './builtin.generated.js';
import { checkModelProfile } from './check.js';
import { applyVariant, type ResolvedProfile } from './resolve.js';

/** One problem with one profile. */
export interface ProfileIssue extends ValidationIssue {
  /** The profile's family id, or its position when the family id is unreadable. */
  readonly profile: string;
}

/** Thrown when a profile fails validation. */
export class ProfileLoadError extends Error {
  readonly issues: readonly ProfileIssue[];

  constructor(issues: readonly ProfileIssue[]) {
    const lines = issues.map((i) => `  ${i.profile} ${i.path || '/'}: ${i.message}`);
    super(`Invalid model profiles:\n${lines.join('\n')}`);
    this.name = 'ProfileLoadError';
    this.issues = issues;
  }
}

/** Loaded, validated profiles, by family id. */
export class ProfileRegistry {
  readonly #profiles: ReadonlyMap<string, ModelProfile>;

  constructor(profiles: readonly ModelProfile[]) {
    this.#profiles = new Map(profiles.map((profile) => [profile.family, profile]));
  }

  /** Every family's profile, in load order. */
  families(): readonly ModelProfile[] {
    return [...this.#profiles.values()];
  }

  /** A family's profile as written, variants and all. */
  family(id: string): ModelProfile | undefined {
    return this.#profiles.get(id);
  }

  /**
   * A family's profile with a variant applied: the one named, else the
   * family's `default_variant`, else none (the family level, which holds only
   * what the variants share). `undefined` for an unknown family or variant.
   *
   * @param family the family id, e.g. `flux2-klein`
   * @param variant the variant id, e.g. `base-9b`
   */
  resolve(family: string, variant?: string): ResolvedProfile | undefined {
    const profile = this.#profiles.get(family);
    if (profile === undefined) return undefined;
    const id = variant ?? profile.default_variant;
    if (id === undefined) return applyVariant(profile);
    const found = profile.variants?.find((v) => v.id === id);
    return found === undefined ? undefined : applyVariant(profile, found);
  }

  /** The modes a family (or one of its variants) supports. */
  modes(family: string, variant?: string): GenerationMode[] {
    const resolved = this.resolve(family, variant);
    return resolved === undefined ? [] : (Object.keys(resolved.modes) as GenerationMode[]);
  }
}

/**
 * Validates profiles and builds a registry from them.
 *
 * @param data parsed profile JSON, one value per profile
 * @throws {ProfileLoadError} listing every issue in every profile, when any fails
 */
export function loadProfiles(data: readonly unknown[]): ProfileRegistry {
  const ajv = createValidator();
  const validate = ajv.compile<ModelProfile>(ModelProfile);
  const issues: ProfileIssue[] = [];
  const profiles: ModelProfile[] = [];
  const families = new Set<string>();

  data.forEach((value, i) => {
    const family =
      typeof value === 'object' && value !== null && 'family' in value
        ? String(value.family)
        : `#${String(i)}`;
    if (!validate(value)) {
      for (const error of validate.errors ?? []) {
        issues.push({
          profile: family,
          path: error.instancePath,
          message: error.message ?? error.keyword,
        });
      }
      return;
    }
    if (families.has(value.family)) {
      issues.push({ profile: family, path: '/family', message: 'repeats another profile' });
    }
    families.add(value.family);
    const found = checkModelProfile(value, ajv);
    issues.push(...found.map((issue) => ({ ...issue, profile: family })));
    profiles.push(value);
  });

  if (issues.length > 0) throw new ProfileLoadError(issues);
  return new ProfileRegistry(profiles);
}

let builtin: ProfileRegistry | undefined;

/** The built-in profiles, validated on first use. */
export function builtinProfiles(): ProfileRegistry {
  builtin ??= loadProfiles(BUILTIN_PROFILE_DATA);
  return builtin;
}
