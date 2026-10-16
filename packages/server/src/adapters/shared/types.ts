// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The adapter interface (A14, EN1) and the normalised status types every
 * backend kind reports in (L2, L5).
 *
 * Rule 2: this interface mirrors the JSON-RPC protocol of out-of-process
 * adapters (0.7) one method for one method, and every value crossing it is
 * plain JSON (or bytes), so moving an adapter out of process is a transport,
 * not a redesign. Rule 9: adapters import only the schema and this folder.
 *
 * Rule 3 of L3: no method may cause a load. `health`, `describe` and
 * `identify` never send a native URL anything a manager would treat as work.
 */

import type { GenerationRequest, RouteDescriptor } from '@bureaucromancer/lantern-schema';

/** A model's identity on a route, tagged (L4). The same shape as the resolver's. */
export type ModelIdentity =
  | { readonly kind: 'file'; readonly path: string; readonly stem: string }
  | {
      readonly kind: 'manager';
      readonly manager: string;
      readonly model_id: string;
      readonly definition_hash: string;
    };

/** Settings and secrets for one backend, as configured. */
export interface AdapterConfig {
  /** The backend's stable id (`backends.id`). */
  readonly backendId: string;
  /** The backend's base URL; the mock's is a made-up one. */
  readonly baseUrl: string;
  /** Kind-specific settings, validated against the kind's config schema. */
  readonly settings: Readonly<Record<string, unknown>>;
  /** Never logged, never answered over the API. */
  readonly secrets?: Readonly<Record<string, string>>;
}

/**
 * Reachability and load state, kept apart (L2): a cold route under a manager
 * is healthy and loads on demand.
 */
export interface HealthReport {
  readonly status: 'ok' | 'degraded' | 'down';
  readonly load_state: 'loaded' | 'cold' | 'unknown';
  readonly detail?: string;
}

/** The backend's health, and each route's where they differ (one manager, many models). */
export interface BackendHealth extends HealthReport {
  readonly routes?: Readonly<Record<string, HealthReport>>;
}

/**
 * Which instance a handle belongs to (A17, L4): the base URL and the model it
 * served. Checked before polling resumes, so a restarted backend (or another
 * model on a reused port) never answers for another job.
 */
export interface InstanceFingerprint {
  readonly base_url: string;
  readonly model: ModelIdentity | null;
}

/**
 * A submitted job, as the backend knows it. Opaque JSON to the engine apart
 * from these fields: `resumable` handles (async backends) survive a daemon
 * restart; ephemeral ones (synchronous backends) do not.
 */
export interface JobHandle {
  readonly resumable: boolean;
  readonly instance: InstanceFingerprint;
  /** The adapter's own data: a job id, a prompt id. */
  readonly data: unknown;
}

/** Why a job has not started yet (L5). */
export interface JobWaiting {
  readonly reason: 'memory' | 'loading' | 'calibrating' | 'engine_queue' | 'other';
  readonly detail?: string;
  readonly queue_position?: number;
}

export interface JobProgress {
  /** 0 to 1. */
  readonly fraction?: number;
  readonly step?: number;
  readonly total_steps?: number;
  readonly eta_s?: number;
  /** A data URL of a small preview; kept in memory only, never stored. */
  readonly preview?: string;
}

/** One output as the backend returned it. The engine, not the adapter, ingests it. */
export interface FetchedOutput {
  readonly index: number;
  readonly bytes: Uint8Array;
  /** The seed this output used (base + index), when the backend says. */
  readonly seed: number | null;
}

export interface FetchedResult {
  readonly outputs: readonly FetchedOutput[];
  /** Backend metadata, without image payloads: becomes `backend_response`. */
  readonly metadata: unknown;
  /** The generator's version, from the result, for `route_snapshot`. */
  readonly generator?: string;
}

/**
 * A job's state as the backend reports it, normalised.
 *
 * - `queued`: accepted, not started. `waiting` says why, when the backend
 *   (a manager) knows: memory, a load (L5).
 * - `running`: generating; `progress` as far as the route's `control.progress` allows.
 * - `done`: finished with outputs. `result` is set when the status call
 *   carried them (sd-server); otherwise the engine calls `fetchResult`.
 * - `failed`: with `started: false` when the engine never received the job
 *   (a manager yielded or timed out its queue; a 429): the job goes back to
 *   Lantern's queue, keeping its seed (L5). `retry_after_s` from the backend.
 * - `refused`: the backend declined the content.
 * - `cancelled`: cancelled at the backend.
 * - `lost`: the backend does not know the job (404, 410, a purged result).
 */
export interface JobStatus {
  readonly state: 'queued' | 'running' | 'done' | 'failed' | 'refused' | 'cancelled' | 'lost';
  readonly progress?: JobProgress;
  readonly waiting?: JobWaiting;
  readonly started?: boolean;
  readonly retry_after_s?: number;
  /** The backend's reason for a failure or refusal, as it gave it. */
  readonly reason?: string;
  readonly result?: FetchedResult;
}

/** A probe's findings: capability demotions, as a descriptor layer would carry them. */
export interface ProbeReport {
  readonly notes: readonly string[];
}

/**
 * The wire request `prepare` returns: the exact body to send, with
 * `{"$asset": sha256}` placeholders where image bytes go (A15). The engine
 * stores it as is and fills the placeholders at submit (wire.ts).
 */
export type WireRequest = unknown;

export interface Adapter {
  /** Settings and secrets. Called once, before anything else. */
  init(config: AdapterConfig): Promise<void>;
  describe(): Promise<RouteDescriptor[]>;
  health(): Promise<BackendHealth>;
  /**
   * The model a route serves now, from the backend or its manager, never by
   * sending the native URL work (L3). Null when the backend cannot say.
   */
  identify(route: string): Promise<ModelIdentity | null>;
  /** Pure: an effective request to the exact wire request, with asset placeholders. */
  prepare(route: string, request: GenerationRequest): Promise<WireRequest>;
  /**
   * Sends a wire request whose placeholders are filled. Throws
   * {@link RejectedBeforeStart} when the backend turned it away without
   * starting it (L5), and anything else for a failure.
   */
  submit(route: string, wire: WireRequest, signal: AbortSignal): Promise<JobHandle>;
  status(job: JobHandle): Promise<JobStatus>;
  /**
   * Asks the backend to cancel. Throws {@link CancelRefused} when it cannot
   * stop the job now (a running job on sd-server, a 409); the engine then
   * waits for it to end and discards its outputs.
   */
  cancel(job: JobHandle): Promise<void>;
  fetchResult(job: JobHandle): Promise<FetchedResult>;
  probe?(route: string): Promise<ProbeReport>;
}

/** The backend turned the job away before starting it (L5): it goes back to Lantern's queue. */
export class RejectedBeforeStart extends Error {
  readonly retryAfterS: number | undefined;

  constructor(message: string, retryAfterS?: number) {
    super(message);
    this.name = 'RejectedBeforeStart';
    this.retryAfterS = retryAfterS;
  }
}

/** The backend cannot cancel the job now (a 409, or no route to cancel a running job). */
export class CancelRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CancelRefused';
  }
}
