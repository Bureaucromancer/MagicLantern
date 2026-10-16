// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { afterEach, describe, expect, it } from 'vitest';

import { newId } from '../../ids.js';
import type { JobRecord, JobState } from '../../store/index.js';
import { makePng } from '../../store/test-images.js';
import { JobEngine, type SubmitOutcome } from './engine.js';
import { canMove, TRANSITIONS } from './transitions.js';
import {
  DEV_MODEL_ID,
  engineHarness,
  smallRequest,
  type EngineHarness,
  type HarnessOptions,
} from './test-engine.js';

const harnesses: EngineHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
});

async function start(options: HarnessOptions = {}): Promise<EngineHarness> {
  const harness = await engineHarness(options);
  harnesses.push(harness);
  return harness;
}

function submitted(outcome: SubmitOutcome): JobRecord {
  if (!outcome.ok) throw new Error(`Submit failed: ${JSON.stringify(outcome)}`);
  return outcome.job;
}

async function submit(harness: EngineHarness, overrides = {}, extra = {}): Promise<JobRecord> {
  return submitted(
    await harness.engine.submit(harness.lib, {
      request: smallRequest(overrides),
      model: DEV_MODEL_ID,
      ...extra,
    }),
  );
}

function job(harness: EngineHarness, id: string): JobRecord {
  const record = harness.libraries.jobs(harness.lib)!.getJob(id);
  if (record === undefined) throw new Error(`No job ${id}.`);
  return record;
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting.');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** The states a job went through, from its `job.updated` events, repeats folded. */
function statesOf(harness: EngineHarness, id: string): JobState[] {
  const states: JobState[] = [];
  for (const event of harness.seen) {
    if (event.type !== 'job.updated' || event.data.job.id !== id) continue;
    const state = event.data.job.state;
    if (states.at(-1) !== state) states.push(state);
  }
  return states;
}

describe('the state machine', () => {
  it('goes back only to queued, and nowhere from finished', () => {
    expect(TRANSITIONS.finished).toEqual([]);
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const to of targets) {
        if (to !== from && ['queued'].includes(to)) {
          expect(['queued', 'submitting', 'dispatched'], `${from} → ${to}`).toContain(from);
        }
      }
    }
    expect(canMove('running', 'queued')).toBe(false);
    expect(canMove('cancel_requested', 'running')).toBe(false);
  });
});

