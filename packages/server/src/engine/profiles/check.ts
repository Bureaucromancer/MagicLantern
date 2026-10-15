// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The profile rules the schema can't state: every path is in the request path
 * grammar, every cited source exists, defaults have their field's type and
 * satisfy their own constraints, sampler and scheduler defaults are canonical,
 * and sizes are multiples of the family's `multiple_of`. Run on the family
 * level and on each variant applied, because a variant's defaults must satisfy
 * the constraints they merge with.
 */

import {
  type GenerationMode,
  isCanonicalSampler,
  isCanonicalScheduler,
  type ModelProfile,
  REQUEST_PATHS,
  UNCONFIRMED_SOURCE,
  type ValidationIssue,
} from '@bureaucromancer/lantern-schema';
import type { Ajv } from 'ajv';

import { requestFieldSchema } from './field-schema.js';
import { applyVariant, modeConstraints, type ResolvedProfile } from './resolve.js';

/** Paths by kind. Experimental paths (`subjects`, `style`) take no profile entries. */
function pathsOf(kind: 'field' | 'collection'): ReadonlySet<string> {
  return new Set(
    REQUEST_PATHS.filter((p) => p.kind === kind && p.experimental !== true).map((p) => p.path),
  );
}

const FIELD_PATHS = pathsOf('field');
const COLLECTION_PATHS = pathsOf('collection');

/** A JSON pointer from its tokens (RFC 6901). */
function pointer(...tokens: (string | number)[]): string {
  return tokens.map((t) => `/${String(t).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

/**
 * Where an entry lives: under the variant when the variant gives it, under the
 * family otherwise.
 */
type Locate = (fromVariant: boolean, ...tokens: (string | number)[]) => string;

function checkSources(
  resolved: ResolvedProfile,
  locate: Locate,
  hasOwn: (...tokens: string[]) => boolean,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  for (const source of resolved.sources) {
    if (source.id === UNCONFIRMED_SOURCE || ids.has(source.id)) {
      issues.push({
        path: locate(hasOwn('sources'), 'sources'),
        message: `source id \`${source.id}\` is reserved or repeated`,
      });
    }
    ids.add(source.id);
  }
  const cite = (source: string | undefined, fromVariant: boolean, ...tokens: string[]) => {
    if (source === undefined || source === UNCONFIRMED_SOURCE || ids.has(source)) return;
    issues.push({
      path: locate(fromVariant, ...tokens, 'source'),
      message: `cites \`${source}\`, which is not one of the profile's sources`,
    });
  };
  for (const block of ['licence', 'prompt', 'negative_prompt', 'resolution', 'frames'] as const) {
    cite(resolved[block]?.source, hasOwn(block), block);
  }
  for (const [mode, rules] of Object.entries(resolved.modes)) {
    for (const [path, entry] of Object.entries(rules.defaults ?? {})) {
      cite(entry.source, hasOwn('modes', mode, 'defaults', path), 'modes', mode, 'defaults', path);
    }
    for (const [path, entry] of Object.entries(rules.collections ?? {})) {
      const own = hasOwn('modes', mode, 'collections', path);
      cite(entry.source, own, 'modes', mode, 'collections', path);
    }
  }
  return issues;
}

function checkWarnings(resolved: ResolvedProfile, locate: Locate, familyCount: number) {
  const issues: ValidationIssue[] = [];
  const ids = new Set(resolved.sources.map((s) => s.id));
  resolved.warnings.forEach((warning, i) => {
    const fromVariant = i >= familyCount;
    const at = (...tokens: (string | number)[]) =>
      locate(fromVariant, 'warnings', fromVariant ? i - familyCount : i, ...tokens);
    for (const mode of warning.modes ?? []) {
      if (resolved.modes[mode] === undefined) {
        issues.push({ path: at('modes'), message: `\`${mode}\` is not a supported mode` });
      }
    }
    for (const path of Object.keys(warning.when ?? {})) {
      if (!FIELD_PATHS.has(path)) {
        issues.push({ path: at('when', path), message: 'is not a request field path' });
      }
    }
    const source = warning.source;
    if (source !== undefined && source !== UNCONFIRMED_SOURCE && !ids.has(source)) {
      issues.push({ path: at('source'), message: `cites \`${source}\`, an unknown source` });
    }
  });
  return issues;
}

function checkResolution(
  resolved: ResolvedProfile,
  locate: Locate,
  hasOwn: (...tokens: string[]) => boolean,
) {
  const issues: ValidationIssue[] = [];
  const own = hasOwn('resolution');
  const { multiple_of: multiple, native, presets } = resolved.resolution;
  const sizes: [string[], number, number][] = [];
  if (native !== undefined) sizes.push([['native'], native.width, native.height]);
  presets?.forEach((preset, i) =>
    sizes.push([['presets', String(i)], preset.width, preset.height]),
  );
  for (const [tokens, width, height] of sizes) {
    for (const [name, value] of [
      ['width', width],
      ['height', height],
    ] as const) {
      if (value % multiple !== 0) {
        issues.push({
          path: locate(own, 'resolution', ...tokens, name),
          message: `${String(value)} is not a multiple of ${String(multiple)}`,
        });
      }
    }
  }
  const aspects = new Set<string>();
  for (const preset of presets ?? []) {
    if (aspects.has(preset.aspect)) {
      issues.push({
        path: locate(own, 'resolution', 'presets'),
        message: `aspect ${preset.aspect} is listed twice`,
      });
    }
    aspects.add(preset.aspect);
  }
  const frames = resolved.frames;
  if (frames?.min !== undefined && frames.max !== undefined && frames.min > frames.max) {
    issues.push({
      path: locate(hasOwn('frames'), 'frames', 'min'),
      message: 'is greater than `max`',
    });
  }
  return issues;
}

