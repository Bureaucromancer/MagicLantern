// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readLease } from './lease.js';
import { migrateAll } from './migrate.js';
import { INSTALL_SCHEMA_VERSION, LIBRARY_SCHEMA_VERSION, LIBRARY_STEPS } from './migrations.js';
import { dataPaths } from './paths.js';
import { vacuumInto, type SnapshotOutcome, type SnapshotTask } from './snapshot-worker.js';
import { collectingLog, removeDir, tempDir, testBoot, withDatabase } from './test-store.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await tempDir('migrate');
});

afterEach(async () => {
  await removeDir(dataDir);
});

describe('migrateAll', () => {
  it('sets up a new data directory the way a first start would, then closes everything', async () => {
    const report = await migrateAll(dataDir, { boot: testBoot(), log: collectingLog() });

    expect(report.install).toEqual({ from: 0, to: INSTALL_SCHEMA_VERSION, snapshot: null });
    expect(report.libraries).toEqual([
      expect.objectContaining({
        name: 'Library',
        status: 'ok',
        schemaVersion: LIBRARY_SCHEMA_VERSION,
        migration: { from: 0, to: LIBRARY_SCHEMA_VERSION, snapshot: null },
      }),
    ]);
    // A clean close: no lease row for the next start to take over.
    expect(withDatabase(dataPaths(dataDir).installDb, (db) => readLease(db), true)).toBeNull();
  });

  it('reports everything up to date the second time', async () => {
    await migrateAll(dataDir, { boot: testBoot(), log: collectingLog() });
    const report = await migrateAll(dataDir, { boot: testBoot(), log: collectingLog() });
    expect(report.install).toEqual({
      from: INSTALL_SCHEMA_VERSION,
      to: INSTALL_SCHEMA_VERSION,
      snapshot: null,
    });
    expect(report.libraries.map((library) => library.migration)).toEqual([
      { from: LIBRARY_SCHEMA_VERSION, to: LIBRARY_SCHEMA_VERSION, snapshot: null },
    ]);
  });

  it('keeps the lease fresh while a library is snapshotted, and leaves no row behind', async () => {
    await migrateAll(dataDir, { boot: testBoot(), log: collectingLog() });
    const installDb = dataPaths(dataDir).installDb;
    const heartbeatAt = (): number =>
      withDatabase(installDb, (db) => readLease(db)?.heartbeatAt ?? Number.NaN, true);

    // A slow snapshot: what the lease row says while it is in flight.
    const seen: number[] = [];
    const run = async (task: SnapshotTask): Promise<SnapshotOutcome> => {
      seen.push(heartbeatAt());
      await delay(150);
      seen.push(heartbeatAt());
      return vacuumInto(task);
    };
    const report = await migrateAll(
      dataDir,
      { boot: testBoot(), log: collectingLog() },
      {
        heartbeatMs: 10,
        libraries: {
          steps: [...LIBRARY_STEPS, { sql: 'create table later (id text primary key) strict;' }],
          seams: { run },
        },
      },
    );

    expect(report.libraries.map((library) => library.migration?.to)).toEqual([
      LIBRARY_SCHEMA_VERSION + 1,
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThan(seen[0] ?? Number.POSITIVE_INFINITY);
    expect(withDatabase(installDb, (db) => readLease(db), true)).toBeNull();
  });
});
