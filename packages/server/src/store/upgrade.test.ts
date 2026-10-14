// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { existsSync } from 'node:fs';
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, DatabaseTooNewError, runMigrations, type MigrationStep } from './db.js';
import { StoreError } from './errors.js';
import { SNAPSHOTS_KEPT } from './snapshot.js';
import { collectingLog, removeDir, tempDir, userVersionOf, withDatabase } from './test-store.js';
import {
  DatabaseNotWritableError,
  MigrationFailedError,
  needsSnapshot,
  openAndMigrate,
} from './upgrade.js';

const STEPS: MigrationStep[] = [
  { sql: 'create table item (id text primary key, label text not null) strict;' },
  { sql: "alter table item add column note text not null default '';" },
];

let root: string;
let path: string;

beforeEach(async () => {
  root = await tempDir('upgrade');
  path = join(root, 'library.db');
});

afterEach(async () => {
  await chmod(root, 0o700);
  await removeDir(root);
});

/** Root ignores permission bits, so a read-only file would be writable after all. */
const permissionsBind = process.platform !== 'win32' && process.getuid?.() !== 0;

/** A file as an older build left it: the first `version` steps and one row. */
function fileAtVersion(version: number): void {
  withDatabase(path, (db) => {
    db.exec('pragma journal_mode = wal');
    runMigrations(db, STEPS.slice(0, version));
    db.exec("insert into item (id, label) values ('a', 'kept')");
  });
}

function request(from: number, steps: readonly MigrationStep[] = STEPS) {
  return {
    path,
    from,
    steps,
    backupsDir: join(root, 'backups'),
    stem: 'library',
    label: 'the test library',
    log: collectingLog(),
  };
}

describe('needsSnapshot', () => {
  it('is only for an existing file with steps pending', () => {
    expect(needsSnapshot(0, 2)).toBe(false);
    expect(needsSnapshot(1, 2)).toBe(true);
    expect(needsSnapshot(2, 2)).toBe(false);
  });
});

describe('openAndMigrate', () => {
  it('creates a new file without a snapshot', async () => {
    const { db, migration } = await openAndMigrate(request(0));
    closeDatabase(db);
    expect(migration).toEqual({ from: 0, to: 2, snapshot: null });
    expect(existsSync(join(root, 'backups'))).toBe(false);
  });

  it('snapshots an existing file at the old version before migrating it', async () => {
    fileAtVersion(1);
    const log = collectingLog();
    const { db, migration } = await openAndMigrate({ ...request(1), log });
    closeDatabase(db);

    expect(migration.from).toBe(1);
    expect(migration.to).toBe(2);
    expect(migration.snapshot).toMatch(/[/\\]backups[/\\]library\.v1\.[0-9A-Z]{26}\.db$/);
    const snapshot = migration.snapshot ?? '';
    expect(userVersionOf(snapshot)).toBe(1);
    expect(userVersionOf(path)).toBe(2);
    expect(
      withDatabase(
        path,
        (handle) => handle.prepare('select id, label, note from item').all(),
        true,
      ),
    ).toEqual([{ id: 'a', label: 'kept', note: '' }]);
    expect(log.lines.map((line) => line.message)).toEqual([
      'Took a snapshot of the test library before migrating it.',
      'Migrated the test library.',
    ]);
  });

  it('does nothing extra for a file that is up to date', async () => {
    fileAtVersion(2);
    const log = collectingLog();
    const { db, migration } = await openAndMigrate({ ...request(2), log });
    closeDatabase(db);
    expect(migration).toEqual({ from: 2, to: 2, snapshot: null });
    expect(log.lines).toEqual([]);
  });

  it('reports a failed step with the snapshot to go back to, leaving the last whole version', async () => {
    fileAtVersion(1);
    const broken = [STEPS[0]!, { sql: 'alter table nowhere add column x text;' }];
    const failure = await openAndMigrate(request(1, broken)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MigrationFailedError);
    const { snapshot, message } = failure as MigrationFailedError;
    expect(snapshot).not.toBeNull();
    expect(message).toContain(snapshot ?? '');
    expect(userVersionOf(path)).toBe(1);
    expect(await readdir(join(root, 'backups'))).toHaveLength(1);
  });

  it('does not migrate when the snapshot cannot be taken', async () => {
    fileAtVersion(1);
    const attempt = openAndMigrate({
      ...request(1),
      seams: { freeBytes: () => Promise.resolve(0) },
    });
    await expect(attempt).rejects.toThrow(StoreError);
    expect(userVersionOf(path)).toBe(1);
  });

  it('passes a newer file’s refusal through unchanged', async () => {
    fileAtVersion(2);
    await expect(openAndMigrate(request(1, STEPS.slice(0, 1)))).rejects.toThrow(
      DatabaseTooNewError,
    );
  });

  it('keeps the snapshot from before an upgrade that keeps failing part way, however often it is retried', async () => {
    fileAtVersion(1);
    // 1 → 2 commits, 2 → 3 fails: every attempt after the first starts from 2.
    const failsLast = [...STEPS, { sql: 'alter table nowhere add column x text;' }];
    const first = await openAndMigrate(request(1, failsLast)).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(MigrationFailedError);
    expect(userVersionOf(path)).toBe(2);
    const before = (first as MigrationFailedError).snapshot ?? '';
    expect(userVersionOf(before)).toBe(1);

    for (let attempt = 0; attempt < SNAPSHOTS_KEPT; attempt += 1) {
      await expect(openAndMigrate(request(userVersionOf(path), failsLast))).rejects.toThrow(
        MigrationFailedError,
      );
    }
    // The only copy from before step 1 → 2 changed anything, named by the first refusal.
    expect(existsSync(before)).toBe(true);
    expect((await readdir(join(root, 'backups'))).length).toBeLessThanOrEqual(SNAPSHOTS_KEPT);
  });
});

describe.skipIf(!permissionsBind)('openAndMigrate on files this process cannot write', () => {
  it('refuses a read-only database before opening it, leaving nothing beside it', async () => {
    fileAtVersion(2);
    const bytes = await readFile(path);
    await chmod(path, 0o444);
    const attempt = openAndMigrate(request(2));
    await expect(attempt).rejects.toThrow(DatabaseNotWritableError);
    await expect(attempt).rejects.toThrow(`EACCES on ${path})`);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
  });

  it('refuses before taking a snapshot it could not use', async () => {
    fileAtVersion(1);
    await chmod(path, 0o444);
    await expect(openAndMigrate(request(1))).rejects.toThrow(DatabaseNotWritableError);
    expect(existsSync(join(root, 'backups'))).toBe(false);
    expect(userVersionOf(path)).toBe(1);
  });

  it('refuses a -shm left read-only by an earlier attempt, naming it', async () => {
    fileAtVersion(2);
    // What a read-only open leaves behind: SQLite makes -wal and -shm with the database's mode.
    const shm = `${path}-shm`;
    await writeFile(shm, '');
    await chmod(shm, 0o444);
    await expect(openAndMigrate(request(2))).rejects.toThrow(`EACCES on ${shm})`);
  });

  it('refuses a folder it cannot write, where -wal and -shm are made', async () => {
    fileAtVersion(2);
    await chmod(root, 0o500);
    await expect(openAndMigrate(request(2))).rejects.toThrow(DatabaseNotWritableError);
  });
});