function checkModes(
  resolved: ResolvedProfile,
  ajv: Ajv,
  locate: Locate,
  hasOwn: (...tokens: string[]) => boolean,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const modes = Object.keys(resolved.modes) as GenerationMode[];
  if (modes.length === 0) {
    issues.push({ path: locate(false, 'modes'), message: 'lists no supported mode' });
  }
  for (const mode of modes) {
    const rules = resolved.modes[mode] ?? {};
    const constraints = modeConstraints(resolved, mode) ?? {};
    const at = (kind: string, path: string, ...rest: string[]) =>
      locate(hasOwn('modes', mode, kind, path), 'modes', mode, kind, path, ...rest);

    for (const path of Object.keys(rules.constraints ?? {})) {
      if (!FIELD_PATHS.has(path)) {
        issues.push({ path: at('constraints', path), message: 'is not a request field path' });
      }
    }
    for (const [path, limit] of Object.entries(rules.collections ?? {})) {
      if (!COLLECTION_PATHS.has(path)) {
        issues.push({ path: at('collections', path), message: 'is not a collection path' });
      } else if (limit.min !== undefined && limit.max !== undefined && limit.min > limit.max) {
        issues.push({ path: at('collections', path, 'min'), message: 'is greater than `max`' });
      }
    }
    for (const [path, entry] of Object.entries(rules.defaults ?? {})) {
      const schema = requestFieldSchema(path);
      if (schema === undefined) {
        issues.push({ path: at('defaults', path), message: 'is not a request field path' });
        continue;
      }
      const narrowing = constraints[path];
      const validate = ajv.compile(
        narrowing === undefined ? schema : { allOf: [schema, narrowing] },
      );
      if (!validate(entry.value)) {
        const reasons = (validate.errors ?? []).map((e) => e.message ?? e.keyword).join('; ');
        issues.push({
          path: at('defaults', path, 'value'),
          message: `${JSON.stringify(entry.value)} does not fit the field or its constraints: ${reasons}`,
        });
      }
      const value = entry.value;
      if (
        path === 'sampling.sampler' &&
        !(typeof value === 'string' && isCanonicalSampler(value))
      ) {
        issues.push({
          path: at('defaults', path, 'value'),
          message: 'a profile default must be a canonical sampler name, never a native one',
        });
      }
      if (
        path === 'sampling.scheduler' &&
        !(typeof value === 'string' && isCanonicalScheduler(value))
      ) {
        issues.push({
          path: at('defaults', path, 'value'),
          message: 'a profile default must be a canonical scheduler name, never a native one',
        });
      }
    }
  }
  return issues;
}

/**
 * Every rule {@link ModelProfile}'s schema leaves to code, for the family
 * level and for each variant applied. Issue paths are JSON pointers into the
 * profile, under `/variants/<i>` when the variant gives the entry at fault.
 *
 * @param profile a profile that passed schema validation
 * @param ajv the validator to check default values with
 * @returns the issues, empty when the profile is valid
 */
export function checkModelProfile(profile: ModelProfile, ajv: Ajv): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const variants = profile.variants ?? [];

  const ids = new Set<string>();
  variants.forEach((variant, i) => {
    if (ids.has(variant.id)) {
      issues.push({ path: pointer('variants', i, 'id'), message: 'repeats a variant id' });
    }
    ids.add(variant.id);
  });
  if (profile.default_variant !== undefined && !ids.has(profile.default_variant)) {
    issues.push({ path: pointer('default_variant'), message: 'names no variant' });
  }

  const levels = [undefined, ...variants.map((variant, i) => ({ variant, i }))];
  for (const level of levels) {
    const resolved = applyVariant(profile, level?.variant);
    const locate: Locate = (fromVariant, ...tokens) =>
      level !== undefined && fromVariant
        ? pointer('variants', level.i, ...tokens)
        : pointer(...tokens);
    const hasOwn = (...tokens: string[]): boolean => {
      let node: unknown = level?.variant;
      for (const token of tokens) {
        if (typeof node !== 'object' || node === null) return false;
        node = (node as Record<string, unknown>)[token];
      }
      return node !== undefined;
    };

    if (resolved.licence === undefined && (level !== undefined || variants.length === 0)) {
      issues.push({
        path: level === undefined ? pointer('licence') : pointer('variants', level.i, 'licence'),
        message: 'has no licence, from the family or the variant',
      });
    }
    issues.push(
      ...checkSources(resolved, locate, hasOwn),
      ...checkWarnings(resolved, locate, profile.warnings?.length ?? 0),
      ...checkResolution(resolved, locate, hasOwn),
      ...checkModes(resolved, ajv, locate, hasOwn),
    );
  }

  // A family-level entry is checked once per level; report it once.
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.path}\n${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
