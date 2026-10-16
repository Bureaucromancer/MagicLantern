// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The job store's reads and writes over `library.db` (A18), and the spool
 * (A17). `LocalLibrary` delegates its `JobStore` methods here.
 *
 * Transitions are compare-and-set: `update … where id = ? and state in (…)`,
 * with the payload columns in the same transaction, so two writers (a poll
 * and a cancel) can never both move a job, and the loser learns it did not.
 *
 * The spool is `incoming/<job>/`: each output as `output-<index>.bin`, then
 * `result.json` naming them with their hashes, written last. A spool without
 * `result.json`, or whose files do not match it, was cut off and does not
 * count: a resumable job then asks the backend again.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import type { GenerationRequest, SourceRect } from '@bureaucromancer/lantern-schema';

import { readIfPresent, spoolPath, writeDurably } from './asset-files.js';
import { inTransaction, numberColumn, textColumn } from './db.js';
import { getJobRow, JOB_COLUMNS, jobFromRow, jsonColumn, toJson } from './library-queries.js';
import type {
  FinishedJobInput,
  JobChange,
  JobFilter,
  JobPageRecord,
  JobPayloads,
  JobRecord,
  JobState,
  NewJob,
  SpooledResult,
} from './library-types.js';
import type { LibraryPaths } from './paths.js';

