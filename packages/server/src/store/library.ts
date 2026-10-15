// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * One library folder: `library.db` and `library.json`.
 *
 * Opening one never throws for the library's own problems; it answers a
 * record whose status says what happened (A20):
 * - at or behind this build: snapshot if an existing file has pending steps,
 *   migrate, then bring `library.json` in line → `ok`;
 * - ahead, and its `min_reader` is one this build knows → `read-only`, with
 *   nothing written (not even `library.json`, which is the newer build's);
 * - ahead of what this build can read, missing, damaged, not writable by
 *   this process, or failed to migrate → `unavailable`, with the reason as
 *   a sentence.
 *
 * `user_version` is the truth about the schema. `library.json` is a copy so a
 * moved folder still knows what it is; the migration commits first and the
 * manifest is written after, so a crash in between leaves it stale, and the
 * next open rewrites it. `min_reader` is kept in the database's `meta` table
 * too, written in each step's transaction, so a newer library can be judged
 * even when its manifest is gone.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';

import { LIBRARY_ID_PATTERN, type LibraryStatus } from '@bureaucromancer/lantern-schema';

import { newId } from '../ids.js';
import { writeJsonAtomic } from './atomic.js';
import {
  closeDatabase,
  inTransaction,
  minReaderFor,
  openDatabase,
  openToProbe,
  readUserVersion,
  tableExists,
  type MigrationStep,
} from './db.js';
import { errorFields } from './errors.js';
import { LIBRARY_STEPS, MIN_READER_KEY } from './migrations.js';
import { dataPaths, libraryPaths, libraryRelativePath, type LibraryPaths } from './paths.js';
import { SnapshotError, sweepPartialSnapshots, type SnapshotSeams } from './snapshot.js';
import type { DatabaseMigration, InstallStore, LibraryRecord, StoreLog } from './types.js';
import { DatabaseNotWritableError, MigrationFailedError, openAndMigrate } from './upgrade.js';

/** What a fresh install's one library is called. */
export const DEFAULT_LIBRARY_NAME = 'Library';

/** A row of the install database's `libraries` table. */
export interface LibraryRow {
  readonly id: string;
  readonly name: string;
  /** Relative to the data directory, `/`-separated. */
  readonly path: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
}

/** `library.json`. Unknown keys a newer build wrote are kept when it is rewritten. */
export interface LibraryManifest {
  readonly id: string;
  readonly name: string;
  readonly schema: number;
  readonly min_reader: number;
  /** ISO 8601, for the person reading the file. */
  readonly created_at: string;
}

export interface OpenedLibrary {
  readonly record: LibraryRecord;
  /** Writable when `ok`, read-only when `read-only`, null when `unavailable`. */
  readonly db: DatabaseSync | null;
  /** What migrating did; null when it was not migrated (newer, or unavailable). */
  readonly migration: DatabaseMigration | null;
}

/** Internal knobs; production passes none. Tests use them to migrate across versions. */
export interface LibraryOptions {
  readonly steps?: readonly MigrationStep[];
  readonly seams?: SnapshotSeams;
}

const LIBRARY_ID = new RegExp(LIBRARY_ID_PATTERN);

export async function openLibrary(
  dataDir: string,
  row: LibraryRow,
  deps: { readonly log: StoreLog },
  options: LibraryOptions = {},
): Promise<OpenedLibrary> {
  const { log } = deps;
  const steps = options.steps ?? LIBRARY_STEPS;
  const known = steps.length;

  const unavailable = (reason: string, fields: Record<string, unknown> = {}): OpenedLibrary => {
    log.warn(`Library ${row.id} is unavailable. ${reason}`, {
      id: row.id,
      path: row.path,
      ...fields,
    });
    return { record: libraryRecord(row, 'unavailable', null, reason), db: null, migration: null };
  };

  let paths: LibraryPaths;
  try {
    paths = libraryPaths(dataDir, row.path);
  } catch {
    return unavailable(
      `Its registered folder "${row.path}" is not a path inside the data directory.`,
    );
  }
  // Never created here: a registered library whose database is gone (a
  // folder deleted, a drive not mounted) must not come back empty.
  if (!existsSync(paths.db)) {
    return unavailable(`Its database ${row.path}/library.db was not found.`);
  }

  const swept = await sweepPartialSnapshots(paths.backups);
  if (swept > 0) {
    log.info('Removed partial snapshots left by an interrupted migration.', {
      id: row.id,
      directory: paths.backups,
      removed: swept,
    });
  }

  const manifest = await readManifest(paths.manifest);
  const manifestId = manifest?.['id'];
  if (typeof manifestId === 'string' && LIBRARY_ID.test(manifestId) && manifestId !== row.id) {
    return unavailable(
      `Its folder ${row.path} holds a different library (${manifestId}, by its library.json).`,
    );
  }

  let probe: { version: number; minReader: number | null };
  try {
    probe = probeLibrary(paths.db);
  } catch (error) {
    return unavailable(
      'Its database could not be read; it may be damaged or not a Lantern library.',
      errorFields(error),
    );
  }

  if (probe.version > known) {
    return openNewer(paths, row, probe, manifest, known, log, unavailable);
  }

  let opened: { db: DatabaseSync; migration: DatabaseMigration };
  try {
    opened = await openAndMigrate({
      path: paths.db,
      from: probe.version,
      steps,
      backupsDir: paths.backups,
      stem: 'library',
      label: `library ${row.id}`,
      log,
      hooks: {
        afterStep: (db, version) => {
          writeMinReader(db, minReaderFor(steps, version));
        },
      },
      ...(options.seams === undefined ? {} : { seams: options.seams }),
    });
  } catch (error) {
    if (error instanceof MigrationFailedError) {
      return unavailable(
        `Migrating it from schema ${String(error.from)} to ${String(error.to)} failed; see the daemon log.` +
          (error.snapshot === null
            ? ''
            : ` A snapshot from before the attempt is in ${row.path}/backups.`),
      );
    }
    // The reasons reach the API, so they are said without the absolute paths in the message.
    if (error instanceof DatabaseNotWritableError) {
      return unavailable(
        `Its database ${row.path}/library.db cannot be written by the user Lantern runs as; ` +
          'make it, the files beside it and its folder writable, then restart Lantern.',
        errorFields(error),
      );
    }
    if (error instanceof SnapshotError) {
      return unavailable(
        error.kind === 'no-room'
          ? `There is not enough free space to snapshot it before migrating, so it was left at schema ${String(probe.version)}.`
          : `It could not be snapshotted before migrating, so it was left at schema ${String(probe.version)}; see the daemon log.`,
        errorFields(error),
      );
    }
    return unavailable(
      'Its database could not be opened for writing; see the daemon log.',
      errorFields(error),
    );
  }

  const { to } = opened.migration;
  await syncManifest(paths.manifest, expectedManifest(row, to, minReaderFor(steps, to), manifest), {
    existing: manifest,
    log,
    id: row.id,
  });
  return {
    record: libraryRecord(row, 'ok', to),
    db: opened.db,
    migration: opened.migration,
  };
}

/**
 * A library a newer build wrote: read-only when its `min_reader` (from the
 * database, else from a manifest that describes the same version) is one we
 * know. A `min_reader` that cannot be found is a refusal, not a guess.
 */
function openNewer(
  paths: LibraryPaths,
  row: LibraryRow,
  probe: { version: number; minReader: number | null },
  manifest: Record<string, unknown> | null,
  known: number,
  log: StoreLog,
  unavailable: (reason: string, fields?: Record<string, unknown>) => OpenedLibrary,
): OpenedLibrary {
  const newer = `It was written by a newer Lantern (library schema ${String(probe.version)}; this one knows ${String(known)}).`;
  const minReader =
    probe.minReader ??
    (manifest?.['schema'] === probe.version ? nonNegativeInteger(manifest['min_reader']) : null);
  if (minReader === null) {
    return unavailable(
      `${newer} The oldest Lantern that can read it is not recorded, so it is not opened.`,
    );
  }
  if (minReader > known) {
    return unavailable(
      `${newer} It needs a Lantern that knows schema ${String(minReader)} or later; upgrade to open it.`,
    );
  }

  let db: DatabaseSync;
  try {
    db = openDatabase(paths.db, { readOnly: true });
  } catch (error) {
    return unavailable(`${newer} It could not be opened read-only.`, errorFields(error));
  }
  const reason = `${newer} It is open read-only until Lantern is upgraded.`;
  log.warn(`Library ${row.id} is read-only. ${reason}`, { id: row.id, path: row.path });
  return { record: libraryRecord(row, 'read-only', probe.version, reason), db, migration: null };
}

/**
 * Creates a library folder, its database and manifest, then registers it.
 * Files first: a crash before the insert leaves an unregistered folder (which
 * the next start registers if its manifest was written, and otherwise passes
 * over for a new one), never a registered library with no database behind it. A failure this process sees removes the folder
 * again, so a start that keeps failing does not leave one per attempt.
 */
export async function createLibrary(
  install: InstallStore,
  dataDir: string,
  details: { readonly name: string; readonly log: StoreLog; readonly now?: number },
  options: LibraryOptions = {},
): Promise<OpenedLibrary> {
  const { name, log } = details;
  const steps = options.steps ?? LIBRARY_STEPS;
  const id = newId('lib');
  const row: LibraryRow = {
    id,
    name,
    path: libraryRelativePath(id),
    createdAt: details.now ?? Date.now(),
  };
  const paths = libraryPaths(dataDir, row.path);

  await mkdir(paths.root, { recursive: true });
  let db: DatabaseSync | null = null;
  try {
    const opened = await openAndMigrate({
      path: paths.db,
      from: 0,
      steps,
      backupsDir: paths.backups,
      stem: 'library',
      label: `library ${id}`,
      log,
      hooks: {
        afterStep: (database, version) => {
          writeMinReader(database, minReaderFor(steps, version));
        },
      },
    });
    db = opened.db;
    const { migration } = opened;
    await writeJsonAtomic(
      paths.manifest,
      expectedManifest(row, migration.to, minReaderFor(steps, migration.to), null),
    );
    inTransaction(install.db, () => {
      install.db
        .prepare(
          'insert into libraries (id, name, path, created_at, last_opened_at) values (?, ?, ?, ?, ?)',
        )
        .run(row.id, row.name, row.path, row.createdAt, row.createdAt);
    });
    log.info('Created a library.', { id, name, path: row.path });
    return { record: libraryRecord(row, 'ok', migration.to), db, migration };
  } catch (error) {
    if (db !== null) closeDatabase(db);
    // Named for an id made a moment ago and registered nowhere: nothing else is in it.
    await rm(paths.root, { recursive: true, force: true }).catch((cleanup: unknown) => {
      log.warn('Could not remove the folder of a library that failed to be created.', {
        id,
        path: row.path,
        ...errorFields(cleanup),
      });
    });
    throw error;
  }
}

/**
 * Registers the library folders already under `libraries/`, for a registry
 * that is empty: the install database was lost or replaced, or the folders
 * came from another install. Without this, a new empty default library would
 * take their place and their work would vanish from the app. A folder counts
 * only when it has a `library.db` and its `library.json` names it (the id is
 * the folder's name), so a copy under another name, or a folder a crash left
 * before its manifest was written, is left alone and logged. Answers how many
 * were registered; opening them is the caller's, as for any registered library.
 */
export async function registerExistingLibraries(
  install: InstallStore,
  dataDir: string,
  deps: { readonly log: StoreLog; readonly now?: number },
): Promise<number> {
  const { log } = deps;
  let entries;
  try {
    entries = await readdir(dataPaths(dataDir).libraries, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }

  const rows: LibraryRow[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !LIBRARY_ID.test(entry.name)) continue;
    const path = libraryRelativePath(entry.name);
    const paths = libraryPaths(dataDir, path);
    const manifest = await readManifest(paths.manifest);
    if (!existsSync(paths.db) || manifest?.['id'] !== entry.name) {
      log.warn(
        'Left a library folder unregistered: it has no library.db, or its library.json does not name it.',
        { path },
      );
      continue;
    }
    const name = manifest['name'];
    const createdAt = Date.parse(String(manifest['created_at']));
    rows.push({
      id: entry.name,
      name: typeof name === 'string' && name.trim() !== '' ? name : DEFAULT_LIBRARY_NAME,
      path,
      createdAt: Number.isNaN(createdAt) ? (deps.now ?? Date.now()) : createdAt,
    });
  }
  if (rows.length === 0) return 0;

  inTransaction(install.db, () => {
    const insert = install.db.prepare(
      'insert into libraries (id, name, path, created_at) values (?, ?, ?, ?)',
    );
    for (const row of rows) insert.run(row.id, row.name, row.path, row.createdAt);
  });
  for (const row of rows) {
    log.info('Registered a library found in the data directory.', {
      id: row.id,
      name: row.name,
      path: row.path,
    });
  }
  return rows.length;
}

/** The version and recorded `min_reader`, read without writing. */
function probeLibrary(path: string): { version: number; minReader: number | null } {
  const db = openToProbe(path);
  try {
    const version = readUserVersion(db);
    let minReader: number | null = null;
    if (version > 0 && tableExists(db, 'meta')) {
      const value = db.prepare('select value from meta where key = ?').get(MIN_READER_KEY)?.[
        'value'
      ];
      minReader = typeof value === 'string' ? nonNegativeInteger(Number(value)) : null;
    }
    return { version, minReader };
  } finally {
    closeDatabase(db);
  }
}

function writeMinReader(db: DatabaseSync, minReader: number): void {
  db.prepare(
    'insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
  ).run(MIN_READER_KEY, String(minReader));
}

/** `library.json` as an object, or null when it is missing or not a JSON object. */
async function readManifest(path: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function expectedManifest(
  row: LibraryRow,
  schema: number,
  minReader: number,
  existing: Record<string, unknown> | null,
): LibraryManifest {
  const createdAt = existing?.['created_at'];
  return {
    id: row.id,
    name: row.name,
    schema,
    min_reader: minReader,
    created_at:
      typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt))
        ? createdAt
        : new Date(row.createdAt).toISOString(),
  };
}

