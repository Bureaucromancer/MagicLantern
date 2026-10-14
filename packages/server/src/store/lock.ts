// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * One daemon per data directory: an OS lock taken through SQLite on
 * `<data>/lantern.lock` (`locking_mode = exclusive; begin exclusive`, never
 * committed). Node has no flock of its own, and SQLite's is the one this
 * process already carries. The kernel releases it when the process dies,
 * however it dies, so there is no stale lock to clean up.
 *
 * The handle must stay referenced for the life of the process: a
 * `DatabaseSync` the garbage collector finalises closes its file, and the
 * lock goes with it. And the lock file must never be opened with fs: on
 * POSIX, closing *any* fd to a file drops the process's locks on it. A second
 * SQLite open of it in this process is refused with BUSY and leaves the lock
 * held, which is what a second daemon in one test process sees.
 *
 * A lock file this process may not write is refused before SQLite sees it:
 * SQLite would open it read-only without a word, `begin exclusive` on a
 * read-only file takes only a shared lock, and every daemon would "hold" it.
 */

import { accessSync, constants } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { closeDatabase, SqliteCode, sqlitePrimaryCode } from './db.js';
import { StoreError } from './errors.js';
import { DataDirError, describeUnusableDataDir } from './files.js';
import { describeLeaseHolder } from './lease.js';
import { dataPaths } from './paths.js';
import type { InstanceLock } from './types.js';

/** Another process holds the data directory. A usage error: one sentence, exit 1. */
export class InstanceLockHeldError extends StoreError {
  readonly dataDir: string;

  constructor(dataDir: string, detail?: string, options?: ErrorOptions) {
    super(
      `Another Lantern is already using the data directory ${dataDir}` +
        (detail === undefined ? '.' : ` (${detail}).`),
      options,
    );
    this.name = 'InstanceLockHeldError';
    this.dataDir = dataDir;
  }
}

/**
 * Every lock this process holds. Belt and braces with the caller's own
 * module-level reference: whatever the caller does with the returned object,
 * the handle stays reachable until `release()`.
 */
const held = new Set<DatabaseSync>();

/**
 * Takes the lock or throws {@link InstanceLockHeldError}, naming the holder
 * from the lease row when it has a fresh one. A lock file this process cannot
 * write is a {@link DataDirError}, and one SQLite cannot use (not a database)
 * a {@link StoreError}, each a sentence. The caller runs the writable-directory
 * check first; the lock file is checked again here for callers that do not.
 */
export function acquireInstanceLock(dataDir: string): InstanceLock {
  const db = lockDataDir(dataDir);
  held.add(db);
  return {
    release: () => {
      if (!held.delete(db)) return;
      closeDatabase(db);
    },
  };
}

function lockDataDir(dataDir: string): DatabaseSync {
  const { lock: lockPath } = dataPaths(dataDir);
  assertWritableIfPresent(dataDir, lockPath);
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(lockPath);
    db.exec('pragma locking_mode = exclusive');
    db.exec('begin exclusive');
    return db;
  } catch (error) {
    if (db !== null) closeDatabase(db);
    const code = sqlitePrimaryCode(error);
    if (code === SqliteCode.busy) {
      throw new InstanceLockHeldError(dataDir, describeLeaseHolder(dataDir, Date.now()), {
        cause: error,
      });
    }
    if (code === null) throw error;
    throw new StoreError(describeLockFailure(lockPath, code, error), { cause: error });
  }
}

/**
 * `access` asks about the path and opens no descriptor, so it cannot drop a
 * lock this process already holds on the file (closing any fd to it would).
 */
function assertWritableIfPresent(dataDir: string, lockPath: string): void {
  try {
    accessSync(lockPath, constants.W_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new DataDirError(dataDir, describeUnusableDataDir(error, dataDir));
  }
}

function describeLockFailure(lockPath: string, code: number, error: unknown): string {
  if (code === SqliteCode.notADatabase || code === SqliteCode.corrupt) {
    return `${lockPath} is not a Lantern lock file; remove it and start again.`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not take the lock on ${lockPath} (${detail}).`;
}
