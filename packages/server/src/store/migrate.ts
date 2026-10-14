// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `lantern migrate`: the same open-and-migrate path the daemon runs at
 * startup (install database, lease, every library, the default one if there
 * are none), without serving, reporting what changed. Everything is closed
 * again before it returns, the lease row included. The caller holds the
 * instance lock.
 *
 * The lease is heartbeated while the libraries open, as serve does: a library
 * snapshot can outlast the lease's staleness window, and a daemon on another
 * host (where the OS lock does not reach) would otherwise take the data
 * directory over mid-migration.
 */

import { openInstall } from './install.js';
import { LEASE_HEARTBEAT_MS } from './lease.js';
import { openLibraries } from './libraries.js';
import type { LibraryOptions } from './library.js';
import type { BootIdentity, MigrationReport, StoreLog } from './types.js';

/** Internal knobs; production passes none. */
export interface MigrateAllOptions {
  /** How often the lease is refreshed while the libraries open; defaults to {@link LEASE_HEARTBEAT_MS}. */
  readonly heartbeatMs?: number;
  /** Passed to every library as it opens (tests migrate across versions with it). */
  readonly libraries?: LibraryOptions;
}

export async function migrateAll(
  dataDir: string,
  deps: { boot: BootIdentity; log: StoreLog },
  options: MigrateAllOptions = {},
): Promise<MigrationReport> {
  const { store, migration } = await openInstall(dataDir, deps);
  try {
    // heartbeat() never throws; it logs a failure itself.
    const beat = setInterval(() => {
      store.heartbeat();
    }, options.heartbeatMs ?? LEASE_HEARTBEAT_MS);
    beat.unref();
    let opened;
    try {
      opened = await openLibraries(store, dataDir, { log: deps.log }, options.libraries);
    } finally {
      clearInterval(beat);
    }
    const { registry, migrations } = opened;
    const libraries = registry
      .list()
      .map((record) => ({ ...record, migration: migrations.get(record.id) ?? null }));
    registry.close();
    return { install: migration, libraries };
  } finally {
    store.close();
  }
}
