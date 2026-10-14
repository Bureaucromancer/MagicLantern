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
    for (const table of tableNames(db)) expect(isStrict(db, table), table).toBe(true);
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
    expect(LIBRARY_SCHEMA_VERSION).toBe(1);
    expect(LIBRARY_MIN_READER).toBe(1);
    const db = storeAtVersion(LIBRARY_STEPS, 1);
    expect(tableNames(db)).toEqual(['meta']);
    expect(columns(db, 'meta')).toEqual([
      { name: 'key', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'value', type: 'TEXT', notnull: 1, pk: 0 },
    ]);
  });
});
