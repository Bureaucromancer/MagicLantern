// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The two interfaces over one library database (A18, plan "Libraries"):
 *
 * - {@link JobStore} holds live dispatch state. It is always local, and the
 *   scheduler owns it: a scheduler cannot keep the state of a running job in a
 *   library on the far side of a network.
 * - {@link Library} holds assets, provenance and queries, and takes finished
 *   jobs through {@link Library.importFinishedJob}. A remote library (later)
 *   is a second implementation over the native API's library routes, fed from
 *   a local outbox as each job finishes; imports from A1111, Comfy and Swarm
 *   (1.0) use the same entry point.
 *
 * Locally both are one object over `library.db` (local-library.ts).
 *
 * Records are camelCase with epoch-millisecond times; the HTTP layer maps
 * them to the wire field by field, so nothing internal leaks.
 */

import type {
  AssetOrigin,
  BytesState,
  GenerationRequest,
  LibraryUsage,
  Retention,
  SourceRect,
} from '@bureaucromancer/lantern-schema';

/** A write was asked of a library that a newer Lantern wrote, which is open read-only. */
export class LibraryReadOnlyError extends Error {
  constructor(id: string) {
    super(`Library ${id} is open read-only: it was written by a newer Lantern.`);
    this.name = 'LibraryReadOnlyError';
  }
}

/** An asset an operation needs is not in the library, or its bytes are gone. */
export class AssetUnavailableError extends Error {
  readonly assetId: string;
  readonly why: 'missing' | 'gone';

  constructor(assetId: string, why: 'missing' | 'gone') {
    super(
      why === 'missing'
        ? `The library has no asset ${assetId}.`
        : `The bytes of asset ${assetId} were deleted.`,
    );
    this.name = 'AssetUnavailableError';
    this.assetId = assetId;
    this.why = why;
  }
}

/** Which job output an asset is. */
export interface OutputOf {
  readonly jobId: string;
  readonly index: number;
  readonly seed: number | null;
  readonly modelId: string;
}

export interface AssetRecord {
  /** SHA-256 of the bytes as stored, hex. */
  readonly id: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly frames: number | null;
  readonly durationMs: number | null;
  readonly pixelHash: string | null;
  readonly pixelHashAlg: string | null;
  readonly origin: AssetOrigin;
  readonly bytesState: BytesState;
  readonly retention: Retention;
  readonly rating: number | null;
  /** For a derived asset: its source, and what was done (`{ crop: SourceRect }`). */
  readonly derivedFrom: { readonly assetId: string; readonly operation: unknown } | null;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** The first job (by id, so the oldest) with this asset among its outputs. */
  readonly outputOf: OutputOf | null;
}

/** Storing bytes: the record, and whether the library lacked them before. */
export interface StoredAsset {
  readonly asset: AssetRecord;
  /** False when the library already held these bytes (present, or brought back from trashed). */
  readonly created: boolean;
}

/** An asset's bytes as stored, or why there are none. */
export type AssetBytes =
  | { readonly kind: 'present'; readonly asset: AssetRecord; readonly bytes: Buffer }
  | { readonly kind: 'gone'; readonly asset: AssetRecord }
  | { readonly kind: 'missing' };

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export type JobState =
  'queued' | 'submitting' | 'dispatched' | 'running' | 'cancel_requested' | 'finished';

export type JobOutcome = 'done' | 'failed' | 'refused' | 'cancelled';

/** Who asked, and how the job is filed, at submit. */
export interface JobOrigin {
  readonly parentId?: string;
  readonly clientId?: string;
  readonly endUser?: string;
  readonly collection?: string;
  readonly idempotencyKey?: string;
}

/** A job as submitted, before the scheduler has it. */
export interface NewJob extends JobOrigin {
  readonly id: string;
  readonly priority?: number;
  readonly queueRank?: string;
  readonly modelId: string;
  readonly routeId?: string;
  readonly canonical: GenerationRequest;
  /** Epoch milliseconds. */
  readonly createdAt: number;
}

/** The narrow row the queue and history read. */
export interface JobRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly clientId: string | null;
  readonly endUser: string | null;
  readonly collection: string | null;
  readonly idempotencyKey: string | null;
  readonly priority: number;
  readonly queueRank: string | null;
  readonly state: JobState;
  readonly blockedReason: unknown;
  readonly outcome: JobOutcome | null;
  readonly outcomeReason: string | null;
  readonly modelId: string;
  readonly routeId: string | null;
  readonly routeSnapshot: unknown;
  readonly backendHandle: unknown;
  readonly progress: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

/**
 * Live dispatch state (A18). Phase 3 gives the scheduler what it needs to
 * load and file jobs; the state machine's one transition function (EN4)
 * arrives with the engine.
 */
export interface JobStore {
  readonly libraryId: string;
  /** Files a queued job with its canonical request, and indexes its prompt, in one transaction. */
  insertQueued(job: NewJob): JobRecord;
  getJob(id: string): JobRecord | undefined;
  /** Every job that has not finished, oldest first: the scheduler's load at startup. */
  liveJobs(): JobRecord[];
}

