// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { existsSync } from 'node:fs';
import { chmod, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { LIBRARY_ID_PATTERN } from '@bureaucromancer/lantern-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../ids.js';
import type { MigrationStep } from './db.js';
import { createLibrary, type LibraryOptions } from './library.js';
import { openInstall } from './install.js';
import { openLibraries, openLibraryRegistry, type OpenedLibraries } from './libraries.js';
import { LIBRARY_STEPS } from './migrations.js';
import { dataPaths, libraryPaths, libraryRelativePath } from './paths.js';
import {
  collectingLog,
  removeDir,
  tempDir,
  testBoot,
  userVersionOf,
  withDatabase,
  type LogLine,
} from './test-store.js';
import type { InstallStore, LibraryRecord } from './types.js';

let dataDir: string;
let install: InstallStore;
const registries: OpenedLibraries[] = [];

beforeEach(async () => {
  dataDir = await tempDir('libraries');
  install = (await openInstall(dataDir, { boot: testBoot(), log: collectingLog() })).store;
});

afterEach(async () => {
  for (const { registry } of registries.splice(0)) registry.close();
  install.close();
  await removeDir(dataDir);
});

async function open(options: LibraryOptions = {}): Promise<OpenedLibraries & { lines: LogLine[] }> {
  const log = collectingLog();
  const opened = await openLibraries(install, dataDir, { log }, options);
  registries.push(opened);
  return { ...opened, lines: log.lines };
}

/** Opens once to create the default library, closes, and answers its record and paths. */
async function defaultLibrary() {
  const { registry } = await open();
  registry.close();
  const record = registry.list()[0]!;
  return { record, paths: libraryPaths(dataDir, record.path) };
}

async function manifestOf(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

function messages(lines: readonly LogLine[]): string[] {
  return lines.map((line) => line.message);
}

function registerRow(id: string, path: string, createdAt: number): void {
  install.db
    .prepare('insert into libraries (id, name, path, created_at) values (?, ?, ?, ?)')
    .run(id, `Another ${id}`, path, createdAt);
}

describe('the default library', () => {
  it('is created on first start: "Library", lib_<ULID>, in libraries/<id>', async () => {
    const before = Date.now();
    const { registry, migrations } = await open();
    const libraries = registry.list();
    expect(libraries).toHaveLength(1);
    const [library] = libraries as [LibraryRecord];

    expect(library).toEqual({
      id: expect.stringMatching(new RegExp(LIBRARY_ID_PATTERN)),
      name: 'Library',
      path: `libraries/${library.id}`,
      status: 'ok',
      schemaVersion: LIBRARY_STEPS.length,
    });
    expect(registry.get(library.id)).toEqual(library);
    expect(migrations.get(library.id)).toEqual({ from: 0, to: 1, snapshot: null });

    const paths = libraryPaths(dataDir, library.path);
    expect(userVersionOf(paths.db)).toBe(1);
    expect(
      withDatabase(paths.db, (db) => db.prepare('select key, value from meta').all(), true),
    ).toEqual([{ key: 'min_reader', value: '1' }]);

    const manifest = (await manifestOf(paths.manifest)) as Record<string, unknown>;
    expect(manifest).toEqual({
      id: library.id,
      name: 'Library',
      schema: 1,
      min_reader: 1,
      created_at: expect.any(String),
    });
    expect(Date.parse(String(manifest['created_at']))).toBeGreaterThanOrEqual(before - 1);

    const row = install.db.prepare('select * from libraries').get();
    expect(row).toMatchObject({ id: library.id, name: 'Library', path: library.path });
    expect(row?.['last_opened_at']).toEqual(expect.any(Number));
  });

  it('is created once: a second start finds it and changes nothing', async () => {
    const { record, paths } = await defaultLibrary();
    const manifestBefore = await readFile(paths.manifest, 'utf8');

    const { registry, migrations, lines } = await open();
    expect(registry.list()).toEqual([record]);
    expect(migrations.get(record.id)).toEqual({ from: 1, to: 1, snapshot: null });
    expect(await readdir(dataPaths(dataDir).libraries)).toEqual([record.id]);
    expect(await readFile(paths.manifest, 'utf8')).toBe(manifestBefore);
    expect(lines).toEqual([]);
  });

  it('leaves no folder behind when it cannot be registered', async () => {
    // An install database without the registry table: the insert fails after the files exist.
    const db = new DatabaseSync(join(dataDir, 'not-the-install.db'));
    const unregistrable: InstallStore = {
      db,
      schemaVersion: 1,
      heartbeat: () => undefined,
      close: () => undefined,
    };
    try {
      await expect(
        createLibrary(unregistrable, dataDir, { name: 'Doomed', log: collectingLog() }),
      ).rejects.toThrow(/no such table: libraries/);
    } finally {
      db.close();
    }
    expect(await readdir(dataPaths(dataDir).libraries)).toEqual([]);
  });

  it('is what openLibraryRegistry answers too', async () => {
    const registry = await openLibraryRegistry(install, dataDir, { log: collectingLog() });
    try {
      expect(registry.list().map((library) => library.name)).toEqual(['Library']);
    } finally {
      registry.close();
      registry.close();
    }
  });
});

describe('an empty registry over library folders already on disk', () => {
  /** The default library's folder, unregistered again: what a lost lantern.db leaves behind. */
  async function anUnregisteredLibrary() {
    const library = await defaultLibrary();
    install.db.prepare('delete from libraries').run();
    return library;
  }

  it('registers them as they are instead of creating a new default library', async () => {
    const { record, paths } = await anUnregisteredLibrary();
    const manifest = (await manifestOf(paths.manifest)) as Record<string, unknown>;
    await writeFile(paths.manifest, JSON.stringify({ ...manifest, name: 'Holiday' }));

    const { registry, migrations, lines } = await open();
    expect(registry.list()).toEqual([{ ...record, name: 'Holiday' }]);
    expect(migrations.get(record.id)).toEqual({ from: 1, to: 1, snapshot: null });
    expect(await readdir(dataPaths(dataDir).libraries)).toEqual([record.id]);
    expect(install.db.prepare('select id, name, path, created_at from libraries').all()).toEqual([
      {
        id: record.id,
        name: 'Holiday',
        path: record.path,
        created_at: Date.parse(String(manifest['created_at'])),
      },
    ]);
    expect(messages(lines)).toEqual(['Registered a library found in the data directory.']);
  });

  it('passes over a folder whose library.json does not name it, and creates the default', async () => {
    const { record, paths } = await anUnregisteredLibrary();
    const manifest = (await manifestOf(paths.manifest)) as Record<string, unknown>;
    await writeFile(paths.manifest, JSON.stringify({ ...manifest, id: newId('lib') }));

    const { registry, lines } = await open();
    const [created] = registry.list() as [LibraryRecord];
    expect(registry.list()).toHaveLength(1);
    expect(created.id).not.toBe(record.id);
    expect((await readdir(dataPaths(dataDir).libraries)).sort()).toEqual(
      [record.id, created.id].sort(),
    );
    expect(lines).toContainEqual({
      level: 'warn',
      message:
        'Left a library folder unregistered: it has no library.db, or its library.json does not name it.',
      fields: { path: record.path },
    });
  });

  it('passes over a folder with no library.db', async () => {
    const { record, paths } = await anUnregisteredLibrary();
    await rm(paths.db);

    const { registry } = await open();
    expect(registry.list().map((library) => library.id)).not.toContain(record.id);
    expect(registry.list()).toHaveLength(1);
  });
});

describe('library.json', () => {
  it('is rewritten when it has gone missing', async () => {
    const { record, paths } = await defaultLibrary();
    await rm(paths.manifest);
    const { lines } = await open();
    expect(await manifestOf(paths.manifest)).toMatchObject({ id: record.id, schema: 1 });
    expect(messages(lines)).toEqual(['Wrote a missing library.json.']);
  });

  it('is repaired when stale, keeping keys this build does not know', async () => {
    const { record, paths } = await defaultLibrary();
    const original = (await manifestOf(paths.manifest)) as Record<string, unknown>;
    await writeFile(
      paths.manifest,
      JSON.stringify({ ...original, name: 'Old name', schema: 0, note: 'kept' }),
    );

    const { lines } = await open();
    expect(await manifestOf(paths.manifest)).toEqual({ ...original, note: 'kept' });
    expect(lines).toContainEqual(
      expect.objectContaining({
        message: 'Repaired a stale library.json.',
        fields: { id: record.id, fields: ['name', 'schema'] },
      }),
    );
  });

  it('is rewritten when it is not JSON, taking created_at from the registry', async () => {
    const { record, paths } = await defaultLibrary();
    await writeFile(paths.manifest, '{ not json');
    await open();
    const createdAt = install.db.prepare('select created_at from libraries').get()?.['created_at'];
    expect(await manifestOf(paths.manifest)).toEqual({
      id: record.id,
      name: 'Library',
      schema: 1,
      min_reader: 1,
      created_at: new Date(Number(createdAt)).toISOString(),
    });
  });

  it('naming another library makes the folder unavailable, and nothing is written', async () => {
    const { record, paths } = await defaultLibrary();
    const stranger = newId('lib');
    const text = JSON.stringify({ id: stranger, name: 'Stranger', schema: 1, min_reader: 1 });
    await writeFile(paths.manifest, text);

    const { registry } = await open();
    expect(registry.get(record.id)).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining(stranger),
      schemaVersion: null,
    });
    expect(await readFile(paths.manifest, 'utf8')).toBe(text);
  });
});

