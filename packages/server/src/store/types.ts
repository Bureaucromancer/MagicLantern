// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The store's public shapes. The CLI and the HTTP layer depend on these, so
 * their signatures are fixed; the implementations live beside them.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { LibraryStatus } from '@bureaucromancer/lantern-schema';

import type { JobStore, Library } from './library-types.js';

/**
 * Where store code reports what it did. The serve path adapts Fastify's pino
 * logger (logging.ts `storeLogFrom`); CLI commands print lines
 * (`consoleStoreLog`). Fields are structured context; the message is a sentence.
 */
export interface StoreLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Who holds the data directory, recorded in the lease row. The machine boot id
 * tells a reused pid after a reboot from a live one; `processId` is a fresh
 * random id per process (`newId('proc')`), which pids are not.
 */
export interface BootIdentity {
  readonly machineBootId: string;
  readonly hostname: string;
  readonly pid: number;
  readonly processId: string;
}

/**
 * The OS-level lock on `<data>/lantern.lock`. Held for the life of the
 * process by the CLI entry, released last on shutdown.
 */
export interface InstanceLock {
  release(): void;
}

/** `lantern.db`, open and migrated, with this process's lease row written. */
export interface InstallStore {
  readonly db: DatabaseSync;
  /** The database's `user_version` after migration. */
  readonly schemaVersion: number;
  /** Refreshes the lease row's `heartbeat_at`; serve calls it every 15 s. */
  heartbeat(): void;
  /** Idempotent. */
  close(): void;
}

/** One registered library as the daemon sees it this run. */
export interface LibraryRecord {
  readonly id: string;
  readonly name: string;
  /** Relative to the data directory, `/`-separated (A21). */
  readonly path: string;
  readonly status: LibraryStatus;
  /** Why the library is read-only or unavailable, as a sentence. */
  readonly reason?: string;
  /** `library.db`'s `user_version`, or null when it could not be read. */
  readonly schemaVersion: number | null;
}

/**
 * The libraries: those opened at startup, and those created since. A failed
 * library is listed as unavailable, never thrown.
 */
export interface LibraryRegistry {
  list(): LibraryRecord[];
  get(id: string): LibraryRecord | undefined;
  /** The library's assets and provenance; undefined unless it is `ok` or `read-only`. */
  library(id: string): Library | undefined;
  /** Its live jobs; undefined unless it is `ok` (a read-only library runs nothing). */
  jobs(id: string): JobStore | undefined;
  /**
   * Creates and registers an empty library, usable at once. Throws
   * {@link LibraryNameTakenError} when another library has the name.
   */
  create(name: string): Promise<LibraryRecord>;
  /**
   * Renames a library; undefined when there is no such library. Throws
   * {@link LibraryNameTakenError} when another library has the name.
   */
  rename(id: string, name: string): Promise<LibraryRecord | undefined>;
  /** Closes every library database. Idempotent. */
  close(): void;
}

/** Another library already has this name, compared without regard to case. */
export class LibraryNameTakenError extends Error {
  constructor(name: string) {
    super(`Another library is already called "${name}".`);
    this.name = 'LibraryNameTakenError';
  }
}

/** One database's migration outcome. */
export interface DatabaseMigration {
  readonly from: number;
  readonly to: number;
  /** The VACUUM INTO snapshot taken first, if the database had pending steps. */
  readonly snapshot: string | null;
}

/** What `lantern migrate` reports. */
export interface MigrationReport {
  readonly install: DatabaseMigration;
  readonly libraries: readonly (LibraryRecord & { readonly migration: DatabaseMigration | null })[];
}