/** One input of a finished job, already in this library (submit copies foreign ones in). */
export interface FinishedJobInput {
  readonly position: number;
  readonly assetId: string;
  readonly role: string;
  readonly weight?: number;
  readonly region?: SourceRect;
  readonly crop?: SourceRect;
  /** The library it was copied from (A22). */
  readonly sourceLibrary?: string;
}

/** One output: the backend's bytes, untouched, and the seed it used (base + index). */
export interface FinishedJobOutput {
  readonly index: number;
  readonly bytes: Uint8Array;
  readonly seed: number | null;
}

/**
 * A finished job as the engine (or an import) hands it over: the whole record
 * plus the output bytes as the backend returned them. The library inserts
 * the metadata chunks, stores the outputs and writes the provenance.
 */
export interface FinishedJob extends JobOrigin {
  readonly id: string;
  readonly priority?: number;
  readonly modelId: string;
  readonly routeId: string | null;
  readonly routeSnapshot: unknown;
  readonly outcome: JobOutcome;
  readonly outcomeReason?: string;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly finishedAt: number;
  readonly canonical: GenerationRequest;
  readonly effective?: GenerationRequest;
  readonly fieldReport?: unknown;
  readonly wire?: unknown;
  readonly backendResponse?: unknown;
  readonly inputs: readonly FinishedJobInput[];
  readonly outputs: readonly FinishedJobOutput[];
}

export interface ImportedJob {
  readonly job: JobRecord;
  /** The stored outputs, by index. */
  readonly outputs: readonly AssetRecord[];
  /** False when the job was already imported with these outputs (recovery ran it twice). */
  readonly imported: boolean;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface AssetFilter {
  /** Prompt search; every word must appear. */
  readonly text?: string;
  readonly modelId?: string;
  readonly routeId?: string;
  readonly collection?: string;
  readonly origin?: AssetOrigin;
  readonly ratingMin?: number;
  /** Epoch milliseconds, inclusive. */
  readonly createdFrom?: number;
  /** Epoch milliseconds, exclusive. */
  readonly createdBefore?: number;
  readonly limit: number;
  /** The last asset of the previous page. */
  readonly after?: { readonly createdAt: number; readonly id: string };
}

export interface AssetPageRecord {
  readonly assets: readonly AssetRecord[];
  /** The last asset's position when there may be more, else null. */
  readonly next: { readonly createdAt: number; readonly id: string } | null;
}

export interface ProvenanceRecord {
  readonly asset: AssetRecord;
  readonly job: {
    readonly record: JobRecord;
    readonly canonical: unknown;
    readonly effective: unknown;
    readonly fieldReport: unknown;
    readonly wire: unknown;
    readonly backendResponse: unknown;
    readonly inputs: readonly {
      readonly position: number;
      readonly assetId: string;
      readonly role: string;
      readonly weight: number | null;
      readonly region: unknown;
      readonly crop: unknown;
      readonly sourceLibrary: string | null;
    }[];
    readonly outputs: readonly {
      readonly index: number;
      readonly assetId: string;
      readonly seed: number | null;
    }[];
  } | null;
}

export interface LineageRecord {
  readonly assetId: string;
  readonly nodes: readonly AssetRecord[];
  readonly edges: readonly {
    readonly parent: string;
    readonly child: string;
    readonly kind: 'job' | 'derived';
    readonly jobId: string | null;
    readonly role: string | null;
  }[];
  readonly truncated: boolean;
}

/** Disk use in bytes; the wire shape, since it is nothing but numbers. */
export type UsageRecord = LibraryUsage;

/**
 * Assets, provenance and queries (A18). Methods that write throw
 * {@link LibraryReadOnlyError} on a library open read-only.
 */
export interface Library {
  readonly id: string;
  readonly writable: boolean;

  getAsset(id: string): AssetRecord | undefined;
  readAsset(id: string): Promise<AssetBytes>;
  /** The thumbnail, remade if the cache lost it. */
  readThumbnail(id: string): Promise<AssetBytes>;
  queryAssets(filter: AssetFilter): AssetPageRecord;
  provenance(id: string): ProvenanceRecord | undefined;
  lineage(id: string): LineageRecord | undefined;

  /**
   * Stores an upload exactly as sent (no chunks added). Throws
   * `ImageRefusedError` for anything that is not an accepted raster image.
   */
  ingestUpload(bytes: Uint8Array): Promise<StoredAsset>;
  /**
   * Copies an asset in from another library (A22), as `imported`. The bytes,
   * and so the id, are the same in both.
   */
  copyAssetFrom(source: Library, id: string): Promise<StoredAsset>;
  /** A crop of an asset as a new `derived` asset (A7), by the fixed rounding rule. */
  deriveCrop(sourceId: string, crop: SourceRect): Promise<StoredAsset>;
  /** Sets or clears the rating; undefined when there is no such asset. */
  rate(id: string, rating: number | null): AssetRecord | undefined;
  /** Removes the bytes and thumbnail, keeping the record (A23); undefined when there is no such asset. */
  deleteAsset(id: string): Promise<AssetRecord | undefined>;

  importFinishedJob(job: FinishedJob): Promise<ImportedJob>;

  usage(): Promise<UsageRecord>;
}