const MANIFEST_KEYS = ['id', 'name', 'schema', 'min_reader', 'created_at'] as const;

/**
 * Rewrites `library.json` when any field we own differs from the truth (the
 * database's version, the registry's id and name), keeping keys we do not
 * know. A failed write is logged and the library stays usable: the manifest
 * is a copy, and the next open tries again.
 */
async function syncManifest(
  path: string,
  expected: LibraryManifest,
  context: { existing: Record<string, unknown> | null; log: StoreLog; id: string },
): Promise<void> {
  const { existing, log, id } = context;
  const stale = MANIFEST_KEYS.filter((key) => existing?.[key] !== expected[key]);
  if (stale.length === 0) return;

  const extras = Object.fromEntries(
    Object.entries(existing ?? {}).filter(
      ([key]) => !(MANIFEST_KEYS as readonly string[]).includes(key),
    ),
  );
  try {
    await writeJsonAtomic(path, { ...expected, ...extras });
  } catch (error) {
    log.warn('Could not write library.json; the database still records its version.', {
      id,
      ...errorFields(error),
    });
    return;
  }
  log.info(existing === null ? 'Wrote a missing library.json.' : 'Repaired a stale library.json.', {
    id,
    fields: stale,
  });
}

/**
 * Writes a new name into `library.json`, keeping every other key. A failure
 * is logged and not thrown: the registry holds the name, and the manifest is
 * a copy that the next open brings in line.
 */
export async function renameManifest(
  paths: LibraryPaths,
  id: string,
  name: string,
  log: StoreLog,
): Promise<void> {
  const existing = await readManifest(paths.manifest);
  if (existing?.['id'] !== id) {
    // Missing or foreign: the next open writes a whole one.
    return;
  }
  try {
    await writeJsonAtomic(paths.manifest, { ...existing, name });
  } catch (error) {
    log.warn('Could not write the new name into library.json.', { id, ...errorFields(error) });
  }
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function libraryRecord(
  row: LibraryRow,
  status: LibraryStatus,
  schemaVersion: number | null,
  reason?: string,
): LibraryRecord {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    status,
    schemaVersion,
    ...(reason === undefined ? {} : { reason }),
  };
}