describe('a job on the mock adapter', () => {
  it('runs end to end: queued, submitting, dispatched, running, finished, with its outputs stored', async () => {
    const harness = await start();
    const record = await submit(harness, { count: 2 });
    expect(record.state).toBe('queued');
    await harness.engine.settled();

    const done = job(harness, record.id);
    expect(done).toMatchObject({ state: 'finished', outcome: 'done', outcomeReason: null });
    expect(statesOf(harness, record.id)).toEqual([
      'queued',
      'submitting',
      'dispatched',
      'running',
      'finished',
    ]);

    const library = harness.libraries.library(harness.lib)!;
    const outputs = library.jobOutputs(record.id);
    // Output k uses seed + k (A1).
    expect(outputs.map((asset) => asset.outputOf?.seed)).toEqual([42, 43]);
    const created = harness.seen.filter((event) => event.type === 'asset.created');
    expect(created).toHaveLength(2);

    const provenance = library.provenance(outputs[0]!.id)!;
    expect(provenance.job?.wire).toMatchObject({
      seed: 42,
      width: 64,
      prompt: 'a lighthouse at dusk',
    });
    expect(provenance.job?.record.routeSnapshot).toMatchObject({
      model_id: DEV_MODEL_ID,
      backend: { kind: 'mock', base_url: 'mock://dev' },
      generator: 'lantern-mock 1',
      fingerprint: { kind: 'file', stem: 'mock-sdxl' },
    });
    // The backend's parameters chunk is kept and read into backend_response.
    expect(JSON.stringify(provenance.job?.backendResponse)).toContain('Generator: lantern-mock 1');
    // Nothing is left in the spool.
    expect(await harness.libraries.jobs(harness.lib)!.spooledJobs()).toEqual([]);
  });

  it('fixes a random seed at submit and keeps it through dispatch', async () => {
    const harness = await start({ drawSeed: () => 777 });
    const record = await submit(harness, { sampling: { seed: 'random', steps: 2 } });
    const store = harness.libraries.jobs(harness.lib)!;
    expect(store.payloads(record.id)?.effective?.sampling.seed).toBe(777);
    expect(store.payloads(record.id)?.canonical.sampling.seed).toBe('random');
    await harness.engine.settled();
    expect(store.payloads(record.id)?.effective?.sampling.seed).toBe(777);
    expect(harness.libraries.library(harness.lib)!.jobOutputs(record.id)[0]?.outputOf?.seed).toBe(
      777,
    );
  });

  it('reproduces an output exactly, and re-rolls with another seed (A11, A25)', async () => {
    const harness = await start({
      drawSeed: (() => {
        let n = 0;
        return () => (n += 1000);
      })(),
    });
    const original = await submit(harness);
    await harness.engine.settled();
    const reproduced = submitted(
      (await harness.engine.rerun(harness.lib, original.id, 'reproduce')) as SubmitOutcome,
    );
    const rerolled = submitted(
      (await harness.engine.rerun(harness.lib, original.id, 'reroll')) as SubmitOutcome,
    );
    expect(reproduced.parentId).toBe(original.id);
    await harness.engine.settled();

    const library = harness.libraries.library(harness.lib)!;
    const hash = (id: string) => library.jobOutputs(id)[0]?.pixelHash;
    expect(hash(reproduced.id)).toBe(hash(original.id));
    // Different files (the lantern chunk names the job), identical pixels.
    expect(library.jobOutputs(reproduced.id)[0]?.id).not.toBe(
      library.jobOutputs(original.id)[0]?.id,
    );
    expect(hash(rerolled.id)).not.toBe(hash(original.id));
    expect(
      harness.libraries.jobs(harness.lib)!.payloads(rerolled.id)?.effective?.sampling.seed,
    ).not.toBe(42);
  });

  it('runs one job at a time per resource group, highest priority first, then oldest', async () => {
    const harness = await start({ mock: { stepMs: 3 } });
    const first = await submit(harness);
    const low = await submit(harness);
    const high = await submit(harness, {}, { priority: 5 });

    let inFlight = 0;
    let most = 0;
    harness.events.subscribe((event) => {
      if (event.type !== 'job.updated') return;
      inFlight = harness.engine.queue().filter((item) => item.job.state !== 'queued').length;
      most = Math.max(most, inFlight);
    });
    await harness.engine.settled();
    expect(most).toBe(1);
    const finishedAt = (id: string) => job(harness, id).finishedAt ?? 0;
    expect(finishedAt(first.id)).toBeLessThanOrEqual(finishedAt(high.id));
    expect(finishedAt(high.id)).toBeLessThanOrEqual(finishedAt(low.id));
  });

  it('fails as backend_error when the backend fails the job', async () => {
    const harness = await start({ mock: { failureRate: 1 } });
    const record = await submit(harness);
    await harness.engine.settled();
    expect(job(harness, record.id)).toMatchObject({
      outcome: 'failed',
      outcomeReason: 'backend_error',
    });
  });

  it('fails as backend_lost when the backend forgets the job (404, 410)', async () => {
    const harness = await start({ mock: { profile: 'lost' } });
    const record = await submit(harness);
    await harness.engine.settled();
    expect(job(harness, record.id)).toMatchObject({
      outcome: 'failed',
      outcomeReason: 'backend_lost',
    });
  });

  it('runs on a synchronous backend', async () => {
    const harness = await start({ mock: { profile: 'sync' } });
    const record = await submit(harness);
    await harness.engine.settled();
    expect(job(harness, record.id).outcome).toBe('done');
  });
});

