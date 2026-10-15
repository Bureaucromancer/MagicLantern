// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The shipped schemas. Every new step gets a test here written at the version
 * it leaves from (`storeAtVersion`), with real rows, asserting every column
 * carried over.
 */

import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { runMigrations, type MigrationStep } from './db.js';
import {
  INSTALL_SCHEMA_VERSION,
  INSTALL_STEPS,
  LIBRARY_MIN_READER,
  LIBRARY_SCHEMA_VERSION,
  LIBRARY_STEPS,
} from './migrations.js';

/** A database built by the first `version` steps, as an older build left it. */
function storeAtVersion(steps: readonly MigrationStep[], version: number): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, steps.slice(0, version));
  return db;
}

function tableNames(db: DatabaseSync): string[] {
  return db
    .prepare("select name from sqlite_schema where type = 'table' order by name")
    .all()
    .map((row) => String(row['name']));
}

function columns(
  db: DatabaseSync,
  table: string,
): { name: string; type: string; notnull: number; pk: number }[] {
  return db
    .prepare(`pragma table_info(${table})`)
    .all()
    .map((row) => ({
      name: String(row['name']),
      type: String(row['type']),
      notnull: Number(row['notnull']),
      pk: Number(row['pk']),
    }));
}

/** Ordinary tables: not FTS5's virtual table or the shadow tables behind it. */
function ordinaryTables(db: DatabaseSync): string[] {
  return db
    .prepare(
      "select name from pragma_table_list where schema = 'main' and type = 'table' and name not like 'sqlite_%' order by name",
    )
    .all()
    .map((row) => String(row['name']));
}

function isStrict(db: DatabaseSync, table: string): boolean {
  const row = db.prepare('select strict from pragma_table_list where name = ?').get(table);
  return row?.['strict'] === 1;
}

describe.each([
  ['install', INSTALL_STEPS],
  ['library', LIBRARY_STEPS],
] as const)('the %s steps', (_name, steps) => {
  it('never drop a table an earlier version had', () => {
    for (let version = 1; version <= steps.length; version += 1) {
      const before = tableNames(storeAtVersion(steps, version - 1));
      const after = tableNames(storeAtVersion(steps, version));
      expect(after, `step ${String(version)}`).toEqual(expect.arrayContaining(before));
    }
  });

  it('make only strict tables', () => {
    const db = storeAtVersion(steps, steps.length);
    for (const table of ordinaryTables(db)) expect(isStrict(db, table), table).toBe(true);
  });
});

describe('install schema version 1', () => {
  // In a strict table a primary key is implicitly not null, hence notnull 1 on the ids.
  it('has the library registry and the lease', () => {
    expect(INSTALL_SCHEMA_VERSION).toBe(1);
    const db = storeAtVersion(INSTALL_STEPS, 1);
    expect(tableNames(db)).toEqual(['lease', 'libraries']);
    expect(columns(db, 'libraries')).toEqual([
      { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'name', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'path', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'created_at', type: 'REAL', notnull: 1, pk: 0 },
      { name: 'last_opened_at', type: 'REAL', notnull: 0, pk: 0 },
    ]);
    expect(columns(db, 'lease').map((column) => column.name)).toEqual([
      'id',
      'pid',
      'process_id',
      'machine_boot_id',
      'hostname',
      'started_at',
      'heartbeat_at',
    ]);
  });

  it('holds one lease row at most, and one library per path', () => {
    const db = storeAtVersion(INSTALL_STEPS, 1);
    const lease = db.prepare("insert into lease values (?, 1, 'proc_a', 'boot', 'host', 0, 0)");
    lease.run(1);
    expect(() => lease.run(2)).toThrow(/CHECK constraint/);

    const library = db.prepare(
      "insert into libraries (id, name, path, created_at) values (?, 'Library', 'libraries/x', 0)",
    );
    library.run('lib_a');
    expect(() => library.run('lib_b')).toThrow(/UNIQUE constraint/);
  });
});

describe('library schema version 1', () => {
  it('has the meta table, readable by any build that knows version 1', () => {
    const db = storeAtVersion(LIBRARY_STEPS, 1);
    expect(tableNames(db)).toEqual(['meta']);
    expect(columns(db, 'meta')).toEqual([
      { name: 'key', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'value', type: 'TEXT', notnull: 1, pk: 0 },
    ]);
  });
});

