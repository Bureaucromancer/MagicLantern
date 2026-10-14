// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The schemas, as append-only migration steps (see db.ts for the runner).
 *
 * Rules for every new step: append, never edit a shipped one; never drop a
 * table that holds data (a rebuild copies it, with `foreignKeysOff`); mark
 * `breaksOlderReaders` when a build that knows only earlier versions could no
 * longer read the result; and write its test at the version it leaves from,
 * with real rows, asserting every column carried over.
 *
 * Conventions: tables are `strict`; ids are text primary keys; timestamps are
 * `real` epoch milliseconds; JSON goes in text columns. Schema SQL lives here
 * rather than in .sql files so nothing has to be copied into dist.
 */

import { minReaderFor, type MigrationStep } from './db.js';

/** `lantern.db`: the library registry and the lease; backends, models and routes later. */
export const INSTALL_STEPS: readonly MigrationStep[] = [
  {
    sql: `
-- The library registry. path is relative to the data directory and
-- '/'-separated (A21), so a data directory can move between machines.
create table libraries (
  id              text primary key,
  name            text not null,
  path            text not null unique,
  created_at      real not null,
  last_opened_at  real
) strict;

-- Who holds the data directory: one row, informational beside the OS lock on
-- lantern.lock, which is the authority. It lets a refusal name the holder,
-- and is the only cross-host signal on filesystems where the lock is not.
create table lease (
  id               integer primary key check (id = 1),
  pid              integer not null,
  process_id       text not null,
  machine_boot_id  text not null,
  hostname         text not null,
  started_at       real not null,
  heartbeat_at     real not null
) strict;
`,
  },
];

/** The install schema this build writes. A newer `lantern.db` refuses to start (A20). */
export const INSTALL_SCHEMA_VERSION = INSTALL_STEPS.length;

/** `library.db`: one library's jobs, assets and provenance from later phases. */
export const LIBRARY_STEPS: readonly MigrationStep[] = [
  {
    sql: `
-- Facts about the library itself. 'min_reader' is written by the opener in
-- each step's transaction, so it always matches user_version even when
-- library.json is stale or missing.
create table meta (
  key    text primary key,
  value  text not null
) strict;
`,
  },
];

/** The library schema this build writes. */
export const LIBRARY_SCHEMA_VERSION = LIBRARY_STEPS.length;

/** The oldest library schema a reader must know to open a library this build writes. */
export const LIBRARY_MIN_READER = minReaderFor(LIBRARY_STEPS);

/** The `meta` key holding a library's `min_reader`. */
export const MIN_READER_KEY = 'min_reader';