describe('a library written by a newer build', () => {
  async function aheadOf(version: number, minReader: string | null) {
    const { record, paths } = await defaultLibrary();
    withDatabase(paths.db, (db) => {
      db.exec(`pragma user_version = ${String(version)}`);
      if (minReader === null) db.exec('delete from meta');
      else db.prepare("update meta set value = ? where key = 'min_reader'").run(minReader);
    });
    const manifest = {
      id: record.id,
      name: 'Library',
      schema: version,
      min_reader: 1,
      future: true,
    };
    await writeFile(paths.manifest, JSON.stringify(manifest));
    return { record, paths, manifestText: JSON.stringify(manifest) };
  }

  it('opens read-only when its min_reader is one this build knows, writing nothing', async () => {
    const { record, paths, manifestText } = await aheadOf(2, '1');
    const { registry, migrations } = await open();

    expect(registry.get(record.id)).toEqual({
      ...record,
      status: 'read-only',
      schemaVersion: 2,
      reason: expect.stringMatching(
        /newer Lantern \(library schema 2; this one knows 1\).*read-only/,
      ),
    });
    expect(migrations.get(record.id)).toBeNull();
    expect(userVersionOf(paths.db)).toBe(2);
    expect(await readFile(paths.manifest, 'utf8')).toBe(manifestText);
    expect(existsSync(paths.backups)).toBe(false);
  });

  it('is unavailable when it needs a newer reader', async () => {
    const { record, paths } = await aheadOf(3, '2');
    const { registry } = await open();
    expect(registry.get(record.id)).toMatchObject({
      status: 'unavailable',
      schemaVersion: null,
      reason: expect.stringContaining('knows schema 2 or later'),
    });
    expect(userVersionOf(paths.db)).toBe(3);
  });

  it('falls back to library.json’s min_reader when the database has none, if it describes that version', async () => {
    const { record } = await aheadOf(2, null);
    const { registry } = await open();
    expect(registry.get(record.id)?.status).toBe('read-only');
  });

  it('is unavailable when no min_reader can be found for its version', async () => {
    const { record, paths } = await aheadOf(2, null);
    await writeFile(paths.manifest, JSON.stringify({ id: record.id, schema: 1, min_reader: 1 }));
    const { registry } = await open();
    expect(registry.get(record.id)).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('not recorded'),
    });
  });
});

