// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Opening a `node:sqlite` database, running its migrations, and the one
 * transaction helper, shared by the install and library databases.
 *
 * Pragmas are explicit even where they match node:sqlite's defaults, so the
 * policy is stated in code: `busy_timeout = 5000`, `foreign_keys = ON`,
 * `journal_mode = WAL` (outside any transaction), `synchronous = NORMAL`.
 *
 * Migrations are append-only steps: `steps[i]` takes version i to i + 1, and
 * the version lives in `PRAGMA user_version` (no migrations table). Each step
 * runs in its own `begin immediate` together with the `user_version` bump, so
 * a crash leaves a whole version, never half of one. Never edit a step that
 * has shipped and never drop a table holding data; a correction is a new step.
 */

import { existsSync } from 'node:fs';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

/** One append-only migration step: `steps[i]` takes version i to i + 1. */
export interface MigrationStep {
  readonly sql: string;
  /**
   * For table rebuilds (create new, copy, drop old, rename). With foreign keys
   * on, `drop table parent` runs an implicit delete that cascades into every
   * child with `on delete cascade`, and `pragma foreign_keys = off` inside a
   * transaction is silently ignored. So the runner turns them off before
   * `begin`, runs `pragma foreign_key_check` before commit, and turns them
   * back on afterwards.
   */
  readonly foreignKeysOff?: boolean;
  /**
   * The result can no longer be read by a build that knows only earlier
   * versions, so `min_reader` rises to this step's target version.
   */
  readonly breaksOlderReaders?: boolean;
}

export interface OpenDatabaseOptions {
  /** Open without writing: no migration, no pragma that writes (a newer library). */
  readonly readOnly?: boolean;
}

/**
 * Long enough to outlast an ordinary write transaction on another connection,
 * short enough that a database somebody holds for good fails rather than hangs.
 */
export const BUSY_TIMEOUT_MS = 5000;

/** SQLite primary result codes the store branches on (`errcode & 0xff`). */
export const SqliteCode = {
  busy: 5,
  readOnly: 8,
  corrupt: 11,
  full: 13,
  cantOpen: 14,
  notADatabase: 26,
} as const;

/**
 * SQLite's primary result code from a node:sqlite error, whose `errcode` may
 * be an extended code (the low byte is the primary one); null for anything else.
 */
export function sqlitePrimaryCode(error: unknown): number | null {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' ? code & 0xff : null;
}

/**
 * Opens a database file. A read-write open creates the file if it is missing;
 * a read-only open never does. If applying a pragma fails the handle is closed
 * before the error is rethrown: on Windows a leaked handle keeps `-wal`/`-shm`
 * locked, and the next thing to touch the directory fails far from the cause.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  const readOnly = options.readOnly === true;
  const db = new DatabaseSync(path, { readOnly });
  try {
    // First, so the journal-mode switch below can wait for a lock too.
    db.exec(`pragma busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
    db.exec('pragma foreign_keys = on');
    if (!readOnly) {
      // Changes the file header, so read-write only and never in a transaction.
      db.exec('pragma journal_mode = wal');
      // In WAL mode NORMAL never corrupts: a power cut can lose the last
      // commits but not the file, and it spares an fsync per commit.
      db.exec('pragma synchronous = normal');
    }
  } catch (error) {
    closeDatabase(db);
    throw error;
  }
  return db;
}

/**
 * Opens an existing file to look at it, writing nothing at all. A read-only
 * open of a WAL database still creates `-wal` and `-shm` beside it, with the
 * database's own mode: a database this process may not write leaves two
 * files it may not write either, which keep it unwritable after the database
 * itself is fixed. With no `-wal` or `-journal` beside it the main file holds
 * every committed transaction, so it is opened `immutable` (no locks, no side
 * files); otherwise as an ordinary read-only connection. For a file nothing
 * else writes meanwhile: the caller holds the instance lock.
 */
export function openToProbe(path: string): DatabaseSync {
  if (existsSync(`${path}-wal`) || existsSync(`${path}-journal`)) {
    return openDatabase(path, { readOnly: true });
  }
  const url = pathToFileURL(path);
  url.searchParams.set('immutable', '1');
  return new DatabaseSync(url, { readOnly: true });
}

/** Closes a handle that may already be closed: node:sqlite throws on a second close. */
export function closeDatabase(db: DatabaseSync): void {
  if (db.isOpen) db.close();
}

/**
 * Runs a mutation as one `begin immediate` transaction and returns its value.
 *
 * `immediate` takes the write lock up front, where `busy_timeout` can wait
 * for another writer, instead of at the first write after a read, where
 * SQLite gives up with SQLITE_BUSY_SNAPSHOT. The body must be synchronous (the
 * `PromiseLike` exclusion makes an async body a compile error): a commit that
 * ran before an awaited body finished could never be rolled back. Not
 * re-entrant; helpers called inside one take the db and open none of their own.
 */
export function inTransaction<T>(
  db: DatabaseSync,
  mutate: () => T extends PromiseLike<unknown> ? never : T,
): T {
  if (transactionOpen(db)) {
    throw new Error('inTransaction cannot be nested: a transaction is already open.');
  }
  db.exec('begin immediate');
  try {
    const result = mutate();
    db.exec('commit');
    return result;
  } catch (error) {
    // A failed statement can already have ended the transaction (SQLite rolls
    // back by itself on some errors); a second rollback would hide the cause.
    if (transactionOpen(db)) db.exec('rollback');
    throw error;
  }
}

