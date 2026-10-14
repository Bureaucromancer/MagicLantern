// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Snapshots before migrating (A20): when an existing database has pending
 * steps, a `VACUUM INTO` copy goes to the `backups/` folder beside it first,
 * on a worker thread (snapshot-worker.ts), so a migration that goes wrong
 * leaves a way back.
 *
 * Names are `<stem>.v<from version>.<ULID>.db`, so they sort by when they were
 * taken. A copy is written as `<name>.part` and renamed when complete; a
 * process killed mid-copy leaves only `.part` files, which the next open
 * sweeps.
 *
 * Retention, per database: the newest copy of each version, then the newest
 * three of those, and never the one just taken. One per version, so an
 * upgrade that fails part way and is retried (each retry snapshots the
 * version the last one stopped at) replaces its own copies rather than
 * pushing out the copy from before it began. Never the one just taken, so
 * copies whose ULIDs a clock that ran ahead put in the future cannot outrank
 * it and have it deleted the moment it is made.
 */

import { mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { ulid } from '../ids.js';
import { StoreError } from './errors.js';
import type { SnapshotOutcome, SnapshotTask } from './snapshot-worker.js';

/** How many completed snapshots of each database are kept: one per version, the newest versions. */
export const SNAPSHOTS_KEPT = 3;

/** Room left over after the copy, so a snapshot never fills the disk the migration then needs. */
export const SNAPSHOT_FREE_RESERVE_BYTES = 32 * 1024 * 1024;

const ULID_SOURCE = '[0-7][0-9A-HJKMNP-TV-Z]{25}';
const SNAPSHOT_NAME = new RegExp(`^([a-z][a-z0-9-]*)\\.v(\\d+)\\.(${ULID_SOURCE})\\.db$`);
const PARTIAL_NAME = new RegExp(
  `^[a-z][a-z0-9-]*\\.v\\d+\\.${ULID_SOURCE}\\.db\\.part(?:-journal|-wal|-shm)?$`,
);

/**
 * The worker's file, by the extension this module was loaded with: `.js` from
 * dist, `.ts` under vitest and tsx. Hard-coding `.js` fails every test, and
 * `.ts` every production snapshot (snapshot.dist.test.ts guards this).
 */
const WORKER_URL = new URL(
  `./snapshot-worker${extname(fileURLToPath(import.meta.url))}`,
  import.meta.url,
);

/**
 * The worker's flags: this one, and none of the daemon's. Node refuses a
 * worker whose `execArgv` names a V8 or process-wide flag
 * (`--max-old-space-size`, `--stack-size`) with ERR_WORKER_INVALID_EXEC_ARGV,
 * so inheriting `process.execArgv` would make every snapshot fail for an
 * operator who raised the heap. The worker loads only built-ins, so it needs
 * no loader flag either.
 */
const WORKER_EXEC_ARGV = ['--disable-warning=ExperimentalWarning'];

/**
 * Runs one task on a worker thread of its own. Rejects only when the worker
 * itself failed (could not load, crashed, exited without answering); a
 * SQLite error comes back resolved as `{ ok: false }`.
 */
export function runInWorker(
  task: SnapshotTask,
  script: URL = WORKER_URL,
): Promise<SnapshotOutcome> {
  return new Promise((resolve, reject) => {
    let answered = false;
    const worker = new Worker(script, {
      workerData: { snapshotTask: task },
      execArgv: WORKER_EXEC_ARGV,
    });
    worker.once('message', (outcome: SnapshotOutcome) => {
      answered = true;
      resolve(outcome);
    });
    worker.once('error', reject);
    // Node delivers everything a worker posted before it reports the exit, so
    // an exit with no answer is a worker that never gave one.
    worker.once('exit', (code) => {
      if (!answered) {
        reject(new Error(`The snapshot worker exited (${String(code)}) without answering.`));
      }
    });
  });
}

/** Free bytes for an unprivileged writer, or null when the filesystem will not say. */
export async function freeBytes(path: string): Promise<number | null> {
  try {
    const facts = await statfs(path);
    return facts.bsize * facts.bavail;
  } catch {
    return null;
  }
}

/**
 * No snapshot, so no migration. The message names absolute paths and is for
 * the log and the CLI; `kind` lets a caller say it in its own words elsewhere.
 */
export class SnapshotError extends StoreError {
  readonly kind: 'no-room' | 'failed';

  constructor(kind: 'no-room' | 'failed', message: string) {
    super(message);
    this.name = 'SnapshotError';
    this.kind = kind;
  }
}

export interface SnapshotRequest {
  /** The database file to copy. */
  readonly source: string;
  /** Where this database's snapshots live (created if missing). */
  readonly backupsDir: string;
  /** The names' stem, `lantern` or `library`; retention counts per stem. */
  readonly stem: string;
  /** The schema version being migrated from, recorded in the name. */
  readonly fromVersion: number;
}

/** Test seams; everything else takes the defaults. */
export interface SnapshotSeams {
  readonly run?: (task: SnapshotTask) => Promise<SnapshotOutcome>;
  readonly freeBytes?: (path: string) => Promise<number | null>;
}

/**
 * Takes a snapshot and answers its path, then prunes this stem's snapshots to
 * {@link SNAPSHOTS_KEPT}, keeping the new one whatever the others' names say. Throws {@link SnapshotError} when there is
 * no room or SQLite cannot copy the file; nothing is left behind either way.
 */
export async function takeSnapshot(
  request: SnapshotRequest,
  seams: SnapshotSeams = {},
): Promise<string> {
  const { source, backupsDir, stem, fromVersion } = request;
  await mkdir(backupsDir, { recursive: true });
  await assertRoom(source, backupsDir, seams.freeBytes ?? freeBytes);

  const target = join(backupsDir, `${stem}.v${String(fromVersion)}.${ulid()}.db`);
  const partial = `${target}.part`;
  let outcome: SnapshotOutcome;
  try {
    outcome = await (seams.run ?? runInWorker)({ source, target: partial });
  } catch (error) {
    await removePartial(partial);
    throw error;
  }
  if (!outcome.ok) {
    await removePartial(partial);
    throw new SnapshotError(
      'failed',
      `Could not snapshot ${source} before migrating it: ${outcome.message}`,
    );
  }
  await rename(partial, target);
  await pruneSnapshots(backupsDir, stem, SNAPSHOTS_KEPT, basename(target));
  return target;
}

/**
 * The copy is at most the database plus its log; a filesystem that will not
 * report free space is not a refusal, since most of them have room.
 */
async function assertRoom(
  source: string,
  backupsDir: string,
  free: (path: string) => Promise<number | null>,
): Promise<void> {
  const available = await free(backupsDir);
  if (available === null) return;
  const needed =
    (await sizeOf(source)) + (await sizeOf(`${source}-wal`)) + SNAPSHOT_FREE_RESERVE_BYTES;
  if (available < needed) {
    throw new SnapshotError(
      'no-room',
      `Not enough free space in ${backupsDir} to snapshot ${source} before migrating it ` +
        `(about ${megabytes(needed)} needed, ${megabytes(available)} free).`,
    );
  }
}

/**
 * Prunes this stem's completed snapshots: all but the newest of each version,
 * then all but the newest `keep` of those. `protect` (a name in `backupsDir`,
 * the snapshot just taken) is kept and counts as the newest, whatever its
 * ULID says. Answers what it removed.
 */
export async function pruneSnapshots(
  backupsDir: string,
  stem: string,
  keep: number,
  protect?: string,
): Promise<string[]> {
  const ours = (await listNames(backupsDir))
    .map((name) => ({ name, match: SNAPSHOT_NAME.exec(name) }))
    .filter((entry) => entry.match?.[1] === stem)
    .map((entry) => ({
      name: entry.name,
      version: Number(entry.match?.[2]),
      id: entry.match?.[3] ?? '',
    }))
    // Newest first by the ULID, not the whole name: v10 sorts before v2 as text.
    .sort((a, b) => (a.name === protect ? -1 : b.name === protect ? 1 : compareIds(b.id, a.id)));

  const versions = new Set<number>();
  const kept = new Set<string>();
  for (const { name, version } of ours) {
    if (versions.has(version) || kept.size >= keep) continue;
    versions.add(version);
    kept.add(name);
  }

  const removed: string[] = [];
  for (const { name } of ours) {
    if (kept.has(name)) continue;
    const path = join(backupsDir, name);
    await rm(path, { force: true });
    removed.push(path);
  }
  return removed;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Removes what a snapshot killed part way left behind: only `.part` names this
 * module makes, matched whole. Answers how many it removed, for the log.
 */
export async function sweepPartialSnapshots(backupsDir: string): Promise<number> {
  let removed = 0;
  for (const name of await listNames(backupsDir)) {
    if (!PARTIAL_NAME.test(name)) continue;
    await rm(join(backupsDir, name), { force: true });
    removed += 1;
  }
  return removed;
}

async function removePartial(partial: string): Promise<void> {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    await rm(`${partial}${suffix}`, { force: true });
  }
}

async function listNames(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

function megabytes(bytes: number): string {
  return `${String(Math.ceil(bytes / (1024 * 1024)))} MB`;
}