describe('before start (L5, L6)', () => {
  it('puts a job a manager turned away back in the queue with retry_after, keeping its seed', async () => {
    const harness = await start({
      mock: { profile: 'orchd', rejectSubmits: 1, retryAfterS: 0.05, loadMs: 20, memoryWaitMs: 5 },
    });
    const record = await submit(harness);
    await waitFor(() => statesOf(harness, record.id).includes('dispatched'));
    const blocked = harness.seen.find(
      (event) =>
        event.type === 'job.updated' &&
        event.data.job.id === record.id &&
        event.data.job.blocked_reason?.code === 'backend_rejected',
    );
    expect(blocked?.type === 'job.updated' && blocked.data.job.blocked_reason?.retry_after).toEqual(
      expect.any(String),
    );
    await waitFor(() => job(harness, record.id).state === 'finished');
    expect(job(harness, record.id).outcome).toBe('done');
    expect(statesOf(harness, record.id).slice(0, 3)).toEqual(['queued', 'submitting', 'queued']);
    // The waits were reported, with the manager's reasons.
    const reasons = harness.seen.flatMap((event) =>
      event.type === 'job.updated' && event.data.job.progress?.waiting !== undefined
        ? [event.data.job.progress.waiting.reason]
        : [],
    );
    expect(reasons).toEqual(expect.arrayContaining(['memory', 'loading']));
  });

  it('puts a job that failed before start back in the queue, then runs it with the same seed', async () => {
    const harness = await start({
      mock: {
        profile: 'orchd',
        rejectSubmits: 0,
        yieldJobs: 1,
        retryAfterS: 0.02,
        loadMs: 0,
        memoryWaitMs: 5,
      },
    });
    const record = await submit(harness);
    // settled() would return while it waits out its retry_after, blocked.
    await waitFor(() => job(harness, record.id).state === 'finished');
    const states = statesOf(harness, record.id);
    expect(states).toEqual([
      'queued',
      'submitting',
      'dispatched',
      'queued',
      'submitting',
      'dispatched',
      'running',
      'finished',
    ]);
    expect(harness.libraries.library(harness.lib)!.jobOutputs(record.id)[0]?.outputOf?.seed).toBe(
      42,
    );
  });

  it('blocks a job when another model answers on the route (identity_changed)', async () => {
    const harness = await start({
      mock: { profile: 'port_reuse', swapAfter: 1 },
      blockedRetryMs: 60_000,
    });
    const first = await submit(harness);
    await harness.engine.settled();
    expect(job(harness, first.id).outcome).toBe('done');
    const second = await submit(harness);
    await harness.engine.settled();
    expect(job(harness, second.id)).toMatchObject({
      state: 'queued',
      blockedReason: { code: 'identity_changed' },
    });
  });
});

describe('cancelling (EN5)', () => {
  it('cancels a queued job at once', async () => {
    const harness = await start({ mock: { stepMs: 20 } });
    const running = await submit(harness, { sampling: { seed: 1, steps: 10 } });
    const queued = await submit(harness);
    const cancelled = await harness.engine.cancel(harness.lib, queued.id);
    expect(cancelled).toMatchObject({
      state: 'finished',
      outcome: 'cancelled',
      outcomeReason: 'user',
    });
    await harness.engine.cancel(harness.lib, running.id);
    await harness.engine.settled();
  });

  it('cancels a running job at a backend that can', async () => {
    const harness = await start({ mock: { stepMs: 20 } });
    const record = await submit(harness, { sampling: { seed: 1, steps: 20 } });
    await waitFor(() => job(harness, record.id).state === 'running');
    await harness.engine.cancel(harness.lib, record.id);
    await harness.engine.settled();
    expect(job(harness, record.id)).toMatchObject({ outcome: 'cancelled', outcomeReason: 'user' });
    expect(harness.libraries.library(harness.lib)!.jobOutputs(record.id)).toEqual([]);
  });

  it('waits out a running job a backend cannot stop, and discards its outputs (sd-server)', async () => {
    const harness = await start({ mock: { profile: 'sdserver', stepMs: 10 } });
    const record = await submit(harness, { sampling: { seed: 1, steps: 6 } });
    await waitFor(() => job(harness, record.id).state === 'running');
    const asked = await harness.engine.cancel(harness.lib, record.id);
    expect(asked?.state).toBe('cancel_requested');
    await harness.engine.settled();
    expect(job(harness, record.id)).toMatchObject({ outcome: 'cancelled', outcomeReason: 'user' });
    expect(harness.libraries.library(harness.lib)!.jobOutputs(record.id)).toEqual([]);
    expect(statesOf(harness, record.id)).toContain('cancel_requested');
  });
});

