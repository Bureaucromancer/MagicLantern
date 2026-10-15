// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { readdirSync, readFileSync } from 'node:fs';

import {
  checkGenerationRequest,
  type GenerationMode,
  GenerationRequest,
  isCanonicalSampler,
  isCanonicalScheduler,
  MODE_REQUIRED_INPUTS,
  ModelProfile,
  REQUEST_PATH_SET,
  UNCONFIRMED_SOURCE,
} from '@bureaucromancer/lantern-schema';
import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import { createValidator } from '../../validation/ajv.js';
import { BUILTIN_PROFILE_DATA } from './builtin.generated.js';
import {
  applyVariant,
  builtinProfiles,
  loadProfiles,
  modeConstraints,
  ProfileLoadError,
  requestFieldSchema,
  type ResolvedProfile,
} from './index.js';

const PROFILES_DIR = new URL('../../../../../profiles/', import.meta.url);

const FILES = readdirSync(PROFILES_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort();

const RAW: ModelProfile[] = FILES.map(
  (name) => JSON.parse(readFileSync(new URL(name, PROFILES_DIR), 'utf8')) as ModelProfile,
);

/** Every profile at the family level and with each variant applied. */
const LEVELS: [string, ResolvedProfile][] = RAW.flatMap((profile) => [
  [profile.family, applyVariant(profile)] as [string, ResolvedProfile],
  ...(profile.variants ?? []).map(
    (variant) =>
      [`${profile.family}/${variant.id}`, applyVariant(profile, variant)] as [
        string,
        ResolvedProfile,
      ],
  ),
]);

const ajv = createValidator();

/** The issues `loadProfiles` reports for one profile, or `[]`. */
function loadIssues(profile: unknown): string[] {
  try {
    loadProfiles([profile]);
    return [];
  } catch (error) {
    if (!(error instanceof ProfileLoadError)) throw error;
    return error.issues.map((issue) => `${issue.path}: ${issue.message}`);
  }
}

function raw(family: string): ModelProfile {
  const profile = RAW.find((p) => p.family === family);
  if (profile === undefined) throw new Error(`no ${family} profile`);
  return structuredClone(profile);
}

describe('the built-in profile files', () => {
  it('cover the families Phase 2 promises', () => {
    expect(RAW.map((p) => p.family).sort()).toEqual([
      'flux1-dev',
      'flux1-schnell',
      'flux2-klein',
      'qwen-image',
      'qwen-image-edit',
      'sd15',
      'sdxl',
      'sdxl-turbo',
      'z-image-turbo',
    ]);
  });

  it('are named after their family', () => {
    expect(FILES).toEqual(RAW.map((p) => `${p.family}.json`));
  });

  it('match the generated module (run packages/server/scripts/generate-profiles.ts)', () => {
    expect(BUILTIN_PROFILE_DATA).toEqual(RAW);
  });

  it.each(RAW.map((p) => [p.family, p] as const))('%s validates against the schema', (_f, p) => {
    expect([...Value.Errors(ModelProfile, p)]).toEqual([]);
    expect(loadIssues(p)).toEqual([]);
  });

  it('load as one registry', () => {
    expect(() => builtinProfiles()).not.toThrow();
    expect(builtinProfiles().families()).toHaveLength(RAW.length);
  });
});

describe.each(LEVELS)('%s', (_label, profile) => {
  const modes = Object.keys(profile.modes) as GenerationMode[];
  const sourceIds = new Set([...profile.sources.map((s) => s.id), UNCONFIRMED_SOURCE]);

  it('supports at least one mode and has a licence', () => {
    expect(modes.length).toBeGreaterThan(0);
    if (profile.variant !== undefined || raw(profile.family).variants === undefined) {
      expect(profile.licence).toBeDefined();
    }
  });

  it('names only request paths', () => {
    for (const mode of modes) {
      const rules = profile.modes[mode]!;
      for (const path of [
        ...Object.keys(rules.defaults ?? {}),
        ...Object.keys(rules.constraints ?? {}),
        ...Object.keys(rules.collections ?? {}),
      ]) {
        expect(REQUEST_PATH_SET.has(path), `${mode} ${path}`).toBe(true);
      }
    }
    for (const warning of profile.warnings) {
      for (const path of Object.keys(warning.when ?? {})) {
        expect(REQUEST_PATH_SET.has(path), `${warning.code} ${path}`).toBe(true);
      }
    }
  });

  it('cites only its own sources or `unconfirmed`, and has a source URL', () => {
    expect(profile.sources.length).toBeGreaterThan(0);
    const cited = [
      profile.licence?.source,
      profile.prompt.source,
      profile.negative_prompt.source,
      profile.resolution.source,
      ...profile.warnings.map((w) => w.source),
      ...modes.flatMap((mode) => [
        ...Object.values(profile.modes[mode]!.defaults ?? {}).map((d) => d.source),
        ...Object.values(profile.modes[mode]!.collections ?? {}).map((c) => c.source),
      ]),
    ].filter((s) => s !== undefined);
    for (const source of cited) expect(sourceIds, source).toContain(source);
  });

  it('has defaults of the right type that satisfy its own constraints', () => {
    for (const mode of modes) {
      const constraints = modeConstraints(profile, mode)!;
      for (const [path, entry] of Object.entries(profile.modes[mode]!.defaults ?? {})) {
        const schema = requestFieldSchema(path);
        expect(schema, path).toBeDefined();
        expect(Value.Check(schema!, entry.value), `${mode} ${path}`).toBe(true);
        const narrowing = constraints[path];
        if (narrowing !== undefined) {
          const validate = ajv.compile({ allOf: [schema!, narrowing] });
          expect(validate(entry.value), `${mode} ${path}`).toBe(true);
        }
      }
    }
  });

  it('makes a valid request from its defaults in every mode', () => {
    for (const mode of modes) {
      const request: Record<string, unknown> = {
        schema_version: 1,
        mode,
        prompt: { positive: 'a lighthouse at dusk' },
        sampling: { seed: 0 },
        inputs: MODE_REQUIRED_INPUTS[mode].map((role) => ({ role, asset_id: 'a'.repeat(64) })),
        ...(mode === 'upscale' ? { passes: [{ kind: 'upscale', scale: 2 }] } : {}),
      };
      for (const [path, entry] of Object.entries(profile.modes[mode]!.defaults ?? {})) {
        const [head, field] = path.split('.') as [string, string];
        const parent = (request[head] ?? {}) as Record<string, unknown>;
        request[head] = { ...parent, [field]: entry.value };
      }
      const validate = ajv.compile(GenerationRequest);
      expect(validate(request), JSON.stringify(validate.errors)).toBe(true);
      expect(checkGenerationRequest(request as GenerationRequest)).toEqual([]);
    }
  });

  it('defaults samplers and schedulers to canonical names', () => {
    for (const mode of modes) {
      const defaults = profile.modes[mode]!.defaults ?? {};
      const sampler = defaults['sampling.sampler']?.value;
      const scheduler = defaults['sampling.scheduler']?.value;
      if (sampler !== undefined) expect(isCanonicalSampler(String(sampler))).toBe(true);
      if (scheduler !== undefined) expect(isCanonicalScheduler(String(scheduler))).toBe(true);
    }
  });

  it("keeps every size a multiple of the family's multiple", () => {
    const { multiple_of: multiple, native, presets } = profile.resolution;
    const sizes = [...(native === undefined ? [] : [native]), ...(presets ?? [])];
    for (const mode of modes) {
      const defaults = profile.modes[mode]!.defaults ?? {};
      const width = defaults['geometry.width']?.value;
      const height = defaults['geometry.height']?.value;
      if (width !== undefined || height !== undefined) {
        sizes.push({ width: Number(width), height: Number(height) });
      }
    }
    for (const { width, height } of sizes) {
      expect(width % multiple, `${String(width)}x${String(height)}`).toBe(0);
      expect(height % multiple, `${String(width)}x${String(height)}`).toBe(0);
    }
  });
});

describe('lookup', () => {
  const registry = builtinProfiles();

  it('applies a Flux.2 Klein variant', () => {
    const base9b = registry.resolve('flux2-klein', 'base-9b')!;
    expect(base9b.name).toBe('FLUX.2 [klein] Base 9B');
    expect(base9b.licence?.commercial_use).toBe(false);
    expect(base9b.modes.txt2img?.defaults?.['sampling.steps']?.value).toBe(50);
    expect(base9b.modes.txt2img?.defaults?.['sampling.cfg']?.value).toBe(4);
    // The family's geometry default survives the variant's merge.
    expect(base9b.modes.txt2img?.defaults?.['geometry.width']?.value).toBe(1024);
    expect(base9b.modes.edit?.collections?.['inputs.ref']?.max).toBe(4);

    const distilled4b = registry.resolve('flux2-klein', 'distilled-4b')!;
    expect(distilled4b.licence?.id).toBe('Apache-2.0');
    expect(distilled4b.modes.txt2img?.defaults?.['sampling.steps']?.value).toBe(4);
    expect(distilled4b.modes.txt2img?.defaults?.['sampling.cfg']?.value).toBe(1);
  });

  it('gives the family level when no variant is named and there is no default', () => {
    const family = registry.resolve('flux2-klein')!;
    expect(family.variant).toBeUndefined();
    expect(family.licence).toBeUndefined();
    expect(family.modes.txt2img?.defaults?.['sampling.steps']).toBeUndefined();
  });

  it('returns undefined for an unknown family or variant', () => {
    expect(registry.resolve('sd3')).toBeUndefined();
    expect(registry.resolve('flux2-klein', 'turbo')).toBeUndefined();
    expect(registry.resolve('sdxl', 'base-4b')).toBeUndefined();
  });

  it('lists supported modes', () => {
    expect(registry.modes('qwen-image-edit', '2511')).toEqual(['edit']);
    expect(registry.modes('sd15').sort()).toEqual(['img2img', 'txt2img']);
    expect(registry.modes('nope')).toEqual([]);
  });

  it("narrows width and height to the family's multiple", () => {
    const qwen = registry.resolve('qwen-image')!;
    expect(modeConstraints(qwen, 'txt2img')).toMatchObject({
      'geometry.width': { multipleOf: 16 },
      'geometry.height': { multipleOf: 16 },
    });
    expect(modeConstraints(qwen, 'inpaint')).toBeUndefined();
  });

  it("uses Qwen-Image's 1104, never 1140, for 4:3 and 3:4", () => {
    const presets = registry.resolve('qwen-image')!.resolution.presets!;
    expect(presets).toContainEqual({ aspect: '4:3', width: 1472, height: 1104 });
    expect(presets).toContainEqual({ aspect: '3:4', width: 1104, height: 1472 });
    expect(presets.flatMap((p) => [p.width, p.height])).not.toContain(1140);
  });
});

describe('loading refuses a broken profile', () => {
  it("catches Qwen-Image's 1472x1140 trap", () => {
    const qwen = raw('qwen-image');
    qwen.resolution.presets![5] = { aspect: '4:3', width: 1472, height: 1140 };
    expect(loadIssues(qwen)).toEqual([
      '/resolution/presets/5/height: 1140 is not a multiple of 16',
    ]);
  });

  it('refuses an unknown path', () => {
    const p = raw('sd15');
    p.modes.txt2img!.constraints = { 'sampling.stepz': { maximum: 4 } };
    p.warnings![0]!.when = { 'sampling.cfgg': { maximum: 1 } };
    expect(loadIssues(p)).toEqual([
      '/warnings/0/when/sampling.cfgg: is not a request field path',
      '/modes/txt2img/constraints/sampling.stepz: is not a request field path',
    ]);
  });

  it('refuses a default outside its constraints or of the wrong type', () => {
    const p = raw('sdxl-turbo');
    p.modes.txt2img!.constraints = { 'sampling.steps': { maximum: 0.5 } };
    p.modes.img2img!.defaults!['sampling.denoise'] = { value: 'half', source: 'card' };
    const issues = loadIssues(p);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/^\/modes\/txt2img\/defaults\/sampling.steps\/value: 1 does not fit/);
    expect(issues[1]).toMatch(/^\/modes\/img2img\/defaults\/sampling.denoise\/value: "half"/);
  });

  it('refuses a native or unknown sampler default', () => {
    const p = raw('flux1-dev');
    p.modes.txt2img!.defaults!['sampling.sampler'] = { value: 'native:euler', source: 'sdcpp' };
    p.modes.txt2img!.defaults!['sampling.scheduler'] = { value: 'pndm', source: 'sdcpp' };
    expect(loadIssues(p)).toEqual([
      '/modes/txt2img/defaults/sampling.sampler/value: a profile default must be a canonical sampler name, never a native one',
      '/modes/txt2img/defaults/sampling.scheduler/value: a profile default must be a canonical scheduler name, never a native one',
    ]);
  });

  it('refuses a citation of a source the profile lacks', () => {
    const p = raw('flux2-klein');
    p.variants![2]!.modes!.txt2img!.defaults!['sampling.steps']!.source = 'diffusers';
    expect(loadIssues(p)).toEqual([
      "/variants/2/modes/txt2img/defaults/sampling.steps/source: cites `diffusers`, which is not one of the profile's sources",
    ]);
  });

  it('refuses repeated variants, a missing default variant and a variant without a licence', () => {
    const p = raw('flux2-klein');
    p.variants![1]!.id = p.variants![0]!.id;
    p.default_variant = 'turbo';
    delete p.variants![3]!.licence;
    expect(loadIssues(p)).toEqual([
      '/variants/1/id: repeats a variant id',
      '/default_variant: names no variant',
      '/variants/3/licence: has no licence, from the family or the variant',
    ]);
  });

  it('refuses a collection limit on a field, and a warning for an unsupported mode', () => {
    const p = raw('z-image-turbo');
    p.modes.txt2img!.collections = { 'sampling.steps': { max: 1, source: 'card' } };
    p.warnings![0]!.modes = ['edit'];
    expect(loadIssues(p)).toEqual([
      '/warnings/0/modes: `edit` is not a supported mode',
      '/modes/txt2img/collections/sampling.steps: is not a collection path',
    ]);
  });

  it('refuses two profiles for one family, and names a profile that fails the schema', () => {
    const p = raw('sd15');
    expect(() => loadProfiles([p, p])).toThrow(/sd15 \/family: repeats another profile/);
    expect(() => loadProfiles([{ ...p, extra: true }])).toThrow(ProfileLoadError);
  });
});
