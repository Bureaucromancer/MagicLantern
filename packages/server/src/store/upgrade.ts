// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Open-for-writing and migrate, shared by the install and library databases:
 * check the files can be written, snapshot first when an existing file has
 * pending steps, then open with the write pragmas and run the steps. The
 * callers probe the file read-only beforehand, so a database this build must
 * not write (newer, or held from another host) is refused before anything
 * here touches it.
 */

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import {
  canWrite,
  closeDatabase,
  DatabaseTooNewError,
  openDatabase,
  runMigrations,
  SqliteCode,
  sqlitePrimaryCode,
  type MigrationHooks,
  type MigrationStep,
} from './db.js';
import { errorFields, StoreError } from './errors.js';
import { takeSnapshot, type SnapshotSeams } from './snapshot.js';
import type { DatabaseMigration, StoreLog } from './types.js';

export interface UpgradeRequest {
  readonly path: string;
  /** The file's version from the caller's probe; 0 for a file that does not exist yet. */
  readonly from: number;
  readonly steps: readonly MigrationStep[];
  readonly backupsDir: string;
  /** The snapshot names' stem: `lantern` or `library`. */
  readonly stem: string;
  /** How log lines name the database, e.g. `lantern.db` or `library lib_…`. */
  readonly label: string;
  readonly log: StoreLog;
  readonly hooks?: MigrationHooks;
  readonly seams?: SnapshotSeams;
}

/** A migration step failed and was rolled back; earlier steps stay committed. */
export class MigrationFailedError extends StoreError {
  readonly from: number;
  readonly to: number;
  /** The snapshot taken before migrating, if one was. */
  readonly snapshot: string | null;

  constructor(
    label: string,
    details: { from: number; to: number; snapshot: string | null },
    options?: ErrorOptions,
  ) {
    super(
      `Migrating ${label} from schema ${String(details.from)} to ${String(details.to)} failed` +
        (details.snapshot === null
          ? '.'
          : `; the snapshot taken before it is ${details.snapshot}.`),
      options,
    );
    this.name = 'MigrationFailedError';
    this.from = details.from;
    this.to = details.to;
    this.snapshot = details.snapshot;
  }
}

/**
 * The database, a file beside it or its folder cannot be written by this
 * process. SQLite would have opened it read-only without a word, and the first
 * write, possibly hours later, would have been the first anyone heard of it.
 */
export class DatabaseNotWritableError extends StoreError {
  readonly path: string;

  constructor(label: string, path: string, detail: string, options?: ErrorOptions) {
    super(
      `${label} (${path}) cannot be written by this process (${detail}). Make it, the ` +
        '-wal and -shm files beside it and its folder writable by the user Lantern runs as ' +
        '(for a mounted volume, chown -R on the host), then start again.',
      options,
    );
    this.name = 'DatabaseNotWritableError';
    this.path = path;
  }
}

/** Only when there is something to lose: an existing file at a version with steps pending. */
export function needsSnapshot(from: number, to: number): boolean {
  return from > 0 && from < to;
}

/**
 * Checks the files can be written, snapshots if needed, opens read-write and
 * migrates. A file this process cannot write throws
 * {@link DatabaseNotWritableError} (before any snapshot when `access` can
 * tell); a failed snapshot throws before the file is opened for writing
 * ({@link StoreError}); a failed step closes the handle and throws
 * {@link MigrationFailedError}.
 */
export async function openAndMigrate(
  request: UpgradeRequest,
): Promise<{ db: DatabaseSync; migration: DatabaseMigration }> {
  const { path, from, steps, backupsDir, stem, label, log } = request;
  const to = steps.length;

  // Before the snapshot and the read-write open: SQLite would open a file it
  // may not write read-only without a word, and the snapshot would be for a
  // migration that cannot run.
  await assertWritableFiles(label, path);

  let snapshot: string | null = null;
  if (needsSnapshot(from, to)) {
    snapshot = await takeSnapshot(
      { source: path, backupsDir, stem, fromVersion: from },
      request.seams,
    );
    log.info(`Took a snapshot of ${label} before migrating it.`, { from, to, snapshot });
  }

  const db = openWritable(label, path);
  try {
    const result = runMigrations(db, steps, request.hooks);
    if (result.from !== result.to) {
      log.info(`Migrated ${label}.`, { from: result.from, to: result.to });
    }
    return { db, migration: { from: result.from, to: result.to, snapshot } };
  } catch (error) {
    closeDatabase(db);
    // The callers' probes refuse a newer file first; this is the backstop, and not a failed step.
    if (error instanceof DatabaseTooNewError) throw error;
    log.error(`Migrating ${label} failed; it is left at the last complete version.`, {
      from,
      to,
      snapshot,
      ...errorFields(error),
    });
    throw new MigrationFailedError(label, { from, to, snapshot }, { cause: error });
  }
}

/** The database, its `-wal` and `-shm` where present, and the folder they are made in. */
async function assertWritableFiles(label: string, path: string): Promise<void> {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`, dirname(path)]) {
    try {
      await access(candidate, constants.W_OK);
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code === 'ENOENT') continue;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        throw new DatabaseNotWritableError(label, path, `${code} on ${candidate}`, {
          cause: error,
        });
      }
      throw error;
    }
  }
}

/**
 * Opens read-write and proves it can write. `access` is only advice (a
 * network filesystem may answer it optimistically, and a `-shm` can appear
 * after it looked), and SQLite would not say.
 */
function openWritable(label: string, path: string): DatabaseSync {
  let db: DatabaseSync;
  try {
    db = openDatabase(path);
  } catch (error) {
    // Switching a read-only file to WAL is the one write the open itself makes.
    if (sqlitePrimaryCode(error) === SqliteCode.readOnly) {
      throw new DatabaseNotWritableError(label, path, 'SQLite could open it only read-only', {
        cause: error,
      });
    }
    throw error;
  }
  let writable: boolean;
  try {
    writable = canWrite(db);
  } catch (error) {
    closeDatabase(db);
    throw error;
  }
  if (!writable) {
    closeDatabase(db);
    throw new DatabaseNotWritableError(label, path, 'SQLite could open it only read-only');
  }
  return db;
}
