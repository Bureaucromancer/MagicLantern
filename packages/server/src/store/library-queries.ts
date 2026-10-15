// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The library database's reads: rows mapped to records, the asset query with
 * prompt search and a cursor (ST5), provenance, and the lineage view.
 *
 * Lineage is a view over `job_inputs` joined to `job_outputs` (parent asset →
 * job → child asset), plus `assets.derived_from` for crops. It is walked
 * with index lookups from the asset outwards, never by joining whole tables.
 */

import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';

import type { AssetOrigin, BytesState, Retention } from '@bureaucromancer/lantern-schema';

import { numberColumn, textColumn } from './db.js';
import type {
  AssetFilter,
  AssetPageRecord,
  AssetRecord,
  JobOutcome,
  JobRecord,
  JobState,
  LineageRecord,
  ProvenanceRecord,
} from './library-types.js';

type Row = Record<string, SQLOutputValue>;

function optionalText(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new TypeError(`Column ${column} is not text.`);
  return value;
}

function optionalNumber(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number') throw new TypeError(`Column ${column} is not a number.`);
  return value;
}

/** A JSON column, parsed; null stays null. */
export function jsonColumn(row: Row, column: string): unknown {
  const text = optionalText(row, column);
  return text === null ? null : (JSON.parse(text) as unknown);
}

/** JSON for a column; undefined and null are SQL null. */
export function toJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/**
 * The asset columns and the first job output that made each asset, as one
 * select list. The output is found by a correlated lookup on the
 * `job_outputs_asset` index, so a page of assets costs a page of lookups.
 */
export const ASSET_SELECT = `
  select a.id, a.media_type, a.bytes, a.width, a.height, a.frames, a.duration_ms,
         a.pixel_hash, a.pixel_hash_alg, a.origin, a.bytes_state, a.retention, a.rating,
         a.derived_from, a.derivation, a.created_at,
         o.job_id as out_job_id, o.output_index as out_index, o.seed as out_seed,
         j.model_id as out_model_id
  from assets a
  left join job_outputs o on o.rowid = (
    select o2.rowid from job_outputs o2 where o2.asset_id = a.id order by o2.job_id limit 1
  )
  left join jobs j on j.id = o.job_id`;

export function assetFromRow(row: Row): AssetRecord {
  const derivedFrom = optionalText(row, 'derived_from');
  const outJob = optionalText(row, 'out_job_id');
  return {
    id: textColumn(row, 'id'),
    mediaType: textColumn(row, 'media_type'),
    bytes: numberColumn(row, 'bytes'),
    width: optionalNumber(row, 'width'),
    height: optionalNumber(row, 'height'),
    frames: optionalNumber(row, 'frames'),
    durationMs: optionalNumber(row, 'duration_ms'),
    pixelHash: optionalText(row, 'pixel_hash'),
    pixelHashAlg: optionalText(row, 'pixel_hash_alg'),
    origin: textColumn(row, 'origin') as AssetOrigin,
    bytesState: textColumn(row, 'bytes_state') as BytesState,
    retention: textColumn(row, 'retention') as Retention,
    rating: optionalNumber(row, 'rating'),
    derivedFrom:
      derivedFrom === null
        ? null
        : { assetId: derivedFrom, operation: jsonColumn(row, 'derivation') },
    createdAt: numberColumn(row, 'created_at'),
    outputOf:
      outJob === null
        ? null
        : {
            jobId: outJob,
            index: numberColumn(row, 'out_index'),
            seed: optionalNumber(row, 'out_seed'),
            modelId: textColumn(row, 'out_model_id'),
          },
  };
}

export function getAssetRow(db: DatabaseSync, id: string): AssetRecord | undefined {
  const row = db.prepare(`${ASSET_SELECT} where a.id = ?`).get(id);
  return row === undefined ? undefined : assetFromRow(row);
}

export const JOB_COLUMNS = `id, parent_id, client_id, end_user, collection, idempotency_key,
  priority, queue_rank, state, blocked_reason, outcome, outcome_reason, model_id, route_id,
  route_snapshot, backend_handle, progress, created_at, updated_at, started_at, finished_at`;

export function jobFromRow(row: Row): JobRecord {
  return {
    id: textColumn(row, 'id'),
    parentId: optionalText(row, 'parent_id'),
    clientId: optionalText(row, 'client_id'),
    endUser: optionalText(row, 'end_user'),
    collection: optionalText(row, 'collection'),
    idempotencyKey: optionalText(row, 'idempotency_key'),
    priority: numberColumn(row, 'priority'),
    queueRank: optionalText(row, 'queue_rank'),
    state: textColumn(row, 'state') as JobState,
    blockedReason: jsonColumn(row, 'blocked_reason'),
    outcome: optionalText(row, 'outcome') as JobOutcome | null,
    outcomeReason: optionalText(row, 'outcome_reason'),
    modelId: textColumn(row, 'model_id'),
    routeId: optionalText(row, 'route_id'),
    routeSnapshot: jsonColumn(row, 'route_snapshot'),
    backendHandle: jsonColumn(row, 'backend_handle'),
    progress: jsonColumn(row, 'progress'),
    createdAt: numberColumn(row, 'created_at'),
    updatedAt: numberColumn(row, 'updated_at'),
    startedAt: optionalNumber(row, 'started_at'),
    finishedAt: optionalNumber(row, 'finished_at'),
  };
}

