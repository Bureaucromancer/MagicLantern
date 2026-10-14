// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createUlidGenerator } from '../ids.js';
import { StoreError } from './errors.js';
import {
  pruneSnapshots,
  runInWorker,
  SnapshotError,
  SNAPSHOTS_KEPT,
  sweepPartialSnapshots,
  takeSnapshot,
} from './snapshot.js';
import { vacuumInto } from './snapshot-worker.js';
import { removeDir, tempDir, userVersionOf, withDatabase } from './test-store.js';

let root: string;
let source: string;
let backups: string;
const open: DatabaseSync[] = [];

const SNAPSHOT_NAME = /^library\.v1\.[0-7][0-9A-HJKMNP-TV-Z]{25}\.db$/;

/** A WAL database at user_version 1 whose last commit is still only in the log. */
function liveDatabase(): DatabaseSync {
  const db = new DatabaseSync(source);
  open.push(db);
  db.exec('pragma journal_mode = wal');
  db.exec('pragma wal_autocheckpoint = 0');
  db.exec('create table item (id text primary key) strict');
  db.exec('pragma user_version = 1');
  db.exec("insert into item values ('checkpointed')");
  db.exec('pragma wal_checkpoint(truncate)');
  db.exec("insert into item values ('in the log')");
  return db;
}

function idsIn(path: string): string[] {
  return withDatabase(
    path,
    (db) =>
      db
        .prepare('select id from item order by id')
        .all()
        .map((row) => String(row['id'])),
    true,
  );
}

beforeEach(async () => {
  root = await tempDir('snapshot');
  source = join(root, 'library.db');
  backups = join(root, 'backups');
});

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  await removeDir(root);
});

describe('takeSnapshot', () => {
  it('copies committed rows, including frames still in the log, on a worker thread', async () => {
    liveDatabase();
    const path = await takeSnapshot({
      source,
      backupsDir: backups,
      stem: 'library',
      fromVersion: 1,
    });

    expect(basename(path)).toMatch(SNAPSHOT_NAME);
    expect(idsIn(path)).toEqual(['checkpointed', 'in the log']);
    expect(userVersionOf(path)).toBe(1);
    // VACUUM INTO writes a rollback-journal file; nothing else is left beside it.
    expect(await readdir(backups)).toEqual([basename(path)]);
  });

  it('leaves out a transaction that is still open elsewhere', async () => {
    const writer = liveDatabase();
    writer.exec('begin');
    writer.exec("insert into item values ('uncommitted')");
    const path = await takeSnapshot({
      source,
      backupsDir: backups,
      stem: 'library',
      fromVersion: 1,
    });
    writer.exec('rollback');
    expect(idsIn(path)).toEqual(['checkpointed', 'in the log']);
  });

  it(`keeps the newest copy of each of the newest ${String(SNAPSHOTS_KEPT)} versions of a stem, touching nothing else`, async () => {
    liveDatabase();
    await mkdir(backups, { recursive: true });
    await writeFile(join(backups, 'notes.txt'), 'mine');
    const other = await takeSnapshot({
      source,
      backupsDir: backups,
      stem: 'lantern',
      fromVersion: 1,
    });

    const taken: string[] = [];
    for (let version = 1; version <= 5; version += 1) {
      taken.push(
        await takeSnapshot({ source, backupsDir: backups, stem: 'library', fromVersion: version }),
      );
    }
    expect((await readdir(backups)).sort()).toEqual(
      [
        basename(other),
        'notes.txt',
        ...taken.slice(-SNAPSHOTS_KEPT).map((path) => basename(path)),
      ].sort(),
    );
  });

  it('replaces an earlier copy of the same version, keeping the older versions’', async () => {
    liveDatabase();
    const request = { source, backupsDir: backups, stem: 'library' };
    const before = await takeSnapshot({ ...request, fromVersion: 1 });
    // An upgrade that stopped at 2 and is retried: each attempt snapshots 2 again.
    const retries: string[] = [];
    for (let attempt = 0; attempt < SNAPSHOTS_KEPT + 1; attempt += 1) {
      retries.push(await takeSnapshot({ ...request, fromVersion: 2 }));
    }
    expect((await readdir(backups)).sort()).toEqual(
      [basename(before), basename(retries.at(-1) ?? '')].sort(),
    );
  });

  describe('when earlier snapshots carry ids from a clock that ran ahead', () => {
    const inAnHour = Date.now() + 60 * 60 * 1000;

    async function seedFuture(versions: readonly number[]): Promise<string[]> {
      await mkdir(backups, { recursive: true });
      const next = createUlidGenerator();
      const names = versions.map(
        (version, index) => `library.v${String(version)}.${next(inAnHour + index)}.db`,
      );
      for (const name of names) await writeFile(join(backups, name), '');
      return names;
    }

    it('keeps the one just taken, with the newest of the others', async () => {
      liveDatabase();
      const future = await seedFuture([1, 2, 3]);
      const path = await takeSnapshot({
        source,
        backupsDir: backups,
        stem: 'library',
        fromVersion: 4,
      });
      expect(existsSync(path)).toBe(true);
      expect((await readdir(backups)).sort()).toEqual(
        [basename(path), future[1], future[2]].sort(),
      );
    });

    it('keeps the one just taken over future-dated copies of its own version', async () => {
      liveDatabase();
      await seedFuture([1, 1, 1]);
      const path = await takeSnapshot({
        source,
        backupsDir: backups,
        stem: 'library',
        fromVersion: 1,
      });
      expect(existsSync(path)).toBe(true);
      expect(idsIn(path)).toEqual(['checkpointed', 'in the log']);
      expect(await readdir(backups)).toEqual([basename(path)]);
    });
  });

  it('refuses when the disk is short of room, writing nothing', async () => {
    liveDatabase();
    const attempt = takeSnapshot(
      { source, backupsDir: backups, stem: 'library', fromVersion: 1 },
      { freeBytes: () => Promise.resolve(1024) },
    );
    await expect(attempt).rejects.toThrow(StoreError);
    await expect(attempt).rejects.toMatchObject({
      kind: 'no-room',
      message: expect.stringMatching(/^Not enough free space/),
    });
    expect(await readdir(backups)).toEqual([]);
  });

  it('goes ahead when the filesystem will not say how much room it has', async () => {
    liveDatabase();
    const path = await takeSnapshot(
      { source, backupsDir: backups, stem: 'library', fromVersion: 1 },
      { freeBytes: () => Promise.resolve(null) },
    );
    expect(existsSync(path)).toBe(true);
  });

  it('turns a SQLite failure into a refusal and leaves no partial file', async () => {
    const attempt = takeSnapshot({
      source: join(root, 'missing.db'),
      backupsDir: backups,
      stem: 'library',
      fromVersion: 1,
    });
    await expect(attempt).rejects.toThrow(SnapshotError);
    await expect(attempt).rejects.toMatchObject({
      kind: 'failed',
      message: expect.stringMatching(/^Could not snapshot/),
    });
    expect(await readdir(backups)).toEqual([]);
  });
});

