// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * A library on this machine: {@link Library} and {@link JobStore} over one
 * `library.db` and its folder (A18).
 *
 * Every store of bytes runs in this order: decode, hash and thumbnail with no
 * lock held; then, one at a time per library, write the files and commit the
 * rows. Files go first, so a crash leaves an orphan file (swept at the next
 * start) rather than a row whose bytes never arrived. Deleting runs the other
 * way: the row says `trashed` first, then the file goes. One write at a time
 * is what keeps an upload and a delete of the same bytes from interleaving
 * into a `present` row with no file.
 *
 * Outputs are stored with Lantern's `lantern` chunk inserted before the
 * first IDAT (A24); everything the backend wrote is kept byte for byte (rule
 * 7), and its text chunks are copied into `backend_response`. Uploads are
 * stored exactly as sent. The asset id is the hash of the file as stored.
 */

import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';

import type { SourceRect } from '@bureaucromancer/lantern-schema';

import {
  assetPath,
  directoryBytes,
  readIfPresent,
  sizeOf,
  sweepLibraryFiles,
  thumbnailPath,
  writeDurably,
  type SweepReport,
} from './asset-files.js';
import { inTransaction, numberColumn, textColumn } from './db.js';
import { errorFields } from './errors.js';
import {
  ASSET_SELECT,
  assetFromRow,
  getAssetRow,
  getJobRow,
  JOB_COLUMNS,
  jobFromRow,
  lineageRows,
  provenanceRows,
  queryAssetRows,
  toJson,
} from './library-queries.js';
import {
  AssetUnavailableError,
  LibraryReadOnlyError,
  type AssetBytes,
  type AssetFilter,
  type AssetPageRecord,
  type AssetRecord,
  type FinishedJob,
  type ImportedJob,
  type JobRecord,
  type JobStore,
  type Library,
  type LineageRecord,
  type NewJob,
  type ProvenanceRecord,
  type StoredAsset,
  type UsageRecord,
} from './library-types.js';
import {
  cropToPng,
  ImageRefusedError,
  inspectImage,
  makeThumbnail,
  MAX_INPUT_PIXELS,
} from './media.js';
import type { LibraryPaths } from './paths.js';
import { PIXEL_HASH_ALG, pngPixelHash } from './pixel-hash.js';
import {
  iTXtChunk,
  isPng,
  LANTERN_KEYWORD,
  PngError,
  pngSize,
  readChunks,
  readTexts,
  withTextChunks,
} from './png.js';
import type { StoreLog } from './types.js';

/** The version of the `lantern` chunk's JSON, so a later reader knows what it holds. */
export const LANTERN_CHUNK_FORMAT = 1;

/** How long a measured disk usage is reused: `GET /libraries` must not walk a cache per request. */
export const USAGE_TTL_MS = 30_000;

/** The most assets a lineage answer lists. */
export const LINEAGE_NODE_LIMIT = 500;

export interface LocalLibraryOptions {
  readonly id: string;
  readonly db: DatabaseSync;
  readonly paths: LibraryPaths;
  /** False for a library a newer Lantern wrote, open read-only. */
  readonly writable: boolean;
  readonly log: StoreLog;
  /** Epoch milliseconds; `Date.now` by default. */
  readonly now?: () => number;
}

/** Bytes ready to store, with everything the row records about them. */
interface PreparedAsset {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly frames: number | null;
  readonly pixelHash: string | null;
  readonly thumbnail: Buffer | null;
}

interface AssetRowValues {
  readonly origin: AssetRecord['origin'];
  readonly derivedFrom?: { readonly assetId: string; readonly operation: unknown };
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A thrown output problem the engine records as `ingest_failed`. */
export class IngestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IngestError';
  }
}

export class LocalLibrary implements Library, JobStore {
  readonly id: string;
  readonly writable: boolean;
  readonly libraryId: string;
  private readonly db: DatabaseSync;
  private readonly paths: LibraryPaths;
  private readonly log: StoreLog;
  private readonly now: () => number;
  /** The tail of the queue of writes; each waits for the one before. */
  private writes: Promise<unknown> = Promise.resolve();
  private usageCache: { at: number; value: Promise<UsageRecord> } | null = null;

