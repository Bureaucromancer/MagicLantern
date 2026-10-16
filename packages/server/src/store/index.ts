// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The store: everything that touches the data directory. Code outside
 * `store/`, `config/` and `cli/` may not import fs (lint enforces), so this is
 * the one place paths into user data are built and checked.
 *
 * Startup order, for serve and migrate alike: resolve config → writable-dir
 * check → instance lock (held by the CLI entry) → open/migrate the install DB →
 * write the lease row → open/migrate libraries (creating the default one if
 * none) → (serve) build the app → listen.
 */

export { writeFileAtomic, writeJsonAtomic, type AtomicWriteOptions } from './atomic.js';
export {
  BackendStore,
  canonicalText,
  type BackendRow,
  type BackendRowSource,
  type BackendRowStatus,
  type ModelRow,
  type RouteRow,
  type RouteRowHealth,
  type RouteRowLoadState,
} from './backends.js';
export { readMachineBootId } from './boot.js';
export { StoreError } from './errors.js';
export { DataDirError, ensureWritableDataDir } from './files.js';
export { InstallSchemaTooNewError, openInstallStore } from './install.js';
export { LEASE_HEARTBEAT_MS } from './lease.js';
export { openLibraryRegistry } from './libraries.js';
export {
  AssetUnavailableError,
  LibraryReadOnlyError,
  type AssetBytes,
  type AssetFilter,
  type AssetPageRecord,
  type AssetRecord,
  type FinishedJob,
  type FinishedJobInput,
  type FinishedJobOutput,
  type ImportedJob,
  type JobChange,
  type JobFilter,
  type JobPageRecord,
  type JobPayloads,
  type JobOutcome,
  type JobRecord,
  type JobState,
  type JobStore,
  type Library,
  type LineageRecord,
  type NewJob,
  type OutputOf,
  type ProvenanceRecord,
  type SpooledResult,
  type StoredAsset,
  type UsageRecord,
} from './library-types.js';
export { IngestError, LocalLibrary } from './local-library.js';
export { cropPixels, ImageRefusedError, MAX_INPUT_PIXELS, THUMBNAIL_MEDIA_TYPE } from './media.js';
export { acquireInstanceLock, InstanceLockHeldError } from './lock.js';
export { migrateAll } from './migrate.js';
export {
  INSTALL_SCHEMA_VERSION,
  LIBRARY_MIN_READER,
  LIBRARY_SCHEMA_VERSION,
} from './migrations.js';
export { MigrationFailedError } from './upgrade.js';
export {
  CONFIG_FILE_NAME,
  DATA_LAYOUT,
  dataPaths,
  defaultConfigPath,
  defaultDataDir,
  libraryPaths,
  libraryRelativePath,
  type DataPaths,
  type LibraryPaths,
  type PlatformContext,
} from './paths.js';
export { LibraryNameTakenError } from './types.js';
export type {
  BootIdentity,
  DatabaseMigration,
  InstallStore,
  InstanceLock,
  LibraryRecord,
  LibraryRegistry,
  MigrationReport,
  StoreLog,
} from './types.js';
