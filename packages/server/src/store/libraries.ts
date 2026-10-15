// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The library registry: every library in the install database's `libraries`
 * table, opened and migrated at startup one at a time (library.ts). One that
 * is newer than this build opens read-only (if its `min_reader` allows) or is
 * marked unavailable, and the daemon keeps running either way (A20). A fresh
 * install gets one library named "Library" and never asks which to use (A22);
 * an empty registry over library folders already on disk registers those
 * instead (a lost or replaced lantern.db must not hide them).
 *
 * Each library this build may write is swept at open (A23). Libraries
 * created while serving join the registry at once; creating and renaming
 * keep names unique, ignoring case.
 */

import type { DatabaseSync } from 'node:sqlite';

import { closeDatabase, inTransaction, numberColumn, textColumn } from './db.js';
import { errorFields } from './errors.js';
import {
  createLibrary,
  DEFAULT_LIBRARY_NAME,
  openLibrary,
  registerExistingLibraries,
  renameManifest,
  type LibraryOptions,
  type LibraryRow,
  type OpenedLibrary,
} from './library.js';
import type { JobStore, Library } from './library-types.js';
import { LocalLibrary } from './local-library.js';
import { libraryPaths } from './paths.js';
import {
  LibraryNameTakenError,
  type DatabaseMigration,
  type InstallStore,
  type LibraryRecord,
  type LibraryRegistry,
  type StoreLog,
} from './types.js';

/** The registry, and what opening each library did (for `lantern migrate`). */
export interface OpenedLibraries {
  readonly registry: LibraryRegistry;
  /** By library id; null for a library that was not migrated (newer, or unavailable). */
  readonly migrations: ReadonlyMap<string, DatabaseMigration | null>;
}

export async function openLibraryRegistry(
  install: InstallStore,
  dataDir: string,
  deps: { log: StoreLog },
): Promise<LibraryRegistry> {
  return (await openLibraries(install, dataDir, deps)).registry;
}

export async function openLibraries(
  install: InstallStore,
  dataDir: string,
  deps: { readonly log: StoreLog },
  options: LibraryOptions = {},
): Promise<OpenedLibraries> {
  const { log } = deps;
  let rows = listLibraryRows(install.db);
  if (rows.length === 0 && (await registerExistingLibraries(install, dataDir, { log })) > 0) {
    rows = listLibraryRows(install.db);
  }
  const opened: OpenedLibrary[] = [];
  try {
    if (rows.length === 0) {
      opened.push(
        await createLibrary(install, dataDir, { name: DEFAULT_LIBRARY_NAME, log }, options),
      );
    } else {
      // In turn rather than together: each may snapshot and migrate, and a
      // disk is not faster for being asked three things at once.
      for (const row of rows) opened.push(await openOne(dataDir, row, log, options));
    }
  } catch (error) {
    for (const library of opened) if (library.db !== null) closeDatabase(library.db);
    throw error;
  }

  try {
    markOpened(
      install.db,
      opened.filter((library) => library.db !== null).map((library) => library.record.id),
      Date.now(),
    );
  } catch (error) {
    // Bookkeeping only; not worth refusing to start over.
    log.warn('Could not record when the libraries were last opened.', errorFields(error));
  }

  const entries: Entry[] = [];
  for (const library of opened) entries.push(await entryFor(dataDir, library, log));
  return {
    registry: new Registry(install, dataDir, log, options, entries),
    migrations: new Map(opened.map((library) => [library.record.id, library.migration])),
  };
}

/** One library as the registry holds it: its record, and its handle when it opened. */
interface Entry {
  record: LibraryRecord;
  readonly db: DatabaseSync | null;
  readonly local: LocalLibrary | null;
}

/**
 * The handle over an opened library, after the startup sweep (A23) for one
 * this build may write. A sweep that fails is logged: the library still
 * serves, with whatever it could not remove left for the next start.
 */
async function entryFor(dataDir: string, opened: OpenedLibrary, log: StoreLog): Promise<Entry> {
  const { record, db } = opened;
  if (db === null) return { record, db, local: null };
  const local = new LocalLibrary({
    id: record.id,
    db,
    paths: libraryPaths(dataDir, record.path),
    writable: record.status === 'ok',
    log,
  });
  if (local.writable) {
    try {
      const swept = await local.sweep();
      const removed =
        swept.tempFiles + swept.orphanAssets + swept.orphanThumbnails + swept.staleSpools;
      if (removed > 0) {
        log.info('Removed files left by interrupted writes.', { id: record.id, ...swept });
      }
    } catch (error) {
      log.warn('Could not sweep the library folder.', { id: record.id, ...errorFields(error) });
    }
  }
  return { record, db, local };
}

