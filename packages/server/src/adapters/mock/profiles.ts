// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The mock's behaviour profiles (EN2; plan, "Testing"): each reproduces what
 * a real backend does that the engine must survive.
 *
 * - `basic`: async and resumable, cancels at any time, reports a fraction.
 * - `sdserver`: like sd-server's native API. Resumable handles, results kept
 *   `retentionMs` (10 minutes) after a job ends and then lost (410), a running
 *   job cannot be cancelled (409), progress in steps.
 * - `sync`: a synchronous backend (OpenAI-compatible, sdapi): `submit` blocks
 *   until the images exist, and its handles cannot survive a restart.
 * - `port_reuse`: after `swapAfter` submits, another model answers on the
 *   same address (an unload and a load under Lemonade).
 * - `lost`: every job is unknown to the backend once submitted (404, 410).
 * - `orchd`: a manager. Routes start cold and load on the first job (a
 *   wait with reason `loading`), jobs may wait for memory first, and the
 *   first `rejectSubmits` submits are turned away before start with a
 *   `retry_after` (a yield), as are the first `yieldJobs` jobs after they
 *   were accepted (a queue timeout) (L5).
 */

export const MOCK_PROFILES = ['basic', 'sdserver', 'sync', 'port_reuse', 'lost', 'orchd'] as const;
export type MockProfile = (typeof MOCK_PROFILES)[number];

export function isMockProfile(value: unknown): value is MockProfile {
  return typeof value === 'string' && (MOCK_PROFILES as readonly string[]).includes(value);
}

/** The mock's settings (`backends.config`), all optional. */
export interface MockSettings {
  readonly profile?: MockProfile;
  /** How long one sampling step takes. */
  readonly stepMs?: number;
  /** The fraction of jobs that fail, decided by the seed so a rerun fails the same way. */
  readonly failureRate?: number;
  /** sdserver: how long a result is kept after its job ends. */
  readonly retentionMs?: number;
  /** orchd: how long a cold route takes to load. */
  readonly loadMs?: number;
  /** orchd: how long each job waits for memory before it starts. */
  readonly memoryWaitMs?: number;
  /** orchd: how many submits are turned away before start. */
  readonly rejectSubmits?: number;
  /** orchd: how many accepted jobs then fail before start. */
  readonly yieldJobs?: number;
  /** orchd: the `retry_after` given with a turn-away, in seconds. */
  readonly retryAfterS?: number;
  /** port_reuse: after how many submits the other model answers. */
  readonly swapAfter?: number;
}

/** The defaults, per profile. */
export function settingsFor(settings: MockSettings): Required<MockSettings> {
  const profile = settings.profile ?? 'basic';
  return {
    profile,
    stepMs: settings.stepMs ?? 40,
    failureRate: settings.failureRate ?? 0,
    retentionMs: settings.retentionMs ?? 10 * 60 * 1000,
    loadMs: settings.loadMs ?? (profile === 'orchd' ? 300 : 0),
    memoryWaitMs: settings.memoryWaitMs ?? (profile === 'orchd' ? 100 : 0),
    rejectSubmits: settings.rejectSubmits ?? (profile === 'orchd' ? 1 : 0),
    yieldJobs: settings.yieldJobs ?? 0,
    retryAfterS: settings.retryAfterS ?? 1,
    swapAfter: settings.swapAfter ?? 1,
  };
}