describe('restart recovery (EN5)', () => {
  it('resumes a job that was running when the daemon stopped', async () => {
    const harness = await start({ mock: { stepMs: 15 } });
    const record = await submit(harness, { sampling: { seed: 5, steps: 8 } });
    await waitFor(() => job(harness, record.id).state === 'running');
    await harness.restart();
    await harness.engine.settled();
    expect(job(harness, record.id)).toMatchObject({ state: 'finished', outcome: 'done' });
    expect(harness.libraries.library(harness.lib)!.jobOutputs(record.id)).toHaveLength(1);
  });

  it('fails a job as backend_lost when the backend restarted too', async () => {
    const harness = await start({ mock: { stepMs: 15 } });
    const record = await submit(harness, { sampling: { seed: 5, steps: 8 } });
    await waitFor(() => job(harness, record.id).state === 'running');
    await harness.restart({ freshBackend: true });
    await harness.engine.settled();
    expect(job(harness, record.id)).toMatchObject({
      outcome: 'failed',
      outcomeReason: 'backend_lost',
    });
  });

  it('fails a job with an ephemeral handle as interrupted', async () => {
    const harness = await start({ mock: { profile: 'sync', stepMs: 5 } });
    const record = await submit(harness, { sampling: { seed: 5, steps: 20 } });
    await waitFor(() => job(harness, record.id).state === 'submitting');
    // A synchronous submit is in flight: stopping leaves it submitting.
    await harness.restart();
    await harness.engine.settled();
    expect(job(harness, record.id)).toMatchObject({
      outcome: 'failed',
      outcomeReason: 'interrupted',
    });
  });

  it('ingests the spool of a job that finished just before a crash (A17)', async () => {
    const harness = await start({ mock: { stepMs: 5 } });
    const record = await submit(harness, { sampling: { seed: 9, steps: 4 } });
    await waitFor(() => job(harness, record.id).state === 'running');
    const store = harness.libraries.jobs(harness.lib)!;
    await harness.restart({
      // The crash: the result reached the spool, and nothing after it ran.
      beforeStart: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        const handle = job(harness, record.id).backendHandle as never;
        const result = await harness.adapter.fetchResult(handle);
        await store.spool(record.id, { ...result, finishedAt: Date.now() });
      },
    });
    await harness.engine.settled();
    expect(job(harness, record.id)).toMatchObject({ state: 'finished', outcome: 'done' });
    expect(harness.libraries.library(harness.lib)!.jobOutputs(record.id)[0]?.outputOf?.seed).toBe(
      9,
    );
    expect(await store.spooledJobs()).toEqual([]);
  });

  it('keeps queued jobs queued and runs them after the restart', async () => {
    const harness = await start({ mock: { stepMs: 10 } });
    const first = await submit(harness, { sampling: { seed: 1, steps: 6 } });
    const second = await submit(harness);
    await waitFor(() => job(harness, first.id).state === 'running');
    await harness.restart();
    await harness.engine.settled();
    expect(job(harness, second.id).outcome).toBe('done');
  });
});

