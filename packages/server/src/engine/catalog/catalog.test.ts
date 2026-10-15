// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { checkRouteDescriptor } from '@bureaucromancer/lantern-schema';
import { describe, expect, it } from 'vitest';

import { createValidator } from '../../validation/ajv.js';
import { descriptorDigest } from '../descriptor/index.js';
import { builtinProfiles } from '../profiles/index.js';
import { createResolver } from '../resolver/index.js';
import { InMemoryModelCatalog } from './catalog.js';
import {
  DEV_MODEL,
  DEV_MODEL_ID,
  DEV_ROUTE_DESCRIPTOR,
  DEV_ROUTE_ID,
  isDevMode,
  startupModelCatalog,
} from './dev.js';

const profiles = builtinProfiles();

describe('the in-memory catalog', () => {
  it('merges each route’s descriptor with the profile’s constraints and digests it', () => {
    const catalog = new InMemoryModelCatalog([DEV_MODEL], profiles);
    const model = catalog.get(DEV_MODEL_ID);
    const route = model?.routes[0];

    expect(route?.id).toBe(DEV_ROUTE_ID);
    expect(route?.descriptor_digest).toBe(descriptorDigest(route!.descriptor));
    expect(checkRouteDescriptor(route!.descriptor)).toEqual([]);
    expect(catalog.list().map((m) => m.id)).toEqual([DEV_MODEL_ID]);
    expect(catalog.get('mdl_nope')).toBeUndefined();
  });

  it('removes a mode the profile does not support', () => {
    const catalog = new InMemoryModelCatalog(
      [{ ...DEV_MODEL, id: 'mdl_flux', family: 'flux1-dev' }],
      profiles,
    );
    expect(Object.keys(catalog.get('mdl_flux')!.routes[0]!.descriptor.modes)).toEqual(['txt2img']);
  });

  it('refuses an unknown profile and a repeated model', () => {
    expect(
      () => new InMemoryModelCatalog([{ ...DEV_MODEL, family: 'no-such-family' }], profiles),
    ).toThrow(/not loaded/);
    expect(() => new InMemoryModelCatalog([DEV_MODEL, DEV_MODEL], profiles)).toThrow(/twice/);
  });

  it('keeps what the merge noted, by route', () => {
    const catalog = new InMemoryModelCatalog([DEV_MODEL], profiles);
    expect(catalog.notes(DEV_MODEL_ID)?.has(DEV_ROUTE_ID)).toBe(true);
    expect(catalog.notes('mdl_nope')).toBeUndefined();
  });
});

describe('the development catalog', () => {
  it('describes a valid route', () => {
    expect(checkRouteDescriptor(DEV_ROUTE_DESCRIPTOR)).toEqual([]);
  });

  it('is served only with LANTERN_DEV=1', () => {
    expect(isDevMode({ LANTERN_DEV: '1' })).toBe(true);
    expect(isDevMode({ LANTERN_DEV: 'true' })).toBe(false);
    expect(isDevMode({})).toBe(false);
    expect(startupModelCatalog({ LANTERN_DEV: '1' }, profiles).list()).toHaveLength(1);
    expect(startupModelCatalog({}, profiles).list()).toEqual([]);
  });

  it('resolves a minimal request end to end', () => {
    const resolver = createResolver({ ajv: createValidator(), profiles, drawSeed: () => 7 });
    const model = startupModelCatalog({ LANTERN_DEV: '1' }, profiles).get(DEV_MODEL_ID)!;
    const outcome = resolver.resolve({
      request: {
        schema_version: 1,
        mode: 'txt2img',
        prompt: { positive: 'a lighthouse' },
        sampling: { seed: 'random' },
      },
      model,
    });
    expect(outcome.ok && outcome.resolution.effective).toEqual({
      schema_version: 1,
      mode: 'txt2img',
      prompt: { positive: 'a lighthouse' },
      geometry: { width: 1024, height: 1024 },
      sampling: { seed: 7, steps: 40, cfg: 7, sampler: 'euler_a', scheduler: 'discrete' },
      count: 1,
    });
  });
});
