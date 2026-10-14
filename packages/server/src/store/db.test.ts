// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BUSY_TIMEOUT_MS,
  canWrite,
  closeDatabase,
  DatabaseTooNewError,
  inTransaction,
  minReaderFor,
  openDatabase,
  openToProbe,
  readUserVersion,
  runMigrations,
  SqliteCode,
  sqlitePrimaryCode,
  type MigrationStep,
} from './db.js';
import { removeDir, tempDir } from './test-store.js';

let root: string;
const open: DatabaseSync[] = [];

/** Opens through the code under test and closes whatever the test leaves open. */
function db(name = 'test.db', readOnly = false): DatabaseSync {
  const handle = openDatabase(join(root, name), { readOnly });
  open.push(handle);
  return handle;
}

/** A pragma's value; the column is not always named after it (busy_timeout answers `timeout`). */
function pragma(handle: DatabaseSync, name: string): unknown {
  const row = handle.prepare(`pragma ${name}`).get();
  return row === undefined ? undefined : Object.values(row)[0];
}

function tables(handle: DatabaseSync): string[] {
  return handle
    .prepare("select name from sqlite_schema where type = 'table' order by name")
    .all()
    .map((row) => String(row['name']));
}

beforeEach(async () => {
  root = await tempDir('db');
});

afterEach(async () => {
  for (const handle of open.splice(0)) closeDatabase(handle);
  await removeDir(root);
});

describe('openDatabase', () => {
  it('states every pragma explicitly on a file', () => {
    const handle = db();
    expect(pragma(handle, 'journal_mode')).toBe('wal');
    expect(pragma(handle, 'foreign_keys')).toBe(1);
    expect(pragma(handle, 'busy_timeout')).toBe(BUSY_TIMEOUT_MS);
    // NORMAL is 1.
    expect(pragma(handle, 'synchronous')).toBe(1);
  });

  it('opens read-only without writing, and never creates a missing file', () => {
    expect(() => db('missing.db', true)).toThrow();
    expect(existsSync(join(root, 'missing.db'))).toBe(false);

    const writer = db();
    writer.exec('create table t (x integer) strict');
    const reader = db('test.db', true);
    expect(pragma(reader, 'busy_timeout')).toBe(BUSY_TIMEOUT_MS);
    expect(() => {
      reader.exec('insert into t values (1)');
    }).toThrow(/readonly/i);
  });

  it('closes the handle and rethrows when a pragma fails on a file that is not a database', async () => {
    const path = join(root, 'not-a-db.db');
    await writeFile(
      path,
      'this is plainly not an SQLite file, and it is long enough to have a header',
    );
    let failure: unknown;
    try {
      openDatabase(path);
    } catch (error) {
      failure = error;
    }
    expect(sqlitePrimaryCode(failure)).toBe(SqliteCode.notADatabase);
  });
});

describe('closeDatabase', () => {
  it('is idempotent, where node:sqlite throws on a second close', () => {
    const handle = openDatabase(join(root, 'test.db'));
    closeDatabase(handle);
    expect(() => {
      closeDatabase(handle);
    }).not.toThrow();
  });
});

