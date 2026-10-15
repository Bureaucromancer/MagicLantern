// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `lantern library backup` (ST6, A23): a copy of a library that can be
 * opened on its own, taken safely while the daemon runs.
 *
 * Copying the folder is not safe while its WAL is live: the copy of
 * `library.db` can miss committed transactions still in `-wal`, or catch a
 * checkpoint half written. So the database is copied with `VACUUM INTO` (on a
 * worker thread, as migration snapshots are), which gives one point in time,
 * and then exactly the asset files that copy says are present are copied.
 * Assets are immutable files named by their hash, so copying them while the
 * daemon runs is safe; one deleted between the two steps is marked trashed in
 * the copy, so the backup never claims bytes it does not hold. Thumbnails are
 * left out (they are rebuilt), and so are migration snapshots; the spool of
 * results not yet ingested is kept.
 *
 * Read-only throughout on the live data: the install database and the
 * library are opened read-only and no lock is taken, so it runs beside a
 * serving daemon. The backup is built in `<id>.part` and renamed when whole.
 */

import { cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { assetPath } from './asset-files.js';
import {
  closeDatabase,
  openDatabase,
  openToProbe,
  readUserVersion,
  tableExists,
  textColumn,
} from './db.js';
import { StoreError } from './errors.js';
import { INSTALL_SCHEMA_VERSION } from './migrations.js';
import { dataPaths, libraryPaths, libraryPathsAt } from './paths.js';
import { runInWorker, type SnapshotSeams } from './snapshot.js';

export interface BackupRequest {
  readonly dataDir: string;
  /** Absolute; each library goes in `<out>/<library id>/`. */
  readonly out: string;
  /** One library by id; every registered library when absent. */
  readonly library?: string;
  /** Test seam for the VACUUM INTO worker. */
  readonly seams?: Pick<SnapshotSeams, 'run'>;
}

export type BackupOutcome =
  | {
      readonly ok: true;
      readonly id: string;
      readonly name: string;
      readonly path: string;
      readonly assets: number;
      readonly bytes: number;
      /** Assets deleted while the backup ran, marked trashed in the copy. */
      readonly missing: number;
    }
  | { readonly ok: false; readonly id: string; readonly name: string; readonly reason: string };

interface RegisteredLibrary {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

/** The registry, read without writing or locking anything. */
function readRegistry(dataDir: string): RegisteredLibrary[] {
  const { installDb } = dataPaths(dataDir);
  let db;
  try {
    db = openToProbe(installDb);
  } catch (error) {
    throw new StoreError(
      `There is no Lantern data directory at ${dataDir} (${installDb} could not be opened).`,
      { cause: error },
    );
  }
  try {
    const version = readUserVersion(db);
    if (version > INSTALL_SCHEMA_VERSION) {
      throw new StoreError(
        `${installDb} was written by a newer Lantern (schema ${String(version)}); back it up with that one.`,
      );
    }
    if (!tableExists(db, 'libraries')) {
      throw new StoreError(`There is no Lantern data directory at ${dataDir}.`);
    }
    return db
      .prepare('select id, name, path from libraries order by created_at, id')
      .all()
      .map((row) => ({
        id: textColumn(row, 'id'),
        name: textColumn(row, 'name'),
        path: textColumn(row, 'path'),
      }));
  } finally {
    closeDatabase(db);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Backs up one library or every library, one at a time. A library that
 * cannot be backed up is reported and the rest go on; a request that cannot
 * start at all (no data directory, an unknown library) throws `StoreError`.
 */
export async function backupLibraries(request: BackupRequest): Promise<BackupOutcome[]> {
  const registered = readRegistry(request.dataDir);
  const chosen =
    request.library === undefined
      ? registered
      : registered.filter((library) => library.id === request.library);
  if (request.library !== undefined && chosen.length === 0) {
    throw new StoreError(`No library has the id ${request.library}.`);
  }
  await mkdir(request.out, { recursive: true });
  const outcomes: BackupOutcome[] = [];
  for (const library of chosen) outcomes.push(await backupOne(request, library));
  return outcomes;
}

async function backupOne(
  request: BackupRequest,
  library: RegisteredLibrary,
): Promise<BackupOutcome> {
  const { id, name } = library;
  const failed = (reason: string): BackupOutcome => ({ ok: false, id, name, reason });

  let source;
  try {
    source = libraryPaths(request.dataDir, library.path);
  } catch {
    return failed(`Its registered folder "${library.path}" is not inside the data directory.`);
  }
  if (!(await exists(source.db)))
    return failed(`Its database ${library.path}/library.db was not found.`);

  const target = join(request.out, id);
  if (await exists(target)) {
    return failed(`${target} already exists; choose another --out, or move it away.`);
  }
  const partial = `${target}.part`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });
  const copy = libraryPathsAt(partial);

  try {
    const outcome = await (request.seams?.run ?? runInWorker)({
      source: source.db,
      target: copy.db,
    });
    if (!outcome.ok) {
      return await abandon(partial, failed(`Its database could not be copied: ${outcome.message}`));
    }

    if (await exists(source.manifest)) await cp(source.manifest, copy.manifest);
    if (await exists(source.incoming))
      await cp(source.incoming, copy.incoming, { recursive: true });

    // The copy is ours: its rows decide which files go, and record any that vanished.
    const db = openDatabase(copy.db);
    let assets = 0;
    let bytes = 0;
    let missing = 0;
    try {
      const present = tableExists(db, 'assets')
        ? db
            .prepare("select id, media_type from assets where bytes_state = 'present'")
            .all()
            .map((row) => ({ id: textColumn(row, 'id'), mediaType: textColumn(row, 'media_type') }))
        : [];
      const trash = db.prepare("update assets set bytes_state = 'trashed' where id = ?");
      for (const asset of present) {
        const from = assetPath(source, asset.id, asset.mediaType);
        const to = assetPath(copy, asset.id, asset.mediaType);
        try {
          await mkdir(join(to, '..'), { recursive: true });
          await cp(from, to, { errorOnExist: true, force: false });
          assets += 1;
          bytes += (await stat(to)).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          trash.run(asset.id);
          missing += 1;
        }
      }
      // The copy is a rollback-journal file; leave it that way, with nothing beside it.
      db.exec('pragma journal_mode = delete');
    } finally {
      closeDatabase(db);
    }
    await rename(partial, target);
    return { ok: true, id, name, path: target, assets, bytes, missing };
  } catch (error) {
    return await abandon(
      partial,
      failed(`It could not be copied (${error instanceof Error ? error.message : String(error)}).`),
    );
  }
}

async function abandon(partial: string, outcome: BackupOutcome): Promise<BackupOutcome> {
  await rm(partial, { recursive: true, force: true });
  return outcome;
}