describe('submit (EN6)', () => {
  it('answers the same job for the same idempotency key and body, and refuses another body', async () => {
    const harness = await start();
    const first = await harness.engine.submit(harness.lib, {
      request: smallRequest(),
      model: DEV_MODEL_ID,
      idempotencyKey: 'k-1',
    });
    const again = await harness.engine.submit(harness.lib, {
      request: smallRequest(),
      model: DEV_MODEL_ID,
      idempotencyKey: 'k-1',
    });
    expect(again).toMatchObject({ ok: true, replayed: true, job: { id: submitted(first).id } });
    const other = await harness.engine.submit(harness.lib, {
      request: smallRequest({ prompt: { positive: 'something else' } }),
      model: DEV_MODEL_ID,
      idempotencyKey: 'k-1',
    });
    expect(other).toMatchObject({ ok: false, kind: 'conflict' });
    await harness.engine.settled();
  });

  it('refuses an unknown model and a request no route takes', async () => {
    const harness = await start();
    expect(
      await harness.engine.submit(harness.lib, { request: smallRequest(), model: 'nope' }),
    ).toEqual({
      ok: false,
      kind: 'unknown_model',
    });
    const outcome = await harness.engine.submit(harness.lib, {
      request: smallRequest({ geometry: { width: 63, height: 64 } }),
      model: DEV_MODEL_ID,
    });
    expect(outcome).toMatchObject({ ok: false, kind: 'resolve' });
  });

  it('copies an input held only in another library, recording where it came from (A22)', async () => {
    const harness = await start();
    const other = await harness.libraries.create('Elsewhere');
    const { asset } = await harness.libraries
      .library(other.id)!
      .ingestUpload(makePng(64, 64, { seed: 3 }));
    const record = await submit(harness, {
      mode: 'img2img',
      inputs: [{ role: 'init', asset_id: asset.id }],
    });
    expect(harness.libraries.library(harness.lib)!.getAsset(asset.id)?.origin).toBe('imported');
    await harness.engine.settled();
    const library = harness.libraries.library(harness.lib)!;
    const output = library.jobOutputs(record.id)[0]!;
    expect(library.provenance(output.id)?.job?.inputs).toEqual([
      expect.objectContaining({ assetId: asset.id, role: 'init', sourceLibrary: other.id }),
    ]);
  });

  it('refuses an input in no library', async () => {
    const harness = await start();
    const outcome = await harness.engine.submit(harness.lib, {
      request: smallRequest({
        mode: 'img2img',
        inputs: [{ role: 'init', asset_id: 'a'.repeat(64) }],
      }),
      model: DEV_MODEL_ID,
    });
    expect(outcome).toEqual({
      ok: false,
      kind: 'inputs',
      issues: [
        {
          path: '/request/inputs/0/asset_id',
          message: 'is not an asset with bytes in any library',
        },
      ],
    });
  });

  it('cuts an emulated crop into a derived asset that the effective request names (A7)', async () => {
    const harness = await start();
    const library = harness.libraries.library(harness.lib)!;
    const { asset } = await library.ingestUpload(makePng(64, 64, { seed: 4 }));
    const crop = { x: 0, y: 0, width: 0.5, height: 0.5 };
    const record = await submit(harness, {
      mode: 'img2img',
      inputs: [{ role: 'init', asset_id: asset.id, crop }],
    });
    await harness.engine.settled();
    const effective = harness.libraries.jobs(harness.lib)!.payloads(record.id)!.effective!;
    const used = effective.inputs![0]!;
    expect(used.crop).toBeUndefined();
    expect(used.asset_id).not.toBe(asset.id);
    expect(library.getAsset(used.asset_id)).toMatchObject({
      origin: 'derived',
      width: 32,
      derivedFrom: { assetId: asset.id },
    });
    const output = library.jobOutputs(record.id)[0]!;
    expect(library.lineage(output.id)?.nodes.map((node) => node.id)).toEqual([
      output.id,
      used.asset_id,
      asset.id,
    ]);
  });

  it('blocks a job whose route no backend serves (route_missing)', async () => {
    const harness = await start({ blockedRetryMs: 60_000 });
    const engine = new JobEngine({
      libraries: harness.libraries,
      models: harness.catalog,
      resolver: (harness.engine as unknown as { resolver: never }).resolver,
      bindings: { binding: () => undefined, concurrency: () => 1, all: () => [] },
      events: harness.events,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      blockedRetryMs: 60_000,
    });
    await harness.engine.stop();
    harness.engine = engine;
    await engine.start();
    const outcome = await engine.submit(harness.lib, {
      request: smallRequest(),
      model: DEV_MODEL_ID,
    });
    await engine.settled();
    expect(job(harness, submitted(outcome).id)).toMatchObject({
      state: 'queued',
      blockedReason: { code: 'route_missing' },
    });
    expect(engine.queue()).toEqual([expect.objectContaining({ blocked: true, mode: 'txt2img' })]);
    expect(newId('job')).toMatch(/^job_/);
  });
});
