// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The job engine (EN3 to EN6): submit, the scheduler, the worker loop,
 * cancellation and restart recovery.
 *
 * **The queue (A19).** Install-wide, because the GPU is shared: every live job
 * of every library, in one order: priority first, then age. Lanes taking
 * turns (library × client) arrive with client tokens at 0.3; until then a
 * library is one lane and age decides. A blocked job (`blocked_reason` with
 * `retry_after`, L6) is skipped until then.
 *
 * **Resource groups (A12).** One slot per group (bindings.ts): a job holds
 * its group's slot from dispatch until it finishes or goes back to the queue,
 * so the backend's own queue stays empty and Lantern's order holds.
 *
 * **The worker loop.** In order: finalise at dispatch (route health and
 * model identity checked again, effective re-resolved with the submit's
 * seed), cut emulated crops into derived assets (A7), prepare, store the wire
 * request and move to `submitting`, fill the asset placeholders, submit,
 * store the handle and move to `dispatched`, poll, then on completion spool
 * the bytes and fsync (A17), ingest, write provenance and finish, and clear
 * the spool. Every state change goes through {@link JobTransitions}.
 *
 * **Restart recovery.** Spools are ingested first. Then: `queued` jobs rejoin
 * the queue; `submitting` ones fail as `interrupted` (the backend may still
 * run one: a wasted generation, nothing lost); jobs with resumable handles
 * resume polling once the instance fingerprint matches, else fail as
 * `backend_lost`; jobs with ephemeral handles fail as `interrupted`, or end
 * cancelled if cancel was asked. Nothing retries by itself; the UI offers
 * Reproduce.
 *
 * **Stopping** aborts the polls and any submit in flight, never the backend's
 * jobs: a dispatched job resumes at the next start.
 */

import {
  type BlockedReason,
  type FieldReport,
  type GenerationRequest,
  type ResolutionWarning,
  type ValidationIssue,
} from '@bureaucromancer/lantern-schema';

import {
  CancelRefused,
  fillPlaceholders,
  placeholderIds,
  RejectedBeforeStart,
  type FetchedResult,
  type JobHandle,
  type JobStatus,
  type ModelIdentity,
} from '../../adapters/shared/index.js';
import { newId } from '../../ids.js';
import type {
  FinishedJob,
  FinishedJobInput,
  JobChange,
  JobOutcome,
  JobRecord,
  JobState,
  JobStore,
  Library,
  LibraryRegistry,
  SpooledResult,
  StoreLog,
} from '../../store/index.js';
import type { ModelCatalog } from '../catalog/index.js';
import { canonicalJson } from '../descriptor/index.js';
import type {
  ModelFingerprint,
  ResolveFailure,
  Resolver,
  ResolverModel,
  SeedPolicy,
} from '../resolver/index.js';
import type { BackendBindings, RouteBinding } from './bindings.js';
import type { EventBus } from './events.js';
import { inputSizer } from './sizes.js';
import { JobTransitions } from './transitions.js';

/** How often a dispatched job is polled. */
export const POLL_MS = 250;

/** How long a job blocked without a backend's own `retry_after` waits before it is tried again. */
export const BLOCKED_RETRY_MS = 30_000;

/** Status calls that may fail in a row before the backend counts as having lost the job. */
export const STATUS_FAILURES_TOLERATED = 20;

export interface JobEngineOptions {
  readonly libraries: LibraryRegistry;
  readonly models: ModelCatalog;
  readonly resolver: Resolver;
  readonly bindings: BackendBindings;
  readonly events: EventBus;
  readonly log: StoreLog;
  readonly pollMs?: number;
  readonly blockedRetryMs?: number;
  /** Epoch milliseconds; `Date.now` by default. */
  readonly now?: () => number;
}

export interface SubmitInput {
  readonly request: unknown;
  readonly model: string;
  readonly route?: string;
  readonly collection?: string;
  readonly endUser?: string;
  readonly priority?: number;
  readonly idempotencyKey?: string;
  readonly parentId?: string;
  readonly seed?: SeedPolicy;
}

export type SubmitOutcome =
  | {
      readonly ok: true;
      readonly job: JobRecord;
      readonly fieldReport: FieldReport;
      readonly warnings: readonly ResolutionWarning[];
      readonly replayed: boolean;
    }
  | { readonly ok: false; readonly kind: 'unknown_model' }
  | { readonly ok: false; readonly kind: 'resolve'; readonly failure: ResolveFailure }
  | { readonly ok: false; readonly kind: 'inputs'; readonly issues: readonly ValidationIssue[] }
  | { readonly ok: false; readonly kind: 'conflict'; readonly message: string }
  | { readonly ok: false; readonly kind: 'library' };

/** What the queue answers: every live job in dispatch order. */
export interface QueueItem {
  readonly library: string;
  readonly job: JobRecord;
  readonly mode: string;
  readonly blocked: boolean;
}

interface LiveJob {
  readonly library: string;
  record: JobRecord;
  readonly mode: string;
}

interface Worker {
  readonly group: string;
  readonly abort: AbortController;
  done: Promise<void>;
}