describe('pruneSnapshots', () => {
  it('orders by the id in the name, not the name: v10 is newer than v2 when taken later', async () => {
    await mkdir(backups, { recursive: true });
    const next = createUlidGenerator();
    const names = [
      `library.v2.${next(1_000)}.db`,
      `library.v10.${next(2_000)}.db`,
      `library.v3.${next(3_000)}.db`,
    ];
    for (const name of names) await writeFile(join(backups, name), '');

    const removed = await pruneSnapshots(backups, 'library', 2);
    expect(removed.map((path) => basename(path))).toEqual([names[0]]);
    expect((await readdir(backups)).sort()).toEqual([names[1], names[2]].sort());
  });
});

describe('pruneSnapshots, per version', () => {
  it('keeps the newest of each version, then the newest versions, and what it is told to protect', async () => {
    await mkdir(backups, { recursive: true });
    const next = createUlidGenerator();
    const [v1, v2a, v2b, v3, v4] = [
      `library.v1.${next(1_000)}.db`,
      `library.v2.${next(2_000)}.db`,
      `library.v2.${next(3_000)}.db`,
      `library.v3.${next(4_000)}.db`,
      `library.v4.${next(5_000)}.db`,
    ];
    const names = [v1, v2a, v2b, v3, v4];
    for (const name of names) await writeFile(join(backups, name), '');

    await pruneSnapshots(backups, 'library', 3, v1);
    expect((await readdir(backups)).sort()).toEqual([v1, v3, v4].sort());
  });
});

describe('sweepPartialSnapshots', () => {
  it('removes only the partial files a snapshot leaves when killed', async () => {
    await mkdir(backups, { recursive: true });
    const id = createUlidGenerator()(1_000);
    const leftovers = [`library.v1.${id}.db.part`, `lantern.v1.${id}.db.part-journal`];
    const kept = [`library.v1.${id}.db`, 'notes.part', 'library.db.part'];
    for (const name of [...leftovers, ...kept]) await writeFile(join(backups, name), '');

    expect(await sweepPartialSnapshots(backups)).toBe(2);
    expect((await readdir(backups)).sort()).toEqual([...kept].sort());
  });

  it('is content with a backups folder that does not exist yet', async () => {
    expect(await sweepPartialSnapshots(join(root, 'nowhere'))).toBe(0);
  });
});

describe('runInWorker', () => {
  async function script(name: string, body: string): Promise<URL> {
    const path = join(root, name);
    await writeFile(path, body);
    return pathToFileURL(path);
  }

  it('rejects when the worker cannot load', async () => {
    const url = await script('throws.mjs', "throw new Error('cannot load');");
    await expect(runInWorker({ source, target: join(root, 'x.db') }, url)).rejects.toThrow(
      'cannot load',
    );
  });

  it('rejects when the worker exits without answering', async () => {
    const url = await script('silent.mjs', '');
    await expect(runInWorker({ source, target: join(root, 'x.db') }, url)).rejects.toThrow(
      /without answering/,
    );
  });
});

describe('vacuumInto', () => {
  it('reports SQLite’s refusal rather than throwing (the target must not exist)', () => {
    liveDatabase();
    // An empty file counts as an empty database SQLite may write into; one with content does not.
    const target = join(root, 'exists.db');
    withDatabase(target, (db) => {
      db.exec('create table taken (x integer) strict');
    });
    const outcome = vacuumInto({ source, target });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.message).toMatch(/already exists/);
  });
});
