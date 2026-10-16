// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { GenerationRequest } from '@bureaucromancer/lantern-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../ids.js';
import { spoolPath } from './asset-files.js';
import { openInstall } from './install.js';
import { openLibraries } from './libraries.js';
import type { JobStore } from './library-types.js';
import { libraryPaths, type LibraryPaths } from './paths.js';
import { collectingLog, removeDir, tempDir, testBoot } from './test-store.js';
import { makePng } from './test-images.js';
import type { InstallStore, LibraryRegistry } from './types.js';

let dataDir: string;
let install: InstallStore;
let registry: LibraryRegistry;
let store: JobStore;
let paths: LibraryPaths;

const REQUEST: GenerationRequest = {
  schema_version: 1,
  mode: 'txt2img',
  prompt: { positive: 'a moth' },
  sampling: { seed: 3 },
};

beforeEach(async () => {
  dataDir = await tempDir('jobs');
  install = (await openInstall(dataDir, { boot: testBoot(), log: collectingLog() })).store;
  registry = (await openLibraries(install, dataDir, { log: collectingLog() })).registry;
  const record = registry.list()[0]!;
  store = registry.jobs(record.id)!;
  paths = libraryPaths(dataDir, record.path);
});

afterEach(async () => {
  registry.close();
  install.close();
  await removeDir(dataDir);
});

function queued(): string {
  const id = newId('job');
  store.insertQueued({
    id,
    modelId: 'm',
    routeId: 'rt',
    canonical: REQUEST,
    effective: REQUEST,
    fieldReport: { '/sampling/seed': { state: 'native' } },
    createdAt: Date.now(),
  });
  return id;
}

describe('transition', () => {
  it('moves a job only from the states named, with its payloads in the same write', () => {
    const id = queued();
    const moved = store.transition(id, ['queued'], { state: 'submitting', wire: { seed: 3 } });
    expect(moved?.state).toBe('submitting');
    expect(store.payloads(id)?.wire).toEqual({ seed: 3 });
    // Another change got there first: nothing happens, and the caller learns it.
    expect(
      store.transition(id, ['queued'], { state: 'finished', outcome: 'cancelled' }),
    ).toBeUndefined();
    expect(store.getJob(id)?.state).toBe('submitting');
  });

  it('clears a column with null and leaves absent ones alone', () => {
    const id = queued();
    store.transition(id, ['queued'], { blockedReason: { code: 'routes_down' } });
    store.transition(id, ['queued'], { priority: 4 });
    expect(store.getJob(id)).toMatchObject({ blockedReason: { code: 'routes_down' }, priority: 4 });
    store.transition(id, ['queued'], { blockedReason: null });
    expect(store.getJob(id)?.blockedReason).toBeNull();
  });

  it('finds a job by its idempotency key', () => {
    const id = newId('job');
    store.insertQueued({ id, modelId: 'm', canonical: REQUEST, createdAt: 1, idempotencyKey: 'k' });
    expect(store.findByIdempotencyKey(null, 'k')?.id).toBe(id);
    expect(store.findByIdempotencyKey('client', 'k')).toBeUndefined();
  });
});

describe('the spool (A17)', () => {
  const result = () => ({
    outputs: [
      { index: 0, seed: 3, bytes: makePng(4, 4, { seed: 1 }) },
      { index: 1, seed: 4, bytes: makePng(4, 4, { seed: 2 }) },
    ],
    metadata: { generator: 'x' },
    generator: 'x 1',
    finishedAt: 123,
  });

  it('round-trips a whole result', async () => {
    const id = queued();
    await store.spool(id, result());
    expect(await store.spooledJobs()).toEqual([id]);
    const read = await store.readSpool(id);
    expect(read?.outputs.map((output) => [output.index, output.seed, output.bytes.length])).toEqual(
      result().outputs.map((output) => [output.index, output.seed, output.bytes.length]),
    );
    expect(read).toMatchObject({ metadata: { generator: 'x' }, generator: 'x 1', finishedAt: 123 });
    await store.clearSpool(id);
    expect(await store.spooledJobs()).toEqual([]);
  });

  it('does not count a spool cut off before result.json, or one whose bytes changed', async () => {
    const id = queued();
    await store.spool(id, result());
    const directory = spoolPath(paths, id);
    await writeFile(join(directory, 'output-1.bin'), 'truncated');
    expect(await store.readSpool(id)).toBeNull();
    await rm(join(directory, 'result.json'));
    expect(await store.spooledJobs()).toEqual([]);
    expect(await readdir(directory)).toContain('output-0.bin');
  });
});