/** The provisional snapshot stored at submit; the dispatch snapshot adds the backend. */
interface ProvisionalSnapshot {
  readonly fingerprint?: ModelFingerprint;
}

const IN_FLIGHT: readonly JobState[] = ['submitting', 'dispatched', 'running', 'cancel_requested'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameIdentity(
  a: ModelIdentity | ModelFingerprint | null | undefined,
  b: typeof a,
): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

/** A stored handle, or null when what is stored is not one. */
function handleOf(value: unknown): JobHandle | null {
  if (!isRecord(value) || typeof value['resumable'] !== 'boolean') return null;
  const instance = value['instance'];
  if (!isRecord(instance) || typeof instance['base_url'] !== 'string') return null;
  return value as unknown as JobHandle;
}

function retryAtOf(record: JobRecord): number | null {
  const reason = record.blockedReason;
  if (!isRecord(reason) || typeof reason['retry_after'] !== 'string') return null;
  const at = Date.parse(reason['retry_after']);
  return Number.isNaN(at) ? null : at;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves after `ms`, or at once when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

export class JobEngine {
  private readonly libraries: LibraryRegistry;
  private readonly models: ModelCatalog;
  private readonly resolver: Resolver;
  private readonly bindings: BackendBindings;
  private readonly log: StoreLog;
  private readonly transitions: JobTransitions;
  private readonly pollMs: number;
  private readonly blockedRetryMs: number;
  private readonly now: () => number;

  private readonly live = new Map<string, LiveJob>();
  private readonly workers = new Map<string, Worker>();
  private readonly cancelWanted = new Set<string>();
  private started = false;
  private stopped = false;
  private pumpQueued = false;
  private wake: NodeJS.Timeout | null = null;
  private wakeAt = Number.POSITIVE_INFINITY;

  constructor(options: JobEngineOptions) {
    this.libraries = options.libraries;
    this.models = options.models;
    this.resolver = options.resolver;
    this.bindings = options.bindings;
    this.log = options.log;
    this.transitions = new JobTransitions(options.events);
    this.pollMs = options.pollMs ?? POLL_MS;
    this.blockedRetryMs = options.blockedRetryMs ?? BLOCKED_RETRY_MS;
    this.now = options.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Recovers what the last run left (EN5), then starts dispatching. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const record of this.libraries.list()) {
      const store = this.libraries.jobs(record.id);
      const library = this.libraries.library(record.id);
      if (store === undefined || library === undefined) continue;
      try {
        await this.recoverLibrary(store, library);
      } catch (error) {
        this.log.error('Could not recover the jobs of a library.', {
          library: record.id,
          error: errorMessage(error),
        });
      }
    }
    this.kick();
  }

  /** Stops dispatching and polling; never cancels a backend's job. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.wake !== null) clearTimeout(this.wake);
    this.wake = null;
    for (const worker of this.workers.values())
      worker.abort.abort(new Error('Lantern is stopping.'));
    await Promise.allSettled([...this.workers.values()].map((worker) => worker.done));
  }

  /**
   * Resolves once nothing is in flight and no queued job can be dispatched
   * now (every one left is blocked). For tests and orderly shutdowns.
   */
  async settled(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const now = this.now();
      const dispatchable = [...this.live.values()].some((job) => {
        if (job.record.state !== 'queued' || this.workers.has(job.record.id)) return false;
        const at = retryAtOf(job.record);
        return at === null || at <= now;
      });
      if (this.workers.size === 0 && !dispatchable && !this.pumpQueued) return;
      if (Date.now() > deadline) throw new Error('The engine did not settle in time.');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  // -------------------------------------------------------------------------
  // Submit and rerun (EN6)
  // -------------------------------------------------------------------------

  async submit(libraryId: string, input: SubmitInput): Promise<SubmitOutcome> {
    const store = this.libraries.jobs(libraryId);
    const library = this.libraries.library(libraryId);
    if (store === undefined || library === undefined) return { ok: false, kind: 'library' };

    if (input.idempotencyKey !== undefined) {
      const existing = store.findByIdempotencyKey(null, input.idempotencyKey);
      if (existing !== undefined) return this.replay(store, existing, input);
    }

    const model = this.models.get(input.model);
    if (model === undefined) return { ok: false, kind: 'unknown_model' };
    const outcome = this.resolver.resolve(
      {
        request: input.request,
        model,
        ...(input.route === undefined ? {} : { route: input.route }),
        inputSize: inputSizer(this.libraries, libraryId),
      },
      input.seed,
    );
    if (!outcome.ok) return { ok: false, kind: 'resolve', failure: outcome.failure };
    const { resolution } = outcome;

    const located = await this.locateInputs(library, resolution.canonical);
    if ('issues' in located) return { ok: false, kind: 'inputs', issues: located.issues };

    const now = this.now();
    const id = newId('job');
    const record = store.insertQueued({
      id,
      modelId: model.id,
      routeId: resolution.route.id,
      canonical: resolution.canonical,
      effective: resolution.effective,
      fieldReport: resolution.field_report,
      routeSnapshot: {
        model_id: model.id,
        family: model.family,
        ...(model.variant === undefined ? {} : { variant: model.variant }),
        ...(resolution.fingerprint === undefined ? {} : { fingerprint: resolution.fingerprint }),
        backend_kind: resolution.route.backend_kind,
        descriptor_digest: resolution.descriptor_digest,
        provisional: true,
      },
      inputs: located.inputs,
      createdAt: now,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.collection === undefined ? {} : { collection: input.collection }),
      ...(input.endUser === undefined ? {} : { endUser: input.endUser }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    });
    this.track(libraryId, record, resolution.canonical.mode);
    // job.updated for the new job, through the same publisher as every change.
    const announced = this.transitions.apply(store, id, ['queued'], {}) ?? record;
    this.kick();
    return {
      ok: true,
      job: announced,
      fieldReport: resolution.field_report,
      warnings: resolution.warnings,
      replayed: false,
    };
  }

  /** A submit whose idempotency key is taken: the same job when the body matches, else a conflict. */
  private replay(store: JobStore, existing: JobRecord, input: SubmitInput): SubmitOutcome {
    const payloads = store.payloads(existing.id);
    const same =
      payloads !== undefined &&
      existing.modelId === input.model &&
      canonicalJson(payloads.canonical) === canonicalJson(input.request) &&
      (input.route === undefined || input.route === existing.routeId);
    if (!same) {
      return {
        ok: false,
        kind: 'conflict',
        message: 'This idempotency key names a job submitted with another body.',
      };
    }
    return {
      ok: true,
      job: existing,
      fieldReport: (payloads.fieldReport ?? {}) as FieldReport,
      warnings: [],
      replayed: true,
    };
  }

  /**
   * Every input must be in this library; one that is only in another (by id,
   * which is its hash) is copied in, and where it came from is recorded (A22).
   */
  private async locateInputs(
    library: Library,
    request: GenerationRequest,
  ): Promise<{ inputs: FinishedJobInput[] } | { issues: ValidationIssue[] }> {
    const inputs: FinishedJobInput[] = [];
    const issues: ValidationIssue[] = [];
    for (const [position, input] of (request.inputs ?? []).entries()) {
      let sourceLibrary: string | undefined;
      if (library.getAsset(input.asset_id)?.bytesState !== 'present') {
        const source = this.libraries
          .list()
          .map((record) => this.libraries.library(record.id))
          .find(
            (other) =>
              other !== undefined &&
              other.id !== library.id &&
              other.getAsset(input.asset_id)?.bytesState === 'present',
          );
        if (source === undefined) {
          issues.push({
            path: `/request/inputs/${String(position)}/asset_id`,
            message: 'is not an asset with bytes in any library',
          });
          continue;
        }
        await library.copyAssetFrom(source, input.asset_id);
        sourceLibrary = source.id;
      }
      inputs.push({
        position,
        assetId: input.asset_id,
        role: input.role,
        ...(input.weight === undefined ? {} : { weight: input.weight }),
        ...(input.region === undefined ? {} : { region: input.region }),
        ...(input.crop === undefined ? {} : { crop: input.crop }),
        ...(sourceLibrary === undefined ? {} : { sourceLibrary }),
      });
    }
    return issues.length > 0 ? { issues } : { inputs };
  }

  /**
   * Reproduce or Re-roll (A11): a new job from this one's `effective` request
   * on the same route; a re-roll draws a new seed, never the job's own.
   * Reproduce warns when the model's identity differs from when it ran.
   */
  async rerun(
    libraryId: string,
    jobId: string,
    kind: 'reproduce' | 'reroll',
  ): Promise<SubmitOutcome | { ok: false; kind: 'missing' } | { ok: false; kind: 'unresolved' }> {
    const store = this.libraries.jobs(libraryId);
    if (store === undefined) return { ok: false, kind: 'library' };
    const record = store.getJob(jobId);
    if (record === undefined) return { ok: false, kind: 'missing' };
    const effective = store.payloads(jobId)?.effective;
    if (
      effective === null ||
      effective === undefined ||
      typeof effective.sampling.seed !== 'number'
    ) {
      return { ok: false, kind: 'unresolved' };
    }
    const request: GenerationRequest =
      kind === 'reroll'
        ? { ...effective, sampling: { ...effective.sampling, seed: 'random' } }
        : effective;
    const outcome = await this.submit(libraryId, {
      request,
      model: record.modelId,
      ...(record.routeId === null ? {} : { route: record.routeId }),
      parentId: jobId,
      priority: record.priority,
      ...(record.collection === null ? {} : { collection: record.collection }),
      ...(record.endUser === null ? {} : { endUser: record.endUser }),
      ...(kind === 'reroll' ? { seed: { avoid: effective.sampling.seed } } : {}),
    });
    if (!outcome.ok || kind === 'reroll') return outcome;

    const then = isRecord(record.routeSnapshot) ? record.routeSnapshot['fingerprint'] : undefined;
    const route = this.models
      .get(record.modelId)
      ?.routes.find((candidate) => candidate.id === record.routeId);
    if (then === undefined || sameIdentity(then as ModelFingerprint, route?.fingerprint)) {
      return outcome;
    }
    return {
      ...outcome,
      warnings: [
        ...outcome.warnings,
        {
          code: 'environment_changed',
          message:
            'The route serves a different model file than when this job ran, so the result may differ.',
          source: 'resolver',
        },
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Cancel (EN5)
  // -------------------------------------------------------------------------

  /** Cancels as far as the job's state and route allow; answers the job as it now is. */
  async cancel(libraryId: string, jobId: string): Promise<JobRecord | undefined> {
    const store = this.libraries.jobs(libraryId);
    if (store === undefined) return undefined;
    const record = store.getJob(jobId);
    if (record === undefined) return undefined;
    switch (record.state) {
      case 'queued':
        this.move(libraryId, store, jobId, ['queued'], {
          state: 'finished',
          outcome: 'cancelled',
          outcomeReason: 'user',
          finishedAt: this.now(),
          blockedReason: null,
        });
        break;
      case 'submitting':
        // Cancelled as soon as the backend has it.
        this.cancelWanted.add(jobId);
        break;
      case 'dispatched':
      case 'running':
        await this.cancelAtBackend(libraryId, store, record);
        break;
      default:
        break;
    }
    return store.getJob(jobId);
  }

  /**
   * Asks the backend when the route can cancel a job in this state; otherwise
   * (or on a refusal, a 409) the job moves to `cancel_requested`, keeps its
   * slot until the backend says it ended, and its outputs are discarded.
   */
  private async cancelAtBackend(
    libraryId: string,
    store: JobStore,
    record: JobRecord,
  ): Promise<void> {
    const binding = record.routeId === null ? undefined : this.bindings.binding(record.routeId);
    const handle = handleOf(record.backendHandle);
    const control = this.controlOf(record);
    const allowed =
      control !== undefined &&
      (record.state === 'dispatched' ? control.cancel_queued : control.cancel_running);
    if (binding !== undefined && handle !== null && allowed) {
      try {
        await binding.adapter.cancel(handle);
        // The poll sees `cancelled` and finishes the job.
        return;
      } catch (error) {
        if (!(error instanceof CancelRefused)) {
          this.log.warn('A backend failed to cancel a job.', {
            job: record.id,
            error: errorMessage(error),
          });
        }
      }
    }
    this.move(libraryId, store, record.id, ['dispatched', 'running'], {
      state: 'cancel_requested',
    });
  }

  private controlOf(
    record: JobRecord,
  ): { cancel_queued: boolean; cancel_running: boolean } | undefined {
    const route = this.models
      .get(record.modelId)
      ?.routes.find((candidate) => candidate.id === record.routeId);
    const mode = this.live.get(record.id)?.mode;
    if (route === undefined || mode === undefined) return undefined;
    return route.descriptor.modes[mode as keyof typeof route.descriptor.modes]?.control;
  }

  // -------------------------------------------------------------------------
  // The queue
  // -------------------------------------------------------------------------

  /** Every live job: in flight first (oldest dispatch first), then queued in dispatch order. */
  queue(): QueueItem[] {
    const now = this.now();
    const live = [...this.live.values()];
    const inFlight = live
      .filter((job) => IN_FLIGHT.includes(job.record.state))
      .sort((a, b) => (a.record.startedAt ?? 0) - (b.record.startedAt ?? 0));
    const queued = this.ordered();
    return [...inFlight, ...queued].map((job) => {
      const at = retryAtOf(job.record);
      return {
        library: job.library,
        job: job.record,
        mode: job.mode,
        blocked: job.record.state === 'queued' && at !== null && at > now,
      };
    });
  }

  /** Queued jobs in dispatch order: priority first, then age (A19). */
  private ordered(): LiveJob[] {
    return [...this.live.values()]
      .filter((job) => job.record.state === 'queued')
      .sort(
        (a, b) =>
          b.record.priority - a.record.priority ||
          a.record.createdAt - b.record.createdAt ||
          (a.record.id < b.record.id ? -1 : 1),
      );
  }

  private track(library: string, record: JobRecord, mode: string): void {
    if (record.state === 'finished') this.live.delete(record.id);
    else this.live.set(record.id, { library, record, mode });
  }

  /** {@link JobTransitions.apply}, keeping the live index in step. */
  private move(
    libraryId: string,
    store: JobStore,
    id: string,
    from: readonly JobState[],
    change: JobChange,
  ): JobRecord | undefined {
    const record = this.transitions.apply(store, id, from, change);
    if (record !== undefined) {
      const mode = this.live.get(id)?.mode ?? this.modeOf(store, id);
      this.track(libraryId, record, mode);
      if (record.state === 'finished' || record.state === 'queued') this.kick();
    }
    return record;
  }

  private modeOf(store: JobStore, id: string): string {
    return store.payloads(id)?.canonical.mode ?? 'txt2img';
  }

  // -------------------------------------------------------------------------
  // The scheduler (EN3)
  // -------------------------------------------------------------------------

  /** Asks for a scheduling pass, once per tick however often it is asked. */
  kick(): void {
    if (this.stopped || !this.started || this.pumpQueued) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.stopped) return;
    const now = this.now();
    let nextWake = Number.POSITIVE_INFINITY;
    for (const job of this.ordered()) {
      const { record, library } = job;
      if (this.workers.has(record.id)) continue;
      const retryAt = retryAtOf(record);
      if (retryAt !== null && retryAt > now) {
        nextWake = Math.min(nextWake, retryAt);
        continue;
      }
      const store = this.libraries.jobs(library);
      if (store === undefined) continue;
      const binding = record.routeId === null ? undefined : this.bindings.binding(record.routeId);
      if (binding === undefined) {
        const until = now + this.blockedRetryMs;
        this.block(
          library,
          store,
          record.id,
          {
            code: 'route_missing',
            detail: `No backend serves route ${record.routeId ?? '(none)'}.`,
          },
          until,
        );
        nextWake = Math.min(nextWake, until);
        continue;
      }
      if (!this.hasSlot(binding.resourceGroup)) continue;
      this.startWorker(library, record.id, binding.resourceGroup, (signal) =>
        this.dispatch(library, record.id, binding, signal),
      );
    }
    this.scheduleWake(nextWake);
  }

  private scheduleWake(at: number): void {
    if (!Number.isFinite(at) || at >= this.wakeAt) return;
    if (this.wake !== null) clearTimeout(this.wake);
    this.wakeAt = at;
    this.wake = setTimeout(
      () => {
        this.wake = null;
        this.wakeAt = Number.POSITIVE_INFINITY;
        this.kick();
      },
      Math.max(0, at - this.now()),
    );
    this.wake.unref();
  }

  private hasSlot(group: string): boolean {
    let used = 0;
    for (const worker of this.workers.values()) if (worker.group === group) used += 1;
    return used < this.bindings.concurrency(group);
  }

  /**
   * Runs a job's work holding its group's slot, which it gives back however
   * the work ends. Work that throws (a bug) fails its job rather than leaving
   * it in flight for good.
   */
  private startWorker(
    libraryId: string,
    id: string,
    group: string,
    work: (signal: AbortSignal) => Promise<void>,
  ): void {
    const worker: Worker = { group, abort: new AbortController(), done: Promise.resolve() };
    this.workers.set(id, worker);
    worker.done = (async () => {
      try {
        await work(worker.abort.signal);
      } catch (error) {
        this.log.error('A job worker failed unexpectedly.', {
          job: id,
          error: errorMessage(error),
        });
        const store = this.libraries.jobs(libraryId);
        if (store !== undefined && !worker.abort.signal.aborted) {
          try {
            this.finish(libraryId, store, id, ['queued', ...IN_FLIGHT], 'failed', 'backend_error');
          } catch {
            // Already logged; the next start sees the job as it was left.
          }
        }
      } finally {
        this.workers.delete(id);
        this.kick();
      }
    })();
  }

  private block(
    libraryId: string,
    store: JobStore,
    id: string,
    reason: BlockedReason,
    until: number,
  ): void {
    this.move(libraryId, store, id, ['queued'], {
      state: 'queued',
      blockedReason: { ...reason, retry_after: new Date(until).toISOString() },
    });
  }

  // -------------------------------------------------------------------------
  // The worker loop
  // -------------------------------------------------------------------------

  private async dispatch(
    libraryId: string,
    id: string,
    binding: RouteBinding,
    signal: AbortSignal,
  ): Promise<void> {
    const store = this.libraries.jobs(libraryId);
    const library = this.libraries.library(libraryId);
    if (store === undefined || library === undefined) return;
    const record = store.getJob(id);
    if (record?.state !== 'queued' || record.routeId === null) return;
    const routeId = record.routeId;
    const later = (): number => this.now() + this.blockedRetryMs;

    const payloads = store.payloads(id);
    if (payloads?.effective === null || payloads?.effective === undefined) {
      this.finish(libraryId, store, id, ['queued'], 'failed', 'backend_error');
      return;
    }
    const model = this.models.get(record.modelId);
    if (model === undefined) {
      this.block(
        libraryId,
        store,
        id,
        { code: 'route_missing', detail: `Model ${record.modelId} is gone.` },
        later(),
      );
      return;
    }
    const provisional = (
      isRecord(record.routeSnapshot) ? record.routeSnapshot : {}
    ) as ProvisionalSnapshot;
    const finalised = await this.resolver.finalise(
      {
        canonical: payloads.canonical,
        route: { id: routeId },
        effective: payloads.effective,
        ...(provisional.fingerprint === undefined ? {} : { fingerprint: provisional.fingerprint }),
      },
      model,
      { inputSize: inputSizer(this.libraries, libraryId) },
    );
    if (!finalised.ok) {
      this.block(libraryId, store, id, finalised.blocked_reason, later());
      return;
    }
    const route = model.routes.find((candidate) => candidate.id === routeId);

    // The model's identity, from the backend, against the catalog's (A12, L4).
    let identity: ModelIdentity | null;
    try {
      identity = await binding.adapter.identify(routeId);
    } catch (error) {
      this.block(
        libraryId,
        store,
        id,
        { code: 'routes_down', detail: errorMessage(error) },
        later(),
      );
      return;
    }
    if (
      identity !== null &&
      route?.fingerprint !== undefined &&
      !sameIdentity(identity, route.fingerprint)
    ) {
      this.block(
        libraryId,
        store,
        id,
        {
          code: 'identity_changed',
          detail: `Route ${routeId} now serves another model than the one it was registered with.`,
        },
        later(),
      );
      return;
    }

    let effective: GenerationRequest;
    let inputs: FinishedJobInput[];
    let wire: unknown;
    try {
      ({ effective, inputs } = await this.applyCrops(
        library,
        store,
        id,
        model,
        finalised.resolution.effective,
      ));
      wire = await binding.adapter.prepare(routeId, effective);
    } catch (error) {
      this.log.warn('A job could not be prepared.', { job: id, error: errorMessage(error) });
      this.finish(libraryId, store, id, ['queued'], 'failed', 'backend_error');
      return;
    }

    const routeSnapshot = {
      model_id: model.id,
      family: model.family,
      ...(model.variant === undefined ? {} : { variant: model.variant }),
      fingerprint: identity ?? route?.fingerprint ?? null,
      backend: {
        id: binding.backendId,
        kind: binding.backendKind,
        base_url: binding.baseUrl,
        ...(binding.manager === undefined ? {} : { manager: binding.manager }),
      },
      descriptor_digest: finalised.resolution.descriptor_digest,
    };
    const submitting = this.move(libraryId, store, id, ['queued'], {
      state: 'submitting',
      effective,
      fieldReport: finalised.resolution.field_report,
      wire,
      routeSnapshot,
      blockedReason: null,
      startedAt: this.now(),
    });
    // Cancelled while it was being prepared.
    if (submitting === undefined) return;
    store.replaceInputs(id, inputs);

    let filled: unknown;
    try {
      const bytes = new Map<string, Uint8Array>();
      for (const assetId of placeholderIds(wire)) {
        const read = await library.readAsset(assetId);
        if (read.kind !== 'present') throw new Error(`Input asset ${assetId} has no bytes.`);
        bytes.set(assetId, read.bytes);
      }
      filled = fillPlaceholders(wire, (assetId) => bytes.get(assetId) ?? new Uint8Array());
    } catch (error) {
      this.log.warn('A job input could not be read.', { job: id, error: errorMessage(error) });
      this.finish(libraryId, store, id, ['submitting'], 'failed', 'backend_error');
      return;
    }

    let handle: JobHandle;
    try {
      handle = await binding.adapter.submit(routeId, filled, signal);
    } catch (error) {
      // Stopping: left `submitting`, which the next start records as interrupted.
      if (signal.aborted) return;
      if (error instanceof RejectedBeforeStart) {
        const until =
          error.retryAfterS === undefined ? later() : this.now() + error.retryAfterS * 1000;
        this.move(libraryId, store, id, ['submitting'], {
          state: 'queued',
          blockedReason: {
            code: 'backend_rejected',
            detail: error.message,
            retry_after: new Date(until).toISOString(),
          },
          startedAt: null,
        });
        this.scheduleWake(until);
        return;
      }
      this.log.warn('A backend refused a submit.', { job: id, error: errorMessage(error) });
      this.finish(libraryId, store, id, ['submitting'], 'failed', 'backend_error');
      return;
    }

    const dispatched = this.move(libraryId, store, id, ['submitting'], {
      state: 'dispatched',
      backendHandle: handle,
    });
    if (dispatched === undefined) return;
    if (this.cancelWanted.delete(id)) await this.cancelAtBackend(libraryId, store, dispatched);
    await this.watch(libraryId, store, library, id, handle, binding, signal);
  }

  /**
   * Inputs with a crop the route emulates are cut into derived assets (A7),
   * and the effective request and the inputs then name those, without the crop.
   * A route that crops natively gets the crop as asked.
   */
  private async applyCrops(
    library: Library,
    store: JobStore,
    id: string,
    model: ResolverModel,
    effective: GenerationRequest,
  ): Promise<{ effective: GenerationRequest; inputs: FinishedJobInput[] }> {
    const stored = store.inputs(id);
    if (effective.inputs?.some((input) => input.crop !== undefined) !== true) {
      return { effective, inputs: stored };
    }
    const route = model.routes.find((candidate) => candidate.id === store.getJob(id)?.routeId);
    const fields = route?.descriptor.modes[effective.mode]?.fields ?? {};
    const inputs = [...stored];
    const requested = [];
    for (const [position, input] of effective.inputs.entries()) {
      if (input.crop === undefined || fields[`inputs.${input.role}.crop`]?.state === 'native') {
        requested.push(input);
        continue;
      }
      const { asset } = await library.deriveCrop(input.asset_id, input.crop);
      const uncropped = { ...input, asset_id: asset.id };
      delete uncropped.crop;
      requested.push(uncropped);
      const at = inputs.findIndex((item) => item.position === position);
      const current = inputs[at];
      if (current !== undefined) inputs[at] = { ...current, assetId: asset.id };
    }
    return { effective: { ...effective, inputs: requested }, inputs };
  }

  /** Polls a dispatched job until it ends, goes back to the queue, or the engine stops. */
  private async watch(
    libraryId: string,
    store: JobStore,
    library: Library,
    id: string,
    handle: JobHandle,
    binding: RouteBinding,
    signal: AbortSignal,
  ): Promise<void> {
    let failures = 0;
    let lastProgress = '';
    while (!signal.aborted) {
      let status: JobStatus;
      try {
        status = await binding.adapter.status(handle);
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= STATUS_FAILURES_TOLERATED) {
          this.log.warn('A backend stopped answering for a job.', {
            job: id,
            error: errorMessage(error),
          });
          this.finish(libraryId, store, id, IN_FLIGHT, 'failed', 'backend_lost');
          return;
        }
        await sleep(this.pollMs, signal);
        continue;
      }
      // The status call may have outlived a stop.
      if ((signal as { aborted: boolean }).aborted) return;
      const current = store.getJob(id);
      if (current === undefined || current.state === 'finished') return;
      const cancelling = current.state === 'cancel_requested';

      switch (status.state) {
        case 'queued':
        case 'running': {
          const progress = {
            ...(status.progress ?? {}),
            ...(status.waiting === undefined ? {} : { waiting: status.waiting }),
          };
          delete (progress as { preview?: unknown }).preview;
          const serialised = JSON.stringify(progress);
          if (status.state === 'running' && current.state === 'dispatched') {
            this.move(libraryId, store, id, ['dispatched'], { state: 'running', progress });
          } else if (serialised !== lastProgress) {
            // A changed wait reason is worth a row (the queue shows it); steps are events only.
            if (status.waiting !== undefined && current.state === 'dispatched') {
              this.move(libraryId, store, id, ['dispatched'], { progress });
            } else {
              this.transitions.progress(libraryId, id, progress);
            }
          }
          lastProgress = serialised;
          break;
        }
        case 'done':
          if (cancelling) {
            this.finish(libraryId, store, id, ['cancel_requested'], 'cancelled', 'user');
          } else {
            await this.complete(libraryId, store, library, id, handle, binding, status.result);
          }
          return;
        case 'failed':
          // Only a job that never started can go back; a running one did start.
          if (status.started === false && current.state === 'dispatched') {
            const until =
              status.retry_after_s === undefined
                ? this.now() + this.blockedRetryMs
                : this.now() + status.retry_after_s * 1000;
            // The only way back (L5): it keeps its seed; its handle is cleared.
            this.move(libraryId, store, id, ['dispatched'], {
              state: 'queued',
              blockedReason: {
                code: 'backend_rejected',
                detail: status.reason ?? 'The backend turned the job away before starting it.',
                retry_after: new Date(until).toISOString(),
              },
              backendHandle: null,
              progress: null,
              startedAt: null,
            });
            this.scheduleWake(until);
          } else {
            this.finish(
              libraryId,
              store,
              id,
              IN_FLIGHT,
              cancelling ? 'cancelled' : 'failed',
              cancelling ? 'user' : 'backend_error',
            );
          }
          return;
        case 'refused':
          this.finish(libraryId, store, id, IN_FLIGHT, 'refused', status.reason ?? 'refused');
          return;
        case 'cancelled':
          this.finish(libraryId, store, id, IN_FLIGHT, 'cancelled', 'user');
          return;
        case 'lost':
          this.finish(
            libraryId,
            store,
            id,
            IN_FLIGHT,
            cancelling ? 'cancelled' : 'failed',
            cancelling ? 'user' : 'backend_lost',
          );
          return;
      }
      await sleep(this.pollMs, signal);
    }
  }

  /** The results: spooled and fsynced first (A17), then ingested. */
  private async complete(
    libraryId: string,
    store: JobStore,
    library: Library,
    id: string,
    handle: JobHandle,
    binding: RouteBinding,
    carried: FetchedResult | undefined,
  ): Promise<void> {
    let result: FetchedResult;
    try {
      result = carried ?? (await binding.adapter.fetchResult(handle));
    } catch (error) {
      this.log.warn('A finished job’s results could not be fetched.', {
        job: id,
        error: errorMessage(error),
      });
      this.finish(libraryId, store, id, IN_FLIGHT, 'failed', 'backend_lost');
      return;
    }
    const spooled: SpooledResult = {
      outputs: result.outputs,
      metadata: result.metadata,
      ...(result.generator === undefined ? {} : { generator: result.generator }),
      finishedAt: this.now(),
    };
    await store.spool(id, spooled);
    await this.ingest(libraryId, store, library, id, spooled);
  }

  /** A spooled result into the library, then the spool cleared. */
  private async ingest(
    libraryId: string,
    store: JobStore,
    library: Library,
    id: string,
    spooled: SpooledResult,
  ): Promise<void> {
    const record = store.getJob(id);
    const payloads = store.payloads(id);
    if (record === undefined || payloads === undefined) return;
    const snapshot = isRecord(record.routeSnapshot) ? record.routeSnapshot : {};
    const job: FinishedJob = {
      id,
      modelId: record.modelId,
      routeId: record.routeId,
      routeSnapshot: { ...snapshot, generator: spooled.generator ?? null },
      outcome: 'done',
      createdAt: record.createdAt,
      finishedAt: spooled.finishedAt,
      canonical: payloads.canonical,
      priority: record.priority,
      inputs: store.inputs(id),
      outputs: spooled.outputs,
      ...(record.startedAt === null ? {} : { startedAt: record.startedAt }),
      ...(payloads.effective === null ? {} : { effective: payloads.effective }),
      ...(payloads.fieldReport === null ? {} : { fieldReport: payloads.fieldReport }),
      ...(payloads.wire === null ? {} : { wire: payloads.wire }),
      ...(spooled.metadata === null ? {} : { backendResponse: spooled.metadata }),
      ...(record.parentId === null ? {} : { parentId: record.parentId }),
      ...(record.clientId === null ? {} : { clientId: record.clientId }),
      ...(record.endUser === null ? {} : { endUser: record.endUser }),
      ...(record.collection === null ? {} : { collection: record.collection }),
      ...(record.idempotencyKey === null ? {} : { idempotencyKey: record.idempotencyKey }),
    };
    try {
      const imported = await this.transitions.finishWithOutputs(library, job);
      this.track(libraryId, imported.job, this.live.get(id)?.mode ?? payloads.canonical.mode);
    } catch (error) {
      this.log.error('A job’s outputs could not be ingested.', {
        job: id,
        error: errorMessage(error),
      });
      this.finish(libraryId, store, id, ['queued', ...IN_FLIGHT], 'failed', 'ingest_failed');
    }
    await store.clearSpool(id);
    this.kick();
  }

  private finish(
    libraryId: string,
    store: JobStore,
    id: string,
    from: readonly JobState[],
    outcome: JobOutcome,
    reason: string,
  ): void {
    this.cancelWanted.delete(id);
    this.move(libraryId, store, id, from, {
      state: 'finished',
      outcome,
      outcomeReason: reason,
      finishedAt: this.now(),
      backendHandle: null,
      progress: null,
      blockedReason: null,
    });
  }

  // -------------------------------------------------------------------------
  // Recovery (EN5)
  // -------------------------------------------------------------------------

  private async recoverLibrary(store: JobStore, library: Library): Promise<void> {
    const libraryId = library.id;
    // A crash between completion and ingest: the spool holds the results (A17).
    for (const id of await store.spooledJobs()) {
      const record = store.getJob(id);
      if (record === undefined || record.state === 'finished') {
        await store.clearSpool(id);
        continue;
      }
      const spooled = await store.readSpool(id);
      if (spooled === null) continue;
      this.track(libraryId, record, this.modeOf(store, id));
      this.log.info('Ingesting the spooled results of a job.', { library: libraryId, job: id });
      await this.ingest(libraryId, store, library, id, spooled);
    }

    for (const record of store.liveJobs()) {
      const mode = this.modeOf(store, record.id);
      this.track(libraryId, record, mode);
      switch (record.state) {
        case 'queued':
          break;
        case 'submitting':
          this.finish(libraryId, store, record.id, ['submitting'], 'failed', 'interrupted');
          break;
        case 'dispatched':
        case 'running':
        case 'cancel_requested':
          await this.resume(libraryId, store, library, record);
          break;
        default:
          break;
      }
    }
  }

  private async resume(
    libraryId: string,
    store: JobStore,
    library: Library,
    record: JobRecord,
  ): Promise<void> {
    const cancelling = record.state === 'cancel_requested';
    const handle = handleOf(record.backendHandle);
    const binding = record.routeId === null ? undefined : this.bindings.binding(record.routeId);
    const lostAs: [JobOutcome, string] = cancelling
      ? ['cancelled', 'user']
      : ['failed', 'backend_lost'];
    if (handle === null || binding === undefined) {
      this.finish(libraryId, store, record.id, IN_FLIGHT, ...lostAs);
      return;
    }
    if (!handle.resumable) {
      this.finish(
        libraryId,
        store,
        record.id,
        IN_FLIGHT,
        cancelling ? 'cancelled' : 'failed',
        cancelling ? 'user' : 'interrupted',
      );
      return;
    }
    let identity: ModelIdentity | null;
    try {
      identity = await binding.adapter.identify(binding.routeId);
    } catch {
      identity = null;
    }
    // Another instance, or another model on a reused port, must not answer for this job.
    if (
      handle.instance.base_url !== binding.baseUrl ||
      !sameIdentity(handle.instance.model, identity)
    ) {
      this.log.warn('A job’s backend instance changed while Lantern was down.', { job: record.id });
      this.finish(libraryId, store, record.id, IN_FLIGHT, ...lostAs);
      return;
    }
    this.log.info('Resuming a job dispatched before the restart.', {
      library: libraryId,
      job: record.id,
    });
    this.startWorker(libraryId, record.id, binding.resourceGroup, (signal) =>
      this.watch(libraryId, store, library, record.id, handle, binding, signal),
    );
  }
}
