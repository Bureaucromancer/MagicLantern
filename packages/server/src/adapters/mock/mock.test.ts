// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import type { GenerationRequest } from '@bureaucromancer/lantern-schema';
import { describe, expect, it } from 'vitest';

import { CancelRefused, RejectedBeforeStart, type JobHandle } from '../shared/types.js';
import { fillPlaceholders, placeholderIds } from '../shared/wire.js';
import { MOCK_ROUTE_ID } from './descriptor.js';
import { drawMockImage, MockAdapter, type MockWire } from './mock.js';
import type { MockSettings } from './profiles.js';

const REQUEST: GenerationRequest = {
  schema_version: 1,
  mode: 'txt2img',
  prompt: { positive: 'a fox' },
  geometry: { width: 64, height: 64 },
  sampling: { seed: 7, steps: 10 },
  count: 2,
};

async function mock(settings: MockSettings = {}) {
  let now = 1_000_000;
  const adapter = new MockAdapter({ now: () => now });
  await adapter.init({
    backendId: 'be',
    baseUrl: 'mock://t',
    settings: { stepMs: 10, ...settings },
  });
  const signal = new AbortController().signal;
  const submit = async (request: GenerationRequest = REQUEST): Promise<JobHandle> =>
    await adapter.submit(MOCK_ROUTE_ID, await adapter.prepare(MOCK_ROUTE_ID, request), signal);
  return {
    adapter,
    submit,
    advance: (ms: number): void => {
      now += ms;
    },
  };
}

describe('the mock adapter', () => {
  it('prepares a pure wire request with asset placeholders', async () => {
    const { adapter } = await mock();
    const request: GenerationRequest = {
      ...REQUEST,
      mode: 'img2img',
      inputs: [{ role: 'init', asset_id: 'a'.repeat(64) }],
    };
    const wire = await adapter.prepare(MOCK_ROUTE_ID, request);
    expect(await adapter.prepare(MOCK_ROUTE_ID, request)).toEqual(wire);
    expect(wire).toMatchObject({
      seed: 7,
      width: 64,
      batch_count: 2,
      init_image: { $asset: 'a'.repeat(64) },
    });
    expect(placeholderIds(wire)).toEqual(['a'.repeat(64)]);
    expect(fillPlaceholders(wire, () => new Uint8Array([1, 2]))).toMatchObject({
      init_image: 'AQI=',
    });
  });

  it('refuses a random seed: the engine always sends a concrete one', async () => {
    const { adapter } = await mock();
    await expect(
      adapter.prepare(MOCK_ROUTE_ID, { ...REQUEST, sampling: { seed: 'random' } }),
    ).rejects.toThrow(/concrete/);
  });

  it('queues, runs and finishes on its clock, with seed + k per output', async () => {
    const { adapter, submit, advance } = await mock();
    const handle = await submit();
    expect(handle.resumable).toBe(true);
    expect((await adapter.status(handle)).state).toBe('running');
    advance(100);
    expect((await adapter.status(handle)).progress?.fraction).toBeCloseTo(0.5);
    advance(150);
    expect((await adapter.status(handle)).state).toBe('done');
    const result = await adapter.fetchResult(handle);
    expect(result.outputs.map((output) => output.seed)).toEqual([7, 8]);
  });

  it('draws the same pixels for the same seed and prompt, others for another', () => {
    const wire = { prompt: 'a fox', width: 16, height: 16 } as MockWire;
    expect(drawMockImage(wire, 1)).toEqual(drawMockImage(wire, 1));
    expect(drawMockImage(wire, 1)).not.toEqual(drawMockImage(wire, 2));
    expect(drawMockImage(wire, 1)).not.toEqual(drawMockImage({ ...wire, prompt: 'a cat' }, 1));
  });

  it('as sd-server: cannot cancel a running job, returns results with the status, then purges them', async () => {
    const { adapter, submit, advance } = await mock({ profile: 'sdserver', retentionMs: 1000 });
    const handle = await submit();
    await expect(adapter.cancel(handle)).rejects.toThrow(CancelRefused);
    advance(10);
    expect((await adapter.status(handle)).progress).toMatchObject({ step: 1, total_steps: 10 });
    advance(300);
    expect((await adapter.status(handle)).result?.outputs).toHaveLength(2);
    advance(2000);
    expect((await adapter.status(handle)).state).toBe('lost');
  });

  it('as a manager: turns the first submit away, then reports memory and load waits', async () => {
    const { adapter, submit, advance } = await mock({
      profile: 'orchd',
      rejectSubmits: 1,
      memoryWaitMs: 50,
      loadMs: 100,
    });
    expect((await adapter.health()).routes?.[MOCK_ROUTE_ID]?.load_state).toBe('cold');
    await expect(submit()).rejects.toThrow(RejectedBeforeStart);
    const handle = await submit();
    expect((await adapter.status(handle)).waiting?.reason).toBe('memory');
    advance(60);
    expect((await adapter.status(handle)).waiting?.reason).toBe('loading');
    advance(100);
    expect((await adapter.status(handle)).state).toBe('running');
    expect((await adapter.health()).routes?.[MOCK_ROUTE_ID]?.load_state).toBe('loaded');
  });

  it('with port reuse: another model answers after the first submit', async () => {
    const { adapter, submit } = await mock({ profile: 'port_reuse', swapAfter: 1 });
    const before = await adapter.identify(MOCK_ROUTE_ID);
    const handle = await submit();
    expect(handle.instance.model).toEqual(before);
    expect(await adapter.identify(MOCK_ROUTE_ID)).not.toEqual(before);
  });

  it('cancels a queued job, which then reads as cancelled', async () => {
    const { adapter, submit } = await mock();
    await submit();
    const second = await submit();
    await adapter.cancel(second);
    expect((await adapter.status(second)).state).toBe('cancelled');
  });

  it('refuses an unknown profile', async () => {
    const adapter = new MockAdapter();
    await expect(
      adapter.init({ backendId: 'be', baseUrl: 'mock://t', settings: { profile: 'comfy' } }),
    ).rejects.toThrow(/Unknown mock profile/);
  });
});
