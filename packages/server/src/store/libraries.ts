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
 */

import type { DatabaseSync } from 'node:sqlite';

import { closeDatabase, inTransaction, numberColumn, textColumn } from './db.js';
import { errorFields } from './errors.js';
import {
  createLibrary,
  DEFAULT_LIBRARY_NAME,
  openLibrary,
  registerExistingLibraries,
  type LibraryOptions,
  type LibraryRow,
  type OpenedLibrary,
} from './library.js';
import type {
  DatabaseMigration,
  InstallStore,
  LibraryRecord,
  LibraryRegistry,
  StoreLog,
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
  return {
    registry: registryOf(opened),
    migrations: new Map(opened.map((library) => [library.record.id, library.migration])),
  };
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

function registryOf(opened: readonly OpenedLibrary[]): LibraryRegistry {
  const records = opened.map((library) => library.record);
  const byId = new Map(records.map((record) => [record.id, record]));
  let closed = false;
  return {
    list: () => [...records],
    get: (id) => byId.get(id),
    close: () => {
      if (closed) return;
      closed = true;
      for (const library of opened) if (library.db !== null) closeDatabase(library.db);
    },
  };
}