/** Names compare without regard to case or Unicode form. */
function nameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

class Registry implements LibraryRegistry {
  private readonly byId: Map<string, Entry>;
  private closed = false;
  /** Creates and renames run one at a time, so two cannot both take a free name. */
  private changes: Promise<unknown> = Promise.resolve();

  private readonly install: InstallStore;
  private readonly dataDir: string;
  private readonly log: StoreLog;
  private readonly options: LibraryOptions;

  constructor(
    install: InstallStore,
    dataDir: string,
    log: StoreLog,
    options: LibraryOptions,
    entries: readonly Entry[],
  ) {
    this.install = install;
    this.dataDir = dataDir;
    this.log = log;
    this.options = options;
    this.byId = new Map(entries.map((entry) => [entry.record.id, entry]));
  }

  list(): LibraryRecord[] {
    return [...this.byId.values()].map((entry) => entry.record);
  }

  get(id: string): LibraryRecord | undefined {
    return this.byId.get(id)?.record;
  }

  library(id: string): Library | undefined {
    return this.byId.get(id)?.local ?? undefined;
  }

  jobs(id: string): JobStore | undefined {
    const local = this.byId.get(id)?.local;
    return local?.writable === true ? local : undefined;
  }

  async create(name: string): Promise<LibraryRecord> {
    return await this.serialised(async () => {
      this.assertOpen();
      this.assertNameFree(name, null);
      const opened = await createLibrary(
        this.install,
        this.dataDir,
        { name, log: this.log },
        this.options,
      );
      const entry = await entryFor(this.dataDir, opened, this.log);
      this.byId.set(entry.record.id, entry);
      return entry.record;
    });
  }

  async rename(id: string, name: string): Promise<LibraryRecord | undefined> {
    return await this.serialised(async () => {
      this.assertOpen();
      const entry = this.byId.get(id);
      if (entry === undefined) return undefined;
      this.assertNameFree(name, id);
      if (entry.record.name === name) return entry.record;
      inTransaction(this.install.db, () => {
        this.install.db.prepare('update libraries set name = ? where id = ?').run(name, id);
      });
      entry.record = { ...entry.record, name };
      // Only a folder this build owns: a newer build's manifest is not ours to write.
      if (entry.record.status === 'ok') {
        await renameManifest(libraryPaths(this.dataDir, entry.record.path), id, name, this.log);
      }
      this.log.info('Renamed a library.', { id, name });
      return entry.record;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.byId.values()) if (entry.db !== null) closeDatabase(entry.db);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('The library registry is closed.');
  }

  private assertNameFree(name: string, except: string | null): void {
    const key = nameKey(name);
    for (const entry of this.byId.values()) {
      if (entry.record.id !== except && nameKey(entry.record.name) === key) {
        throw new LibraryNameTakenError(name);
      }
    }
  }

  private async serialised<T>(change: () => Promise<T>): Promise<T> {
    const run = this.changes.then(change, change);
    this.changes = run.catch(() => undefined);
    return await run;
  }
}

/** A library's failure is its own: anything unforeseen still lists it as unavailable. */
async function openOne(
  dataDir: string,
  row: LibraryRow,
  log: StoreLog,
  options: LibraryOptions,
): Promise<OpenedLibrary> {
  try {
    return await openLibrary(dataDir, row, { log }, options);
  } catch (error) {
    const reason = 'It could not be opened; see the daemon log.';
    log.error(`Library ${row.id} is unavailable. ${reason}`, {
      id: row.id,
      path: row.path,
      ...errorFields(error),
    });
    const record: LibraryRecord = {
      id: row.id,
      name: row.name,
      path: row.path,
      status: 'unavailable',
      reason,
      schemaVersion: null,
    };
    return { record, db: null, migration: null };
  }
}

/** Oldest first, so the default library leads and the order is stable. */
function listLibraryRows(db: DatabaseSync): LibraryRow[] {
  return db
    .prepare('select id, name, path, created_at from libraries order by created_at, id')
    .all()
    .map((row) => ({
      id: textColumn(row, 'id'),
      name: textColumn(row, 'name'),
      path: textColumn(row, 'path'),
      createdAt: numberColumn(row, 'created_at'),
    }));
}

function markOpened(db: DatabaseSync, ids: readonly string[], now: number): void {
  if (ids.length === 0) return;
  inTransaction(db, () => {
    const update = db.prepare('update libraries set last_opened_at = ? where id = ?');
    for (const id of ids) update.run(now, id);
  });
}