describe('library schema version 2', () => {
  const asset = (id: string, extra = '') =>
    `insert into assets (id, media_type, bytes, origin, created_at${extra === '' ? '' : ', rating'})
     values ('${id}', 'image/png', 10, 'uploaded', 1${extra === '' ? '' : `, ${extra}`})`;

  it('adds jobs, payloads, assets, inputs, outputs and the prompt index, readable by version 1 builds', () => {
    expect(LIBRARY_SCHEMA_VERSION).toBe(2);
    expect(LIBRARY_MIN_READER).toBe(1);
    const db = storeAtVersion(LIBRARY_STEPS, 2);
    expect(ordinaryTables(db)).toEqual([
      'assets',
      'job_inputs',
      'job_outputs',
      'job_payloads',
      'job_prompts',
      'jobs',
      'meta',
    ]);
    expect(tableNames(db)).toContain('prompts_fts');
  });

  it("keeps version 1's rows", () => {
    const db = storeAtVersion(LIBRARY_STEPS, 1);
    db.prepare("insert into meta (key, value) values ('min_reader', '1')").run();
    runMigrations(db, LIBRARY_STEPS.slice(0, 2));
    expect(db.prepare('select key, value from meta').all()).toEqual([
      { key: 'min_reader', value: '1' },
    ]);
  });

  it('holds an asset id to a SHA-256 in hex, and a rating to 1 to 5', () => {
    const db = storeAtVersion(LIBRARY_STEPS, 2);
    db.exec(asset('a'.repeat(64)));
    expect(() => {
      db.exec(asset('A'.repeat(64)));
    }).toThrow(/CHECK/);
    expect(() => {
      db.exec(asset('a'.repeat(63)));
    }).toThrow(/CHECK/);
    expect(() => {
      db.exec(asset('b'.repeat(64), '0'));
    }).toThrow(/CHECK/);
    expect(() => {
      db.exec(asset('b'.repeat(64), '6'));
    }).toThrow(/CHECK/);
  });

  it('gives a job an outcome exactly when it is finished', () => {
    const db = storeAtVersion(LIBRARY_STEPS, 2);
    const job = db.prepare(
      'insert into jobs (id, state, outcome, model_id, created_at, updated_at) values (?, ?, ?, ?, 1, 1)',
    );
    job.run('j1', 'queued', null, 'm');
    job.run('j2', 'finished', 'done', 'm');
    expect(() => job.run('j3', 'finished', null, 'm')).toThrow(/CHECK/);
    expect(() => job.run('j4', 'running', 'done', 'm')).toThrow(/CHECK/);
    expect(() => job.run('j5', 'paused', null, 'm')).toThrow(/CHECK/);
  });

  it('takes one job per client and idempotency key, with no client counted as one client', () => {
    const db = storeAtVersion(LIBRARY_STEPS, 2);
    const job = db.prepare(
      "insert into jobs (id, state, model_id, idempotency_key, client_id, created_at, updated_at) values (?, 'queued', 'm', ?, ?, 1, 1)",
    );
    job.run('j1', 'k', null);
    expect(() => job.run('j2', 'k', null)).toThrow(/UNIQUE/);
    job.run('j3', 'k', 'client_a');
    job.run('j4', null, null);
    job.run('j5', null, null);
  });

  it('keeps the prompt index in step with job_prompts', () => {
    const db = storeAtVersion(LIBRARY_STEPS, 2);
    db.exec(
      "insert into jobs (id, state, model_id, created_at, updated_at) values ('j1', 'queued', 'm', 1, 1)",
    );
    db.exec("insert into job_prompts (job_id, positive) values ('j1', 'long_hair, red dress')");
    const count = (match: string) =>
      Number(
        db.prepare('select count(*) as n from prompts_fts where prompts_fts match ?').get(match)?.[
          'n'
        ],
      );
    expect(count('long_hair')).toBe(1);
    expect(count('long')).toBe(0);
    db.exec("update job_prompts set positive = 'short hair' where job_id = 'j1'");
    expect(count('long_hair')).toBe(0);
    expect(count('short')).toBe(1);
    db.exec("delete from jobs where id = 'j1'");
    expect(count('short')).toBe(0);
  });
});