export function insertQueuedJob(db: DatabaseSync, job: NewJob): void {
  inTransaction(db, () => {
    db.prepare(
      `insert into jobs (id, parent_id, client_id, end_user, collection, idempotency_key,
         priority, queue_rank, state, model_id, route_id, route_snapshot, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    ).run(
      job.id,
      job.parentId ?? null,
      job.clientId ?? null,
      job.endUser ?? null,
      job.collection ?? null,
      job.idempotencyKey ?? null,
      job.priority ?? 0,
      job.queueRank ?? null,
      job.modelId,
      job.routeId ?? null,
      toJson(job.routeSnapshot),
      job.createdAt,
      job.createdAt,
    );
    db.prepare(
      'insert into job_payloads (job_id, canonical, effective, field_report) values (?, ?, ?, ?)',
    ).run(job.id, JSON.stringify(job.canonical), toJson(job.effective), toJson(job.fieldReport));
    db.prepare(
      'insert into job_prompts (job_id, positive, negative) values (?, ?, ?) on conflict (job_id) do nothing',
    ).run(job.id, job.canonical.prompt.positive, job.canonical.prompt.negative ?? '');
    writeInputs(db, job.id, job.inputs ?? []);
  });
}

/** Replaces a job's inputs. Inside a transaction. */
export function writeInputs(
  db: DatabaseSync,
  jobId: string,
  inputs: readonly FinishedJobInput[],
): void {
  db.prepare('delete from job_inputs where job_id = ?').run(jobId);
  const insert = db.prepare(
    `insert into job_inputs (job_id, position, asset_id, role, weight, region, crop, source_library)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const input of inputs) {
    insert.run(
      jobId,
      input.position,
      input.assetId,
      input.role,
      input.weight ?? null,
      toJson(input.region),
      toJson(input.crop),
      input.sourceLibrary ?? null,
    );
  }
}

export function readInputs(db: DatabaseSync, jobId: string): FinishedJobInput[] {
  return db
    .prepare(
      'select position, asset_id, role, weight, region, crop, source_library from job_inputs where job_id = ? order by position',
    )
    .all(jobId)
    .map((row) => {
      const weight = row['weight'];
      const region = jsonColumn(row, 'region');
      const crop = jsonColumn(row, 'crop');
      const source = row['source_library'];
      return {
        position: numberColumn(row, 'position'),
        assetId: textColumn(row, 'asset_id'),
        role: textColumn(row, 'role'),
        ...(typeof weight === 'number' ? { weight } : {}),
        ...(region === null ? {} : { region: region as SourceRect }),
        ...(crop === null ? {} : { crop: crop as SourceRect }),
        ...(typeof source === 'string' ? { sourceLibrary: source } : {}),
      };
    });
}

export function readPayloads(db: DatabaseSync, jobId: string): JobPayloads | undefined {
  const row = db
    .prepare(
      'select canonical, effective, field_report, wire, backend_response from job_payloads where job_id = ?',
    )
    .get(jobId);
  if (row === undefined) return undefined;
  return {
    canonical: jsonColumn(row, 'canonical') as GenerationRequest,
    effective: jsonColumn(row, 'effective') as GenerationRequest | null,
    fieldReport: jsonColumn(row, 'field_report'),
    wire: jsonColumn(row, 'wire'),
    backendResponse: jsonColumn(row, 'backend_response'),
  };
}

export function findByIdempotencyKey(
  db: DatabaseSync,
  clientId: string | null,
  key: string,
): JobRecord | undefined {
  const row = db
    .prepare(
      `select ${JOB_COLUMNS} from jobs where coalesce(client_id, '') = ? and idempotency_key = ?`,
    )
    .get(clientId ?? '', key);
  return row === undefined ? undefined : jobFromRow(row);
}

export function listJobRows(db: DatabaseSync, filter: JobFilter): JobPageRecord {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (filter.state === 'live') where.push("state <> 'finished'");
  if (filter.state === 'finished') where.push("state = 'finished'");
  if (filter.after !== undefined) {
    where.push('(created_at, id) < (?, ?)');
    params.push(filter.after.createdAt, filter.after.id);
  }
  const rows = db
    .prepare(
      `select ${JOB_COLUMNS} from jobs ${where.length === 0 ? '' : `where ${where.join(' and ')}`}
       order by created_at desc, id desc limit ?`,
    )
    .all(...params, filter.limit + 1);
  const jobs = rows.slice(0, filter.limit).map(jobFromRow);
  const last = jobs.at(-1);
  return {
    jobs,
    next:
      rows.length > filter.limit && last !== undefined
        ? { createdAt: last.createdAt, id: last.id }
        : null,
  };
}

/** The `jobs` columns a change may set, by its field name. */
const JOB_FIELDS: readonly (readonly [keyof JobChange, string, 'json' | 'plain'])[] = [
  ['state', 'state', 'plain'],
  ['blockedReason', 'blocked_reason', 'json'],
  ['outcome', 'outcome', 'plain'],
  ['outcomeReason', 'outcome_reason', 'plain'],
  ['routeId', 'route_id', 'plain'],
  ['routeSnapshot', 'route_snapshot', 'json'],
  ['backendHandle', 'backend_handle', 'json'],
  ['progress', 'progress', 'json'],
  ['priority', 'priority', 'plain'],
  ['startedAt', 'started_at', 'plain'],
  ['finishedAt', 'finished_at', 'plain'],
];

const PAYLOAD_FIELDS: readonly (readonly [keyof JobChange, string])[] = [
  ['effective', 'effective'],
  ['fieldReport', 'field_report'],
  ['wire', 'wire'],
  ['backendResponse', 'backend_response'],
];

function sqlValue(value: unknown, kind: 'json' | 'plain'): SQLInputValue {
  if (kind === 'json') return toJson(value);
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  throw new TypeError(`Not a column value: ${typeof value}.`);
}

export function transitionJob(
  db: DatabaseSync,
  id: string,
  from: readonly JobState[],
  change: JobChange,
  now: number,
): JobRecord | undefined {
  if (from.length === 0) throw new TypeError('A transition names the states it leaves from.');
  const sets = ['updated_at = ?'];
  const values: SQLInputValue[] = [now];
  for (const [field, column, kind] of JOB_FIELDS) {
    if (!(field in change)) continue;
    sets.push(`${column} = ?`);
    values.push(sqlValue(change[field], kind));
  }
  const payloadSets: string[] = [];
  const payloadValues: SQLInputValue[] = [];
  for (const [field, column] of PAYLOAD_FIELDS) {
    if (!(field in change)) continue;
    payloadSets.push(`${column} = ?`);
    payloadValues.push(toJson(change[field]));
  }
  const changed = inTransaction(db, () => {
    const result = db
      .prepare(
        `update jobs set ${sets.join(', ')}
         where id = ? and state in (select value from json_each(?))`,
      )
      .run(...values, id, JSON.stringify(from));
    if (result.changes === 0) return false;
    if (payloadSets.length > 0) {
      db.prepare(`update job_payloads set ${payloadSets.join(', ')} where job_id = ?`).run(
        ...payloadValues,
        id,
      );
    }
    return true;
  });
  return changed ? getJobRow(db, id) : undefined;
}

// ---------------------------------------------------------------------------
// The spool (A17)
// ---------------------------------------------------------------------------

const RESULT_FILE = 'result.json';

interface SpoolManifest {
  readonly outputs: readonly { index: number; seed: number | null; file: string; sha256: string }[];
  readonly metadata: unknown;
  readonly generator?: string;
  readonly finished_at: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function writeSpool(
  paths: LibraryPaths,
  jobId: string,
  result: SpooledResult,
): Promise<void> {
  const directory = spoolPath(paths, jobId);
  const outputs: SpoolManifest['outputs'][number][] = [];
  for (const output of result.outputs) {
    const file = `output-${String(output.index)}.bin`;
    await writeDurably(join(directory, file), output.bytes);
    outputs.push({ index: output.index, seed: output.seed, file, sha256: sha256(output.bytes) });
  }
  const manifest: SpoolManifest = {
    outputs,
    metadata: result.metadata ?? null,
    ...(result.generator === undefined ? {} : { generator: result.generator }),
    finished_at: result.finishedAt,
  };
  // Last: its presence says the files before it are whole.
  await writeDurably(join(directory, RESULT_FILE), Buffer.from(JSON.stringify(manifest)));
}

export async function readSpool(paths: LibraryPaths, jobId: string): Promise<SpooledResult | null> {
  const directory = spoolPath(paths, jobId);
  const text = await readIfPresent(join(directory, RESULT_FILE));
  if (text === null) return null;
  let manifest: SpoolManifest;
  try {
    manifest = JSON.parse(text.toString('utf8')) as SpoolManifest;
  } catch {
    return null;
  }
  const outputs = [];
  for (const output of manifest.outputs) {
    if (!/^output-\d+\.bin$/.test(output.file)) return null;
    const bytes = await readIfPresent(join(directory, output.file));
    if (bytes === null || sha256(bytes) !== output.sha256) return null;
    outputs.push({ index: output.index, seed: output.seed, bytes });
  }
  return {
    outputs,
    metadata: manifest.metadata,
    ...(manifest.generator === undefined ? {} : { generator: manifest.generator }),
    finishedAt: manifest.finished_at,
  };
}

export async function clearSpool(paths: LibraryPaths, jobId: string): Promise<void> {
  await rm(spoolPath(paths, jobId), { recursive: true, force: true });
}

export async function spooledJobIds(paths: LibraryPaths): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(paths.incoming, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(join(paths.incoming, entry.name, RESULT_FILE));
      ids.push(entry.name);
    } catch {
      // Cut off before it was whole: not a spool.
    }
  }
  return ids.sort();
}
