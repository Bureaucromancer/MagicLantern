// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The job state machine (A16, EN4) and the one function every state change
 * goes through: it checks the edge, writes the row (compare-and-set, with any
 * payload columns in the same transaction) and publishes `job.updated`.
 *
 * ```
 * queued ──► submitting ──► dispatched ──► running ──► finished
 *   │  ▲         │   │          │  │  │        │
 *   │  └─────────┘   │          │  │  └──► cancel_requested ──► finished
 *   │  (before start)│          │  └── (before start) ──► queued
 *   └──► finished    └──► finished
 * ```
 *
 * The only backwards edges lead to `queued`, for a job a backend turned away
 * before it started (L5): it keeps its seed, its handle is cleared, and its
 * effective and wire requests are finalised again at the next dispatch.
 * Finishing with outputs goes through {@link JobTransitions.finishWithOutputs},
 * which hands the job to the library's `importFinishedJob`.
 */

import type {
  FinishedJob,
  ImportedJob,
  JobChange,
  JobRecord,
  JobState,
  JobStore,
  Library,
} from '../../store/index.js';
import { toAssetSummary, toJobSummary } from '../../wire.js';
import type { EventBus } from './events.js';

/** Where each state may go. A state may also stay put (a blocked reason or progress update). */
export const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ['queued', 'submitting', 'finished'],
  submitting: ['dispatched', 'queued', 'finished'],
  dispatched: ['dispatched', 'running', 'queued', 'cancel_requested', 'finished'],
  running: ['running', 'cancel_requested', 'finished'],
  cancel_requested: ['cancel_requested', 'finished'],
  finished: [],
};

export function canMove(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class JobTransitions {
  private readonly events: EventBus;

  constructor(events: EventBus) {
    this.events = events;
  }

  /**
   * Moves a job if it is in one of `from`; undefined when it was not (another
   * change got there first). Throws for an edge the machine does not have,
   * which is a bug in the caller.
   */
  apply(
    store: JobStore,
    id: string,
    from: readonly JobState[],
    change: JobChange,
  ): JobRecord | undefined {
    const to = change.state;
    if (to !== undefined) {
      for (const state of from) {
        if (!canMove(state, to)) throw new Error(`A job cannot move from ${state} to ${to}.`);
      }
      if ((to === 'finished') !== (change.outcome !== undefined)) {
        throw new Error('A job has an outcome exactly when it finishes.');
      }
    }
    const record = store.transition(id, from, change);
    if (record !== undefined) {
      this.events.publish({
        type: 'job.updated',
        data: { library: store.libraryId, job: toJobSummary(store.libraryId, record) },
      });
    }
    return record;
  }

  /** Finishes a job by importing its outputs (A18), then says so: the job, then each asset. */
  async finishWithOutputs(library: Library, job: FinishedJob): Promise<ImportedJob> {
    const imported = await library.importFinishedJob(job);
    if (imported.imported) {
      this.events.publish({
        type: 'job.updated',
        data: { library: library.id, job: toJobSummary(library.id, imported.job) },
      });
      for (const asset of imported.outputs) {
        this.events.publish({
          type: 'asset.created',
          data: { library: library.id, asset: toAssetSummary(asset) },
        });
      }
    }
    return imported;
  }

  /** Publishes progress without writing a row: progress changes too often to store each tick. */
  progress(library: string, jobId: string, progress: Readonly<Record<string, unknown>>): void {
    this.events.publish({
      type: 'job.progress',
      data: { library, job_id: jobId, progress },
    });
  }
}