  constructor(options: LocalLibraryOptions) {
    this.id = options.id;
    this.libraryId = options.id;
    this.writable = options.writable;
    this.db = options.db;
    this.paths = options.paths;
    this.log = options.log;
    this.now = options.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  getAsset(id: string): AssetRecord | undefined {
    return getAssetRow(this.db, id);
  }

  async readAsset(id: string): Promise<AssetBytes> {
    const asset = this.getAsset(id);
    if (asset === undefined) return { kind: 'missing' };
    if (asset.bytesState !== 'present') return { kind: 'gone', asset };
    const bytes = await readIfPresent(assetPath(this.paths, id, asset.mediaType));
    if (bytes !== null) return { kind: 'present', asset, bytes };
    // Deleted meanwhile, or lost outside Lantern (a partial restore).
    const now = this.getAsset(id);
    if (now?.bytesState === 'present') {
      this.log.error('An asset recorded as present has no file.', { library: this.id, asset: id });
    }
    return { kind: 'gone', asset: now ?? asset };
  }

  async readThumbnail(id: string): Promise<AssetBytes> {
    const asset = this.getAsset(id);
    if (asset === undefined) return { kind: 'missing' };
    if (asset.bytesState !== 'present') return { kind: 'gone', asset };
    const path = thumbnailPath(this.paths, id);
    const cached = await readIfPresent(path);
    if (cached !== null) return { kind: 'present', asset, bytes: cached };

    const original = await this.readAsset(id);
    if (original.kind !== 'present') return original;
    const thumbnail = await makeThumbnail(original.bytes);
    // A read-only library's folder belongs to the newer Lantern that wrote
    // it, so there the remade thumbnail is served without being saved.
    if (this.writable) {
      try {
        await writeDurably(path, thumbnail);
      } catch (error) {
        this.log.warn('Could not save a remade thumbnail.', {
          library: this.id,
          asset: id,
          ...errorFields(error),
        });
      }
    }
    return { kind: 'present', asset, bytes: thumbnail };
  }

  queryAssets(filter: AssetFilter): AssetPageRecord {
    return queryAssetRows(this.db, filter);
  }

  provenance(id: string): ProvenanceRecord | undefined {
    return provenanceRows(this.db, id);
  }

  lineage(id: string): LineageRecord | undefined {
    return lineageRows(this.db, id, LINEAGE_NODE_LIMIT);
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  getJob(id: string): JobRecord | undefined {
    return getJobRow(this.db, id);
  }

  liveJobs(): JobRecord[] {
    return this.db
      .prepare(`select ${JOB_COLUMNS} from jobs where state <> 'finished' order by created_at, id`)
      .all()
      .map(jobFromRow);
  }

  insertQueued(job: NewJob): JobRecord {
    this.requireWritable();
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `insert into jobs (id, parent_id, client_id, end_user, collection, idempotency_key,
             priority, queue_rank, state, model_id, route_id, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
        )
        .run(
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
          job.createdAt,
          job.createdAt,
        );
      this.db
        .prepare('insert into job_payloads (job_id, canonical) values (?, ?)')
        .run(job.id, JSON.stringify(job.canonical));
      this.indexPrompt(job.id, job.canonical.prompt);
    });
    const stored = this.getJob(job.id);
    if (stored === undefined) throw new Error(`Job ${job.id} was not stored.`);
    return stored;
  }

  /** The prompt index row; a job already indexed keeps its row. Inside a transaction. */
  private indexPrompt(jobId: string, prompt: { positive: string; negative?: string }): void {
    this.db
      .prepare(
        'insert into job_prompts (job_id, positive, negative) values (?, ?, ?) on conflict (job_id) do nothing',
      )
      .run(jobId, prompt.positive, prompt.negative ?? '');
  }

  async importFinishedJob(job: FinishedJob): Promise<ImportedJob> {
    this.requireWritable();
    const indexes = job.outputs.map((output) => output.index);
    if (new Set(indexes).size !== indexes.length) {
      throw new TypeError(`Job ${job.id} lists an output index twice.`);
    }

    const already = this.alreadyImported(job);
    if (already !== null) return already;

    // Outside the write queue: decoding, hashing and thumbnails are the slow part.
    const prepared: { index: number; seed: number | null; asset: PreparedAsset }[] = [];
    const pngTexts: { index: number; chunks: Record<string, string>; skipped?: string[] }[] = [];
    for (const output of [...job.outputs].sort((a, b) => a.index - b.index)) {
      const { asset, texts, skipped } = await this.prepareOutput(job, output);
      prepared.push({ index: output.index, seed: output.seed, asset });
      if (Object.keys(texts).length > 0 || skipped.length > 0) {
        pngTexts.push({
          index: output.index,
          chunks: texts,
          ...(skipped.length > 0 ? { skipped } : {}),
        });
      }
    }
    const backendResponse =
      pngTexts.length === 0
        ? (job.backendResponse ?? null)
        : { ...asObject(job.backendResponse), png_text: pngTexts };

    return await this.serialised(async () => {
      const again = this.alreadyImported(job);
      if (again !== null) return again;
      for (const { asset } of prepared) await this.writeFiles(asset);

      const now = this.now();
      inTransaction(this.db, () => {
        this.db
          .prepare(
            `insert into jobs (id, parent_id, client_id, end_user, collection, idempotency_key,
               priority, state, outcome, outcome_reason, model_id, route_id, route_snapshot,
               created_at, updated_at, started_at, finished_at)
             values (?, ?, ?, ?, ?, ?, ?, 'finished', ?, ?, ?, ?, ?, ?, ?, ?, ?)
             on conflict (id) do update set
               state = 'finished', outcome = excluded.outcome,
               outcome_reason = excluded.outcome_reason, route_id = excluded.route_id,
               route_snapshot = excluded.route_snapshot, blocked_reason = null,
               backend_handle = null, progress = null, updated_at = excluded.updated_at,
               started_at = coalesce(excluded.started_at, jobs.started_at),
               finished_at = excluded.finished_at`,
          )
          .run(
            job.id,
            job.parentId ?? null,
            job.clientId ?? null,
            job.endUser ?? null,
            job.collection ?? null,
            job.idempotencyKey ?? null,
            job.priority ?? 0,
            job.outcome,
            job.outcomeReason ?? null,
            job.modelId,
            job.routeId,
            toJson(job.routeSnapshot),
            job.createdAt,
            now,
            job.startedAt ?? null,
            job.finishedAt,
          );
        this.db
          .prepare(
            `insert into job_payloads (job_id, canonical, effective, field_report, wire, backend_response)
             values (?, ?, ?, ?, ?, ?)
             on conflict (job_id) do update set
               effective = excluded.effective, field_report = excluded.field_report,
               wire = excluded.wire, backend_response = excluded.backend_response`,
          )
          .run(
            job.id,
            JSON.stringify(job.canonical),
            toJson(job.effective),
            toJson(job.fieldReport),
            toJson(job.wire),
            toJson(backendResponse),
          );
        this.indexPrompt(job.id, job.canonical.prompt);

        this.db.prepare('delete from job_inputs where job_id = ?').run(job.id);
        const insertInput = this.db.prepare(
          `insert into job_inputs (job_id, position, asset_id, role, weight, region, crop, source_library)
           values (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const input of job.inputs) {
          insertInput.run(
            job.id,
            input.position,
            input.assetId,
            input.role,
            input.weight ?? null,
            toJson(input.region),
            toJson(input.crop),
            input.sourceLibrary ?? null,
          );
        }

        const insertOutput = this.db.prepare(
          `insert into job_outputs (job_id, output_index, asset_id, seed) values (?, ?, ?, ?)
           on conflict (job_id, output_index) do update set
             asset_id = excluded.asset_id, seed = excluded.seed`,
        );
        for (const { index, seed, asset } of prepared) {
          this.upsertAssetRow(asset, { origin: 'generated' }, now);
          insertOutput.run(job.id, index, asset.id, seed);
        }
      });

      const record = this.getJob(job.id);
      if (record === undefined) throw new Error(`Job ${job.id} was not stored.`);
      return {
        job: record,
        outputs: prepared.map(({ asset }) => this.mustGet(asset.id)),
        imported: true,
      };
    });
  }

  /**
   * The answer for a job already finished with every output this import
   * carries: recovery may ingest a spool twice (A17). Null when there is
   * something to do.
   */
  private alreadyImported(job: FinishedJob): ImportedJob | null {
    const existing = this.getJob(job.id);
    if (existing?.state !== 'finished') return null;
    const rows = this.db
      .prepare(
        'select output_index, asset_id from job_outputs where job_id = ? order by output_index',
      )
      .all(job.id);
    const stored = new Set(rows.map((row) => numberColumn(row, 'output_index')));
    if (!job.outputs.every((output) => stored.has(output.index))) return null;
    return {
      job: existing,
      outputs: rows.map((row) => this.mustGet(textColumn(row, 'asset_id'))),
      imported: false,
    };
  }

  /** One output, made ready: the `lantern` chunk inserted, then hashed, inspected and thumbnailed. */
  private async prepareOutput(
    job: FinishedJob,
    output: FinishedJob['outputs'][number],
  ): Promise<{ asset: PreparedAsset; texts: Record<string, string>; skipped: string[] }> {
    try {
      if (!isPng(output.bytes)) {
        // 0.1 outputs are all PNG; other formats get XMP or a sidecar when they arrive.
        return { asset: await this.prepareUpload(output.bytes), texts: {}, skipped: [] };
      }
      const chunks = readChunks(output.bytes);
      const { width, height } = pngSize(chunks);
      if (width * height > MAX_INPUT_PIXELS) {
        throw new IngestError(
          `Output ${String(output.index)} has ${String(width)} × ${String(height)} pixels, more than Lantern takes.`,
        );
      }
      const { texts, skipped } = readTexts(chunks);
      const backendTexts: Record<string, string> = {};
      for (const text of texts) {
        if (text.keyword !== LANTERN_KEYWORD) backendTexts[text.keyword] = text.text;
      }
      const pixelHash = pngPixelHash(output.bytes);
      const stored = withTextChunks(output.bytes, [
        iTXtChunk(LANTERN_KEYWORD, JSON.stringify(this.lanternChunk(job, output)), true),
      ]);
      const facts = await inspectImage(stored);
      return {
        asset: {
          id: sha256(stored),
          bytes: stored,
          mediaType: facts.mediaType,
          width,
          height,
          frames: facts.frames,
          pixelHash,
          thumbnail: await makeThumbnail(stored),
        },
        texts: backendTexts,
        skipped,
      };
    } catch (error) {
      if (error instanceof IngestError) throw error;
      const why =
        error instanceof PngError || error instanceof ImageRefusedError
          ? error.message
          : 'it could not be read';
      throw new IngestError(
        `Output ${String(output.index)} of job ${job.id} was refused: ${why}.`,
        {
          cause: error,
        },
      );
    }
  }

  /**
   * What the `lantern` chunk carries: enough to reproduce the output from the
   * file alone. Never `wire`, which can hold a backend's internals (A24).
   */
  private lanternChunk(job: FinishedJob, output: FinishedJob['outputs'][number]): unknown {
    return {
      format: LANTERN_CHUNK_FORMAT,
      job_id: job.id,
      library_id: this.id,
      output: { index: output.index, seed: output.seed },
      model_id: job.modelId,
      canonical: job.canonical,
      ...(job.effective === undefined ? {} : { effective: job.effective }),
      route_snapshot: job.routeSnapshot ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Assets
  // -------------------------------------------------------------------------

  /** An upload, made ready: inspected, hashed and thumbnailed, its bytes untouched. */
  private async prepareUpload(bytes: Uint8Array): Promise<PreparedAsset> {
    const facts = await inspectImage(bytes);
    let pixelHash: string | null = null;
    if (facts.mediaType === 'image/png') {
      try {
        pixelHash = pngPixelHash(bytes);
      } catch (error) {
        // sharp read it; a PNG the pure decoder cannot is still a usable input.
        this.log.warn('Could not compute the pixel hash of a PNG.', {
          library: this.id,
          ...errorFields(error),
        });
      }
    }
    return {
      id: sha256(bytes),
      bytes,
      mediaType: facts.mediaType,
      width: facts.width,
      height: facts.height,
      frames: facts.frames,
      pixelHash,
      thumbnail: await makeThumbnail(bytes),
    };
  }

  async ingestUpload(bytes: Uint8Array): Promise<StoredAsset> {
    this.requireWritable();
    const prepared = await this.prepareUpload(bytes);
    return await this.store(prepared, { origin: 'uploaded' });
  }

  async copyAssetFrom(source: Library, id: string): Promise<StoredAsset> {
    this.requireWritable();
    const here = this.getAsset(id);
    if (here?.bytesState === 'present') return { asset: here, created: false };

    const original = await source.readAsset(id);
    if (original.kind === 'missing') throw new AssetUnavailableError(id, 'missing');
    if (original.kind === 'gone') throw new AssetUnavailableError(id, 'gone');
    if (sha256(original.bytes) !== id) {
      throw new Error(`Asset ${id} in library ${source.id} does not match its hash.`);
    }
    const thumbnail = await source.readThumbnail(id);
    const { asset } = original;
    return await this.store(
      {
        id,
        bytes: original.bytes,
        mediaType: asset.mediaType,
        width: asset.width,
        height: asset.height,
        frames: asset.frames,
        pixelHash: asset.pixelHashAlg === PIXEL_HASH_ALG ? asset.pixelHash : null,
        thumbnail: thumbnail.kind === 'present' ? thumbnail.bytes : null,
      },
      { origin: 'imported' },
    );
  }

  async deriveCrop(sourceId: string, crop: SourceRect): Promise<StoredAsset> {
    this.requireWritable();
    const valid =
      crop.width > 0 &&
      crop.height > 0 &&
      crop.x >= 0 &&
      crop.y >= 0 &&
      crop.x + crop.width <= 1 &&
      crop.y + crop.height <= 1;
    if (!valid) throw new TypeError('A crop must have an area and stay inside the image.');
    const source = await this.readAsset(sourceId);
    if (source.kind === 'missing') throw new AssetUnavailableError(sourceId, 'missing');
    if (source.kind === 'gone') throw new AssetUnavailableError(sourceId, 'gone');

    const bytes = await cropToPng(source.bytes, crop);
    const { width, height } = pngSize(readChunks(bytes));
    return await this.store(
      {
        id: sha256(bytes),
        bytes,
        mediaType: 'image/png',
        width,
        height,
        frames: null,
        pixelHash: pngPixelHash(bytes),
        thumbnail: await makeThumbnail(bytes),
      },
      {
        origin: 'derived',
        derivedFrom: {
          assetId: sourceId,
          operation: { crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height } },
        },
      },
    );
  }

  rate(id: string, rating: number | null): AssetRecord | undefined {
    this.requireWritable();
    const changed = this.db.prepare('update assets set rating = ? where id = ?').run(rating, id);
    return changed.changes === 0 ? undefined : this.getAsset(id);
  }

  async deleteAsset(id: string): Promise<AssetRecord | undefined> {
    this.requireWritable();
    return await this.serialised(async () => {
      const asset = this.getAsset(id);
      if (asset === undefined) return undefined;
      if (asset.bytesState === 'present') {
        this.db
          .prepare("update assets set bytes_state = 'trashed', bytes_changed_at = ? where id = ?")
          .run(this.now(), id);
      }
      // Also when already trashed: a crash may have left the files behind.
      await rm(assetPath(this.paths, id, asset.mediaType), { force: true });
      await rm(thumbnailPath(this.paths, id), { force: true });
      this.usageCache = null;
      return this.mustGet(id);
    });
  }

  /** Writes the files and the row, one store at a time. */
  private async store(prepared: PreparedAsset, values: AssetRowValues): Promise<StoredAsset> {
    return await this.serialised(async () => {
      const before = this.getAsset(prepared.id);
      if (before?.bytesState === 'present') return { asset: before, created: false };
      await this.writeFiles(prepared);
      inTransaction(this.db, () => {
        this.upsertAssetRow(prepared, values, this.now());
      });
      return { asset: this.mustGet(prepared.id), created: before === undefined };
    });
  }

  private async writeFiles(prepared: PreparedAsset): Promise<void> {
    await writeDurably(assetPath(this.paths, prepared.id, prepared.mediaType), prepared.bytes, {
      ifAbsent: true,
    });
    if (prepared.thumbnail !== null) {
      try {
        await writeDurably(thumbnailPath(this.paths, prepared.id), prepared.thumbnail);
      } catch (error) {
        // A cache: remade on first read.
        this.log.warn('Could not save a thumbnail.', {
          library: this.id,
          asset: prepared.id,
          ...errorFields(error),
        });
      }
    }
    this.usageCache = null;
  }

  /**
   * A new row, or bytes brought back to a row that had lost them. An existing
   * row keeps its origin, rating and derivation: the same bytes are the same
   * asset however they arrived again. Inside a transaction.
   */
  private upsertAssetRow(prepared: PreparedAsset, values: AssetRowValues, now: number): void {
    this.db
      .prepare(
        `insert into assets (id, media_type, bytes, width, height, frames, pixel_hash, pixel_hash_alg,
           origin, derived_from, derivation, created_at, bytes_changed_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set
           bytes_state = 'present', bytes_changed_at = excluded.bytes_changed_at,
           pixel_hash = coalesce(assets.pixel_hash, excluded.pixel_hash),
           pixel_hash_alg = coalesce(assets.pixel_hash_alg, excluded.pixel_hash_alg)
         where assets.bytes_state <> 'present'`,
      )
      .run(
        prepared.id,
        prepared.mediaType,
        prepared.bytes.byteLength,
        prepared.width,
        prepared.height,
        prepared.frames,
        prepared.pixelHash,
        prepared.pixelHash === null ? null : PIXEL_HASH_ALG,
        values.origin,
        values.derivedFrom?.assetId ?? null,
        toJson(values.derivedFrom?.operation),
        now,
        now,
      );
  }

  // -------------------------------------------------------------------------
  // Upkeep
  // -------------------------------------------------------------------------

  async usage(): Promise<UsageRecord> {
    const now = this.now();
    if (this.usageCache !== null && now - this.usageCache.at < USAGE_TTL_MS) {
      return await this.usageCache.value;
    }
    const value = this.measureUsage();
    this.usageCache = { at: now, value };
    try {
      return await value;
    } catch (error) {
      this.usageCache = null;
      throw error;
    }
  }

  private async measureUsage(): Promise<UsageRecord> {
    const assets = this.db
      .prepare("select coalesce(sum(bytes), 0) as total from assets where bytes_state = 'present'")
      .get();
    const assetsBytes = assets === undefined ? 0 : numberColumn(assets, 'total');
    let databaseBytes = 0;
    for (const suffix of ['', '-wal'])
      databaseBytes += (await sizeOf(`${this.paths.db}${suffix}`)) ?? 0;
    const cacheBytes = await directoryBytes(this.paths.cache);
    return {
      total_bytes: assetsBytes + databaseBytes + cacheBytes,
      assets_bytes: assetsBytes,
      database_bytes: databaseBytes,
      cache_bytes: cacheBytes,
    };
  }

  /** The startup sweep (A23). Called once, before the library serves anything. */
  async sweep(): Promise<SweepReport> {
    const assets = new Map(
      this.db
        .prepare('select id, bytes_state from assets')
        .all()
        .map((row) => [textColumn(row, 'id'), textColumn(row, 'bytes_state')] as const),
    );
    const finished = this.db.prepare(
      "select 1 as found from jobs where id = ? and state = 'finished'",
    );
    return await sweepLibraryFiles(this.paths, {
      assets,
      jobIngested: (jobId) => finished.get(jobId) !== undefined,
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private requireWritable(): void {
    if (!this.writable) throw new LibraryReadOnlyError(this.id);
  }

  private mustGet(id: string): AssetRecord {
    const asset = this.getAsset(id);
    if (asset === undefined) throw new Error(`Asset ${id} was not stored.`);
    return asset;
  }

  /** Runs `write` after every write queued before it; a failure does not stop the queue. */
  private async serialised<T>(write: () => Promise<T>): Promise<T> {
    const run = this.writes.then(write, write);
    this.writes = run.catch(() => undefined);
    return await run;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : value === undefined || value === null
      ? {}
      : { value };
}

/** For tests and the backup: every asset row, oldest first. */
export function allAssetRows(db: DatabaseSync): AssetRecord[] {
  return db.prepare(`${ASSET_SELECT} order by a.created_at, a.id`).all().map(assetFromRow);
}
