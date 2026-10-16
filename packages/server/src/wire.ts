// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Store records as the API answers them, shared by the routes and the event
 * stream so both send the same JSON. Field by field: times become ISO 8601,
 * and nothing the store keeps for itself is spread into an answer.
 */

import type {
  AssetSummary,
  BlockedReason,
  JobProgress,
  JobSummary,
} from '@bureaucromancer/lantern-schema';

import type { AssetRecord, JobRecord } from './store/index.js';

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function toAssetSummary(asset: AssetRecord): AssetSummary {
  return {
    id: asset.id,
    media_type: asset.mediaType,
    bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
    frames: asset.frames,
    origin: asset.origin,
    bytes_state: asset.bytesState,
    retention: asset.retention,
    rating: asset.rating,
    pixel_hash: asset.pixelHash,
    pixel_hash_alg: asset.pixelHashAlg,
    created_at: iso(asset.createdAt),
    output_of:
      asset.outputOf === null
        ? null
        : {
            job_id: asset.outputOf.jobId,
            index: asset.outputOf.index,
            seed: asset.outputOf.seed,
            model_id: asset.outputOf.modelId,
          },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored blocked reason as the wire shape; anything else stored there reads as none. */
export function toBlockedReason(value: unknown): BlockedReason | null {
  if (!isRecord(value) || typeof value['code'] !== 'string') return null;
  return {
    code: value['code'],
    ...(typeof value['detail'] === 'string' ? { detail: value['detail'] } : {}),
    ...(typeof value['retry_after'] === 'string' ? { retry_after: value['retry_after'] } : {}),
  };
}

/** Stored progress as the wire shape, keeping only the known fields. */
export function toJobProgress(value: unknown): JobProgress | null {
  if (!isRecord(value)) return null;
  const number = (key: string): Record<string, number> =>
    typeof value[key] === 'number' ? { [key]: value[key] } : {};
  const waiting = value['waiting'];
  return {
    ...number('fraction'),
    ...number('step'),
    ...number('total_steps'),
    ...number('eta_s'),
    ...(isRecord(waiting) && typeof waiting['reason'] === 'string'
      ? {
          waiting: {
            reason: waiting['reason'],
            ...(typeof waiting['detail'] === 'string' ? { detail: waiting['detail'] } : {}),
            ...(typeof waiting['queue_position'] === 'number'
              ? { queue_position: waiting['queue_position'] }
              : {}),
          },
        }
      : {}),
  };
}

export function toJobSummary(library: string, job: JobRecord): JobSummary {
  return {
    id: job.id,
    library,
    parent_id: job.parentId,
    state: job.state,
    blocked_reason: toBlockedReason(job.blockedReason),
    outcome: job.outcome,
    outcome_reason: job.outcomeReason,
    model_id: job.modelId,
    route_id: job.routeId,
    collection: job.collection,
    end_user: job.endUser,
    priority: job.priority,
    progress: toJobProgress(job.progress),
    created_at: iso(job.createdAt),
    updated_at: iso(job.updatedAt),
    started_at: job.startedAt === null ? null : iso(job.startedAt),
    finished_at: job.finishedAt === null ? null : iso(job.finishedAt),
  };
}