describe('inTransaction', () => {
  it('commits and returns the body’s value', () => {
    const handle = db();
    handle.exec('create table t (x integer) strict');
    const value = inTransaction(handle, () => {
      handle.exec('insert into t values (1)');
      return 'done';
    });
    expect(value).toBe('done');
    expect(handle.prepare('select count(*) as n from t').get()?.['n']).toBe(1);
  });

  it('rolls everything back when the body throws, and rethrows', () => {
    const handle = db();
    handle.exec('create table t (x integer) strict');
    expect(() =>
      inTransaction(handle, () => {
        handle.exec('insert into t values (1)');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(handle.prepare('select count(*) as n from t').get()?.['n']).toBe(0);
    expect(handle.isTransaction).toBe(false);
  });

  it('takes the write lock up front (begin immediate)', () => {
    const first = db();
    first.exec('create table t (x integer) strict');
    const second = db();
    second.exec('pragma busy_timeout = 0');
    inTransaction(first, () => {
      // Without having written anything, `first` already blocks other writers.
      expect(() => {
        second.exec('begin immediate');
      }).toThrow(/locked|busy/i);
    });
  });

  it('refuses to nest', () => {
    const handle = db();
    expect(() => {
      inTransaction(handle, () => {
        inTransaction(handle, () => undefined);
      });
    }).toThrow(/nested/);
    expect(handle.isTransaction).toBe(false);
  });
});

describe('canWrite', () => {
  it('answers true for a handle that can write, and writes nothing to find out', () => {
    const handle = db();
    handle.exec('create table item (id text primary key) strict; pragma user_version = 3');
    // data_version changes when another connection commits.
    const watcher = db();
    const dataVersion = () => watcher.prepare('pragma data_version').get()?.['data_version'];
    const before = dataVersion();
    expect(canWrite(handle)).toBe(true);
    expect(handle.isTransaction).toBe(false);
    expect(readUserVersion(handle)).toBe(3);
    expect(dataVersion()).toBe(before);
  });

  it('answers false for a handle SQLite opened read-only, leaving no transaction open', () => {
    db().exec('create table item (id text primary key) strict');
    const handle = db('test.db', true);
    expect(canWrite(handle)).toBe(false);
    expect(handle.isTransaction).toBe(false);
  });
});

describe('openToProbe', () => {
  it('reads a WAL database that was closed cleanly without creating -wal or -shm beside it', () => {
    const path = join(root, 'test.db');
    const writer = openDatabase(path);
    writer.exec('create table item (id text) strict; pragma user_version = 4');
    closeDatabase(writer);
    expect(existsSync(`${path}-wal`)).toBe(false);

    const probe = openToProbe(path);
    open.push(probe);
    expect(readUserVersion(probe)).toBe(4);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });

  it('sees commits still only in the log while another connection has the file open', () => {
    const writer = db();
    writer.exec('pragma wal_autocheckpoint = 0');
    writer.exec('create table item (id text) strict; pragma user_version = 5');
    const probe = openToProbe(join(root, 'test.db'));
    open.push(probe);
    expect(readUserVersion(probe)).toBe(5);
  });
});

describe('runMigrations', () => {
  const steps: MigrationStep[] = [
    { sql: 'create table a (id text primary key, value text not null) strict;' },
    { sql: 'create table b (id text primary key) strict;' },
    { sql: "alter table a add column extra text not null default 'x';" },
  ];

  it('takes a new file from 0 to the last step, one version per step', () => {
    const handle = db();
    expect(runMigrations(handle, steps)).toEqual({ from: 0, to: 3 });
    expect(readUserVersion(handle)).toBe(3);
    expect(tables(handle)).toEqual(['a', 'b']);
  });

  it('applies only the pending steps and keeps the rows', () => {
    const handle = db();
    runMigrations(handle, steps.slice(0, 1));
    handle.exec("insert into a (id, value) values ('one', 'kept')");

    expect(runMigrations(handle, steps)).toEqual({ from: 1, to: 3 });
    expect(handle.prepare('select id, value, extra from a').all()).toEqual([
      { id: 'one', value: 'kept', extra: 'x' },
    ]);
  });

  it('is a no-op at the current version', () => {
    const handle = db();
    runMigrations(handle, steps);
    expect(runMigrations(handle, steps)).toEqual({ from: 3, to: 3 });
  });

  it('refuses a database newer than its steps and changes nothing', () => {
    const handle = db();
    runMigrations(handle, steps);
    expect(() => runMigrations(handle, steps.slice(0, 2))).toThrow(DatabaseTooNewError);
    expect(readUserVersion(handle)).toBe(3);
  });

  it('leaves a whole version when a step fails: earlier steps stay, the failed one rolls back', () => {
    const handle = db();
    const broken: MigrationStep[] = [
      steps[0]!,
      { sql: 'create table c (id text primary key) strict; insert into nowhere values (1);' },
    ];
    expect(() => runMigrations(handle, broken)).toThrow(/no such table/);
    expect(readUserVersion(handle)).toBe(1);
    expect(tables(handle)).toEqual(['a']);
    expect(handle.isTransaction).toBe(false);
  });

  it('runs a hook inside each step’s transaction with the version it produces', () => {
    const handle = db();
    handle.exec('create table log (version integer not null) strict');
    const seen: number[] = [];
    runMigrations(handle, steps, {
      afterStep: (inside, version) => {
        expect(inside.isTransaction).toBe(true);
        seen.push(version);
        inside.prepare('insert into log values (?)').run(version);
      },
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(handle.prepare('select count(*) as n from log').get()?.['n']).toBe(3);
  });

  describe('a table rebuild under foreign keys', () => {
    const parentAndChild: MigrationStep = {
      sql: `
create table parent (id text primary key, label text not null) strict;
create table child (
  id text primary key,
  parent_id text not null references parent (id) on delete cascade
) strict;
`,
    };
    const rebuildParent = `
create table parent_new (id text primary key, label text not null, added text) strict;
insert into parent_new (id, label) select id, label from parent;
drop table parent;
alter table parent_new rename to parent;
`;

    function seeded(): DatabaseSync {
      const handle = db();
      runMigrations(handle, [parentAndChild]);
      handle.exec("insert into parent values ('p', 'label')");
      handle.exec("insert into child values ('c', 'p')");
      return handle;
    }

    it('keeps the children when the step turns foreign keys off', () => {
      const handle = seeded();
      runMigrations(handle, [parentAndChild, { sql: rebuildParent, foreignKeysOff: true }]);
      expect(handle.prepare('select id, parent_id from child').all()).toEqual([
        { id: 'c', parent_id: 'p' },
      ]);
      expect(pragma(handle, 'foreign_keys')).toBe(1);
    });

    it('would lose them to the cascade otherwise, which is why the flag exists', () => {
      const handle = seeded();
      runMigrations(handle, [parentAndChild, { sql: rebuildParent }]);
      expect(handle.prepare('select count(*) as n from child').get()?.['n']).toBe(0);
    });

    it('rolls back a rebuild that leaves a broken reference, and turns foreign keys back on', () => {
      const handle = seeded();
      const dropsTheParentRow = `${rebuildParent}\ndelete from parent;`;
      expect(() =>
        runMigrations(handle, [parentAndChild, { sql: dropsTheParentRow, foreignKeysOff: true }]),
      ).toThrow(/foreign key violation/);
      expect(readUserVersion(handle)).toBe(1);
      expect(handle.prepare('select count(*) as n from parent').get()?.['n']).toBe(1);
      expect(pragma(handle, 'foreign_keys')).toBe(1);
    });
  });
});

describe('minReaderFor', () => {
  it('is the target of the last step that broke older readers, and at least 1', () => {
    const steps: MigrationStep[] = [
      { sql: '' },
      { sql: '' },
      { sql: '', breaksOlderReaders: true },
      { sql: '' },
    ];
    expect(minReaderFor([])).toBe(1);
    expect(minReaderFor(steps)).toBe(3);
    expect(minReaderFor(steps, 2)).toBe(1);
    expect(minReaderFor(steps, 3)).toBe(3);
  });
});