export function getJobRow(db: DatabaseSync, id: string): JobRecord | undefined {
  const row = db.prepare(`select ${JOB_COLUMNS} from jobs where id = ?`).get(id);
  return row === undefined ? undefined : jobFromRow(row);
}

// ---------------------------------------------------------------------------
// The asset query
// ---------------------------------------------------------------------------

/**
 * A person's search words as an FTS5 query: each word a quoted phrase (so
 * `"`, `*`, `-`, `AND` and parentheses are text, never syntax), all of them
 * required. Null when there are no words.
 */
export function ftsQuery(text: string): string | null {
  const words = text
    .split(/\s+/u)
    .map((word) => word.replaceAll('"', ''))
    .filter((word) => /[\p{L}\p{N}_]/u.test(word));
  if (words.length === 0) return null;
  return words.map((word) => `"${word}"`).join(' ');
}

/**
 * One page of present assets, newest first. The cursor is the position of the
 * previous page's last asset, `(created_at, id)`, so assets added meanwhile
 * land before it and never shift what comes after.
 */
export function queryAssetRows(db: DatabaseSync, filter: AssetFilter): AssetPageRecord {
  const where: string[] = ["a.bytes_state = 'present'"];
  const params: SQLInputValue[] = [];

  if (filter.origin !== undefined) {
    where.push('a.origin = ?');
    params.push(filter.origin);
  }
  if (filter.ratingMin !== undefined) {
    where.push('a.rating >= ?');
    params.push(filter.ratingMin);
  }
  if (filter.createdFrom !== undefined) {
    where.push('a.created_at >= ?');
    params.push(filter.createdFrom);
  }
  if (filter.createdBefore !== undefined) {
    where.push('a.created_at < ?');
    params.push(filter.createdBefore);
  }
  if (filter.after !== undefined) {
    where.push('(a.created_at, a.id) < (?, ?)');
    params.push(filter.after.createdAt, filter.after.id);
  }

  // Everything about the job that made the asset, as one existence check.
  const jobWhere: string[] = [];
  const jobParams: SQLInputValue[] = [];
  if (filter.modelId !== undefined) {
    jobWhere.push('j3.model_id = ?');
    jobParams.push(filter.modelId);
  }
  if (filter.routeId !== undefined) {
    jobWhere.push('j3.route_id = ?');
    jobParams.push(filter.routeId);
  }
  if (filter.collection !== undefined) {
    jobWhere.push('j3.collection = ?');
    jobParams.push(filter.collection);
  }
  if (filter.text !== undefined) {
    const match = ftsQuery(filter.text);
    // Words with no letters or digits match nothing, rather than everything.
    if (match === null) return { assets: [], next: null };
    jobWhere.push(
      'j3.id in (select p.job_id from prompts_fts f join job_prompts p on p.id = f.rowid where prompts_fts match ?)',
    );
    jobParams.push(match);
  }
  if (jobWhere.length > 0) {
    where.push(
      `exists (select 1 from job_outputs o3 join jobs j3 on j3.id = o3.job_id where o3.asset_id = a.id and ${jobWhere.join(' and ')})`,
    );
    params.push(...jobParams);
  }

  const rows = db
    .prepare(
      `${ASSET_SELECT} where ${where.join(' and ')} order by a.created_at desc, a.id desc limit ?`,
    )
    .all(...params, filter.limit + 1);
  const assets = rows.slice(0, filter.limit).map(assetFromRow);
  const last = assets.at(-1);
  return {
    assets,
    next:
      rows.length > filter.limit && last !== undefined
        ? { createdAt: last.createdAt, id: last.id }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export function provenanceRows(db: DatabaseSync, assetId: string): ProvenanceRecord | undefined {
  const asset = getAssetRow(db, assetId);
  if (asset === undefined) return undefined;
  const jobId = asset.outputOf?.jobId;
  const record = jobId === undefined ? undefined : getJobRow(db, jobId);
  if (record === undefined) return { asset, job: null };

  const payload = db
    .prepare(
      'select canonical, effective, field_report, wire, backend_response from job_payloads where job_id = ?',
    )
    .get(record.id);
  const inputs = db
    .prepare(
      'select position, asset_id, role, weight, region, crop, source_library from job_inputs where job_id = ? order by position',
    )
    .all(record.id)
    .map((row) => ({
      position: numberColumn(row, 'position'),
      assetId: textColumn(row, 'asset_id'),
      role: textColumn(row, 'role'),
      weight: optionalNumber(row, 'weight'),
      region: jsonColumn(row, 'region'),
      crop: jsonColumn(row, 'crop'),
      sourceLibrary: optionalText(row, 'source_library'),
    }));
  const outputs = db
    .prepare(
      'select output_index, asset_id, seed from job_outputs where job_id = ? order by output_index',
    )
    .all(record.id)
    .map((row) => ({
      index: numberColumn(row, 'output_index'),
      assetId: textColumn(row, 'asset_id'),
      seed: optionalNumber(row, 'seed'),
    }));

  return {
    asset,
    job: {
      record,
      canonical: payload === undefined ? null : jsonColumn(payload, 'canonical'),
      effective: payload === undefined ? null : jsonColumn(payload, 'effective'),
      fieldReport: payload === undefined ? null : jsonColumn(payload, 'field_report'),
      wire: payload === undefined ? null : jsonColumn(payload, 'wire'),
      backendResponse: payload === undefined ? null : jsonColumn(payload, 'backend_response'),
      inputs,
      outputs,
    },
  };
}

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

/** How many generations either way the walk follows; a backstop, not a limit people meet. */
const LINEAGE_MAX_DEPTH = 64;

/**
 * The asset's family tree, nearest relatives first, at most `maxNodes` assets
 * (the asset itself included). Each direction is one recursive walk; `union`
 * drops repeats, and the depth bound ends it even on data that loops.
 */
export function lineageRows(
  db: DatabaseSync,
  assetId: string,
  maxNodes: number,
): LineageRecord | undefined {
  const asset = getAssetRow(db, assetId);
  if (asset === undefined) return undefined;

  const limit = maxNodes * 4;
  // An object, so the closure's write is visible to the check at the end.
  const walked = { full: false };
  const walk = (direction: 'up' | 'down'): { id: string; depth: number }[] => {
    const steps =
      direction === 'up'
        ? `select i.asset_id, w.depth + 1 from walk w
             join job_outputs o on o.asset_id = w.id
             join job_inputs i on i.job_id = o.job_id
             where w.depth < ${String(LINEAGE_MAX_DEPTH)}
           union
           select a.derived_from, w.depth + 1 from walk w
             join assets a on a.id = w.id
             where a.derived_from is not null and w.depth < ${String(LINEAGE_MAX_DEPTH)}`
        : `select o.asset_id, w.depth + 1 from walk w
             join job_inputs i on i.asset_id = w.id
             join job_outputs o on o.job_id = i.job_id
             where w.depth < ${String(LINEAGE_MAX_DEPTH)}
           union
           select a.id, w.depth + 1 from walk w
             join assets a on a.derived_from = w.id
             where w.depth < ${String(LINEAGE_MAX_DEPTH)}`;
    // Breadth first (SQLite's default queue order), so a walk cut short by
    // the limit has kept the nearest relatives.
    const rows = db
      .prepare(
        `with recursive walk(id, depth) as (select ?, 0 union ${steps} limit ?) select id, depth from walk`,
      )
      .all(assetId, limit)
      .map((row) => ({ id: textColumn(row, 'id'), depth: numberColumn(row, 'depth') }));
    if (rows.length >= limit) walked.full = true;
    return rows.filter((row) => row.id !== assetId);
  };

  const relatives = new Map<string, number>();
  for (const { id, depth } of [...walk('up'), ...walk('down')]) {
    const known = relatives.get(id);
    if (known === undefined || depth < known) relatives.set(id, depth);
  }
  const ranked = [...relatives].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  const kept = ranked.slice(0, Math.max(0, maxNodes - 1)).map(([id]) => id);
  const ids = [assetId, ...kept];
  const idsJson = JSON.stringify(ids);

  const nodes = db
    .prepare(`${ASSET_SELECT} where a.id in (select value from json_each(?))`)
    .all(idsJson)
    .map(assetFromRow)
    .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));

  const edges = [
    ...db
      .prepare(
        `select distinct i.asset_id as parent, o.asset_id as child, i.job_id as job_id, i.role as role
         from job_inputs i join job_outputs o on o.job_id = i.job_id
         where i.asset_id in (select value from json_each(?1))
           and o.asset_id in (select value from json_each(?1))
         order by i.job_id, i.position, o.output_index`,
      )
      .all(idsJson)
      .map((row) => ({
        parent: textColumn(row, 'parent'),
        child: textColumn(row, 'child'),
        kind: 'job' as const,
        jobId: textColumn(row, 'job_id'),
        role: textColumn(row, 'role'),
      })),
    ...db
      .prepare(
        `select derived_from as parent, id as child from assets
         where id in (select value from json_each(?1))
           and derived_from in (select value from json_each(?1))
         order by created_at, id`,
      )
      .all(idsJson)
      .map((row) => ({
        parent: textColumn(row, 'parent'),
        child: textColumn(row, 'child'),
        kind: 'derived' as const,
        jobId: null,
        role: null,
      })),
  ];

  return { assetId, nodes, edges, truncated: walked.full || ranked.length > kept.length };
}