describe('a library that cannot be opened', () => {
  it('is unavailable when its database is missing, and nothing is created in its place', async () => {
    const { record, paths } = await defaultLibrary();
    await rm(paths.db);
    const { registry } = await open();
    expect(registry.get(record.id)).toMatchObject({
      status: 'unavailable',
      reason: `Its database ${record.path}/library.db was not found.`,
    });
    expect(existsSync(paths.db)).toBe(false);
  });

  it('is unavailable when its database is damaged, and the file is left as it was', async () => {
    const { record, paths } = await defaultLibrary();
    for (const suffix of ['-wal', '-shm']) await rm(`${paths.db}${suffix}`, { force: true });
    const garbage = 'definitely not SQLite, but long enough to look like a header to it';
    await writeFile(paths.db, garbage);
    const { registry, lines } = await open();
    expect(registry.get(record.id)).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('could not be read'),
    });
    expect(await readFile(paths.db, 'utf8')).toBe(garbage);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({ id: record.id }),
      }),
    );
  });

  // Root ignores permission bits, so the file would be writable after all.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'is unavailable, not ok, when this process cannot write its database',
    async () => {
      // SQLite would open it read-only without a word, and the first write would fail.
      const { record, paths } = await defaultLibrary();
      await chmod(paths.db, 0o444);
      const { registry, lines } = await open();
      expect(registry.get(record.id)).toMatchObject({
        status: 'unavailable',
        schemaVersion: null,
        reason:
          `Its database ${record.path}/library.db cannot be written by the user Lantern runs as; ` +
          'make it, the files beside it and its folder writable, then restart Lantern.',
      });
      expect(lines).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          fields: expect.objectContaining({ id: record.id }),
        }),
      );
      // Nothing left beside it that would stay unwritable once the database is fixed.
      expect(existsSync(`${paths.db}-wal`)).toBe(false);
      expect(existsSync(`${paths.db}-shm`)).toBe(false);
      registry.close();

      await chmod(paths.db, 0o644);
      const { registry: again } = await open();
      expect(again.get(record.id)?.status).toBe('ok');
    },
  );

  it('is unavailable when its registered path leaves the data directory', async () => {
    await defaultLibrary();
    const id = newId('lib');
    registerRow(id, '../elsewhere', Date.now() + 1000);
    const { registry } = await open();
    expect(registry.get(id)).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('not a path inside the data directory'),
    });
  });

  it('does not stop the others, which keep their order', async () => {
    const { record } = await defaultLibrary();
    const missing = newId('lib');
    registerRow(missing, libraryRelativePath(missing), Date.now() + 1000);

    const { registry } = await open();
    expect(registry.list().map((library) => [library.id, library.status])).toEqual([
      [record.id, 'ok'],
      [missing, 'unavailable'],
    ]);
    // Only the libraries that opened count as opened.
    const opened = install.db
      .prepare('select id from libraries where last_opened_at is not null order by id')
      .all()
      .map((row) => row['id']);
    expect(opened).toEqual([record.id]);
  });
});

