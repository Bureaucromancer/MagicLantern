// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The half of snapshot.ts that blocks, on a thread of its own: `VACUUM INTO`
 * of a large library runs for seconds, and on the main thread those seconds
 * would be every request's. One worker per snapshot, started and finished
 * around it; nothing crosses the boundary but paths and a verdict.
 *
 * Self-contained, as a loading rule: this file imports `node:` built-ins and
 * nothing of ours. It is started by path, as `.js` from dist and as `.ts`
 * under vitest and tsx (Node strips the types itself), and Node's type
 * stripping does not rewrite a `./x.js` specifier to the `./x.ts` beside it.
 * snapshot.ts imports only types from here.
 */

import { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

export interface SnapshotTask {
  /** The database to copy, opened read-only. */
  readonly source: string;
  /** Where the copy goes; must not exist (VACUUM INTO refuses to overwrite). */
  readonly target: string;
}

/** A SQLite failure is an outcome; only a broken worker makes the caller reject. */
export type SnapshotOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** SQLite's own words, or the first of quick_check's complaints. */
      readonly message: string;
      /** SQLite's result code (possibly extended), or null when the check answered otherwise. */
      readonly errcode: number | null;
    };

/** Restated from db.ts, which this file may not import. */
const BUSY_TIMEOUT_MS = 5000;

function failure(error: unknown): SnapshotOutcome {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  return {
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    errcode: typeof errcode === 'number' ? errcode : null,
  };
}

/**
 * `VACUUM INTO` from a read-only connection: SQLite's locking gives the copy
 * one point in time, committed frames still in the source's `-wal` are in it,
 * and an open transaction elsewhere is not. The target is bound, not spliced,
 * so no path needs quoting. The copy is then checked: a snapshot nobody can
 * restore from is worse than none, because it is trusted.
 */
export function vacuumInto(task: SnapshotTask): SnapshotOutcome {
  let source: DatabaseSync | null = null;
  let copy: DatabaseSync | null = null;
  try {
    source = new DatabaseSync(task.source, { readOnly: true });
    source.exec(`pragma busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
    source.prepare('vacuum into ?').run(task.target);
    source.close();
    source = null;

    // The copy is in rollback-journal mode, so a read-only open makes no side files.
    copy = new DatabaseSync(task.target, { readOnly: true });
    const verdicts = copy
      .prepare('pragma quick_check')
      .all()
      .map((row) => String(row['quick_check']));
    if (verdicts.length !== 1 || verdicts[0] !== 'ok') {
      return { ok: false, message: verdicts.slice(0, 3).join('; '), errcode: null };
    }
    return { ok: true };
  } catch (error) {
    return failure(error);
  } finally {
    source?.close();
    copy?.close();
  }
}

/**
 * Only when started as this worker, with a task: vitest can run a test file
 * on a worker thread of its own, where `isMainThread` is false and
 * `parentPort` is vitest's, and a module that posted on import would answer a
 * question nobody asked.
 */
const task = (workerData as { snapshotTask?: SnapshotTask } | null)?.snapshotTask;
if (!isMainThread && parentPort !== null && task !== undefined) {
  parentPort.postMessage(vacuumInto(task));
}
