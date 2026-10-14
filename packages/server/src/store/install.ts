// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `lantern.db`: libraries, the lease, and (later) backends, models and routes.
 *
 * Opening it: probe the file read-only, refusing one newer than this build
 * (A20) or leased by a live process on another machine before anything in the
 * data directory is touched; sweep partial snapshots; snapshot and migrate;
 * then write this process's lease row. The caller holds the instance lock
 * throughout.
 */

import { existsSync } from 'node:fs';
import { uptime } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';

import {
  closeDatabase,
  inTransaction,
  openToProbe,
  readUserVersion,
  tableExists,
  type MigrationStep,
} from './db.js';
import { errorFields, StoreError } from './errors.js';
import {
  describeLease,
  leaseHeldElsewhere,
  readLease,
  releaseLease,
  touchLease,
  writeLease,
  type LeaseRow,
} from './lease.js';
import { InstanceLockHeldError } from './lock.js';
import { INSTALL_STEPS } from './migrations.js';
import { dataPaths } from './paths.js';
import { sweepPartialSnapshots, type SnapshotSeams } from './snapshot.js';
import type { BootIdentity, DatabaseMigration, InstallStore, StoreLog } from './types.js';
import { openAndMigrate } from './upgrade.js';

/** `lantern.db` was written by a newer build: refuse to start rather than write under it (A20). */
export class InstallSchemaTooNewError extends StoreError {
  readonly version: number;
  readonly known: number;

  constructor(path: string, version: number, known: number) {
    super(
      `${path} is at schema version ${String(version)}, but this Lantern knows ` +
        `${String(known)}: it was written by a newer Lantern. Upgrade Lantern, or start ` +
        'this one with another data directory.',
    );
    this.name = 'InstallSchemaTooNewError';
    this.version = version;
    this.known = known;
  }
}

export interface InstallStoreDeps {
  readonly boot: BootIdentity;
  readonly log: StoreLog;
}

/** Internal knobs; production passes none. Tests use them to migrate across versions. */
export interface OpenInstallOptions {
  readonly steps?: readonly MigrationStep[];
  readonly seams?: SnapshotSeams;
  /** Epoch milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
  /** When this machine booted, in epoch milliseconds; defaults to `now() - os.uptime()`. */
  readonly bootedAt?: number;
}

/** The store, and what opening it did (for `lantern migrate`). */
export interface OpenedInstall {
  readonly store: InstallStore;
  readonly migration: DatabaseMigration;
}

/** Opens and migrates the install database, then writes this process's lease row. */
export async function openInstallStore(
  dataDir: string,
  deps: InstallStoreDeps,
): Promise<InstallStore> {
  return (await openInstall(dataDir, deps)).store;
}

export async function openInstall(
  dataDir: string,
  deps: InstallStoreDeps,
  options: OpenInstallOptions = {},
): Promise<OpenedInstall> {
  const { boot, log } = deps;
  const steps = options.steps ?? INSTALL_STEPS;
  const now = options.now ?? Date.now;
  const paths = dataPaths(dataDir);
  const bootedAt = options.bootedAt ?? now() - uptime() * 1000;

  const probe = probeInstall(paths.installDb, steps.length);
  if (probe !== null) {
    if (probe.version > steps.length) {
      throw new InstallSchemaTooNewError(paths.installDb, probe.version, steps.length);
    }
    // Checked again when the row is written; this is so a foreign holder's
    // database is not migrated under it first.
    if (probe.lease !== null && leaseHeldElsewhere(probe.lease, boot, now(), bootedAt)) {
      throw new InstanceLockHeldError(dataDir, describeLease(probe.lease, now()));
    }
  }

  // After the refusals: a `.part` here may be a live holder's snapshot in progress.
  const swept = await sweepPartialSnapshots(paths.backups);
  if (swept > 0) {
    log.info('Removed partial snapshots left by an interrupted migration.', {
      directory: paths.backups,
      removed: swept,
    });
  }

  const { db, migration } = await openAndMigrate({
    path: paths.installDb,
    from: probe?.version ?? 0,
    steps,
    backupsDir: paths.backups,
    stem: 'lantern',
    label: 'lantern.db',
    log,
    ...(options.seams === undefined ? {} : { seams: options.seams }),
  });

  try {
    takeLease(db, dataDir, { boot, log, now: now(), bootedAt });
  } catch (error) {
    closeDatabase(db);
    throw error;
  }
  return { store: installStore(db, migration.to, boot, log, now), migration };
}

/**
 * The version and lease row of an existing file, read without writing; null
 * when there is no file. The lease is not read from a file newer than this
 * build (`known`): a newer schema may have reshaped the table, and the start
 * is refused for its version either way.
 */
function probeInstall(
  path: string,
  known: number,
): { version: number; lease: LeaseRow | null } | null {
  if (!existsSync(path)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = openToProbe(path);
    const version = readUserVersion(db);
    if (version > known) return { version, lease: null };
    const lease = tableExists(db, 'lease') ? readLease(db) : null;
    return { version, lease };
  } catch (error) {
    throw new StoreError(
      `${path} could not be read (${error instanceof Error ? error.message : String(error)}).`,
      { cause: error },
    );
  } finally {
    if (db !== null) closeDatabase(db);
  }
}

/**
 * Writes our row in one immediate transaction with the check, so two
 * processes that both got past the probe (only possible where the OS lock
 * does not reach) cannot both take it.
 */
function takeLease(
  db: DatabaseSync,
  dataDir: string,
  context: { boot: BootIdentity; log: StoreLog; now: number; bootedAt: number },
): void {
  const { boot, log, now, bootedAt } = context;
  const previous = inTransaction(db, () => {
    const existing = readLease(db);
    if (existing !== null && leaseHeldElsewhere(existing, boot, now, bootedAt)) {
      throw new InstanceLockHeldError(dataDir, describeLease(existing, now));
    }
    writeLease(db, boot, now);
    return existing;
  });
  if (previous !== null && previous.processId !== boot.processId) {
    log.warn('Took over the lease from a Lantern that did not shut down cleanly.', {
      previous: describeLease(previous, now),
      previousPid: previous.pid,
      previousHostname: previous.hostname,
    });
  }
}

function installStore(
  db: DatabaseSync,
  schemaVersion: number,
  boot: BootIdentity,
  log: StoreLog,
  now: () => number,
): InstallStore {
  let closed = false;
  let leaseLost = false;
  return {
    db,
    schemaVersion,
    heartbeat: () => {
      if (closed) return;
      // Called from a timer: a throw here would take the daemon down.
      try {
        if (touchLease(db, boot.processId, now())) {
          leaseLost = false;
          return;
        }
        if (!leaseLost) {
          leaseLost = true;
          const holder = readLease(db);
          log.error(
            'Another process has taken the lease on this data directory; two daemons may be sharing it.',
            { holder: holder === null ? null : describeLease(holder, now()) },
          );
        }
      } catch (error) {
        log.warn('Could not refresh the lease heartbeat.', errorFields(error));
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      // A clean shutdown leaves no row, so the next start has nothing to take over.
      try {
        releaseLease(db, boot.processId);
      } catch (error) {
        log.warn('Could not remove the lease row on shutdown.', errorFields(error));
      }
      closeDatabase(db);
    },
  };
}