/**
 * Whether this handle can really write. SQLite opens a file it may not write
 * (or whose `-shm` it may not write) read-only without saying so, and
 * `begin immediate` on such a file quietly becomes a read transaction; only a
 * write statement is refused. So: a write that changes nothing, rolled back,
 * which puts nothing on disk. False on SQLITE_READONLY; anything else throws.
 */
export function canWrite(db: DatabaseSync): boolean {
  try {
    // Inside the try: with a read-only `-shm` it is `begin` that is refused.
    db.exec('begin immediate');
    db.exec(`pragma user_version = ${String(readUserVersion(db))}`);
    return true;
  } catch (error) {
    if (sqlitePrimaryCode(error) === SqliteCode.readOnly) return false;
    throw error;
  } finally {
    if (transactionOpen(db)) db.exec('rollback');
  }
}

/** Read through a call so the compiler does not carry a narrowing across `exec`. */
function transactionOpen(db: DatabaseSync): boolean {
  return db.isTransaction;
}

/** `PRAGMA user_version`: the schema version, 0 for a new file. */
export function readUserVersion(db: DatabaseSync): number {
  const value = db.prepare('pragma user_version').get()?.['user_version'];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`The database's user_version is not a schema version: ${String(value)}.`);
  }
  return value;
}

/** A database written by a newer build than this one. Never migrated down. */
export class DatabaseTooNewError extends Error {
  readonly version: number;
  readonly known: number;

  constructor(version: number, known: number) {
    super(
      `The database is at schema version ${String(version)}, but this build knows ` +
        `${String(known)}: it was written by a newer Lantern.`,
    );
    this.name = 'DatabaseTooNewError';
    this.version = version;
    this.known = known;
  }
}

export interface MigrationHooks {
  /**
   * Runs inside each step's transaction after its SQL, with the version the
   * step produces, so whatever it records commits or rolls back with the step.
   */
  readonly afterStep?: (db: DatabaseSync, version: number) => void;
}

/**
 * Applies pending steps and answers the versions; refuses a database newer
 * than `steps` with {@link DatabaseTooNewError}, changing nothing.
 */
export function runMigrations(
  db: DatabaseSync,
  steps: readonly MigrationStep[],
  hooks: MigrationHooks = {},
): { from: number; to: number } {
  const from = readUserVersion(db);
  const to = steps.length;
  if (from > to) throw new DatabaseTooNewError(from, to);

  for (let version = from; version < to; version += 1) {
    const step = steps[version];
    if (step === undefined) throw new Error(`No migration step for version ${String(version)}.`);
    applyStep(db, step, version + 1, hooks);
  }
  return { from, to };
}

function applyStep(
  db: DatabaseSync,
  step: MigrationStep,
  target: number,
  hooks: MigrationHooks,
): void {
  const foreignKeysOff = step.foreignKeysOff === true;
  const restoreForeignKeys = foreignKeysOff && pragmaNumber(db, 'foreign_keys') === 1;
  if (foreignKeysOff) db.exec('pragma foreign_keys = off');
  try {
    inTransaction(db, () => {
      db.exec(step.sql);
      if (foreignKeysOff) assertForeignKeysHold(db, target);
      hooks.afterStep?.(db, target);
      db.exec(`pragma user_version = ${String(target)}`);
    });
  } finally {
    if (restoreForeignKeys) db.exec('pragma foreign_keys = on');
  }
}

/** With enforcement off for a rebuild, nothing else checks the references it left. */
function assertForeignKeysHold(db: DatabaseSync, target: number): void {
  const violations = db.prepare('pragma foreign_key_check').all();
  const first = violations[0];
  if (first === undefined) return;
  throw new Error(
    `Migration to version ${String(target)} leaves ${String(violations.length)} foreign key ` +
      `violation(s); the first is in table ${String(first['table'])}, ` +
      `referencing ${String(first['parent'])}.`,
  );
}

/**
 * The lowest schema version a reader must know to read a database at
 * `version`: the target of the last step that broke older readers, and at
 * least 1 (a reader that knows no schema reads nothing).
 */
export function minReaderFor(
  steps: readonly MigrationStep[],
  version: number = steps.length,
): number {
  let minReader = 1;
  for (let index = 0; index < Math.min(version, steps.length); index += 1) {
    if (steps[index]?.breaksOlderReaders === true) minReader = index + 1;
  }
  return minReader;
}

function pragmaNumber(db: DatabaseSync, name: string): number | null {
  const value = db.prepare(`pragma ${name}`).get()?.[name];
  return typeof value === 'number' ? value : null;
}

/** Whether a table exists, for reading a database whose version is not yet known. */
export function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db
      .prepare("select 1 as found from sqlite_schema where type = 'table' and name = ?")
      .get(name) !== undefined
  );
}

/** A text column, or a thrown error naming it: a row we wrote has the types we wrote. */
export function textColumn(row: Record<string, SQLOutputValue>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new TypeError(`Column ${column} is not text.`);
  return value;
}

/** A numeric column (integer or real), or a thrown error naming it. */
export function numberColumn(row: Record<string, SQLOutputValue>, column: string): number {
  const value = row[column];
  if (typeof value !== 'number') throw new TypeError(`Column ${column} is not a number.`);
  return value;
}