describe('a library with pending steps', () => {
  const breaking: MigrationStep = {
    sql: 'create table later (id text primary key) strict;',
    breaksOlderReaders: true,
  };

  it('is snapshotted, migrated, and its library.json and min_reader brought up to date', async () => {
    const { record, paths } = await defaultLibrary();
    const { registry, migrations } = await open({ steps: [...LIBRARY_STEPS, breaking] });

    const migration = migrations.get(record.id);
    expect(migration?.from).toBe(1);
    expect(migration?.to).toBe(2);
    expect(migration?.snapshot).toMatch(/[/\\]backups[/\\]library\.v1\.[0-9A-Z]{26}\.db$/);
    expect(userVersionOf(migration?.snapshot ?? '')).toBe(1);

    expect(registry.get(record.id)).toMatchObject({ status: 'ok', schemaVersion: 2 });
    expect(await manifestOf(paths.manifest)).toMatchObject({ schema: 2, min_reader: 2 });
    expect(
      withDatabase(
        paths.db,
        (db) => db.prepare("select value from meta where key = 'min_reader'").get()?.['value'],
        true,
      ),
    ).toBe('2');
  });

  it('is not migrated without a snapshot, and says why without naming paths', async () => {
    const { record, paths } = await defaultLibrary();
    const { registry } = await open({
      steps: [...LIBRARY_STEPS, breaking],
      seams: { freeBytes: () => Promise.resolve(0) },
    });
    const reason = registry.get(record.id)?.reason ?? '';
    expect(registry.get(record.id)?.status).toBe('unavailable');
    expect(reason).toBe(
      'There is not enough free space to snapshot it before migrating, so it was left at schema 1.',
    );
    expect(userVersionOf(paths.db)).toBe(1);
  });

  it('is unavailable when a step fails, left at its last whole version with the snapshot kept', async () => {
    const { record, paths } = await defaultLibrary();
    const failing: MigrationStep = { sql: 'alter table nowhere add column x text;' };
    const { registry } = await open({ steps: [...LIBRARY_STEPS, failing] });

    expect(registry.get(record.id)).toMatchObject({
      status: 'unavailable',
      reason: expect.stringMatching(/from schema 1 to 2 failed.*backups/),
    });
    expect(userVersionOf(paths.db)).toBe(1);
    expect(await manifestOf(paths.manifest)).toMatchObject({ schema: 1 });
    expect(await readdir(paths.backups)).toHaveLength(1);
  });
});
