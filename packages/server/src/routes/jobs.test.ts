// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import {
  JobDetail,
  JobPage,
  QueueResponse,
  SubmitResponse,
  type GenerationRequest,
} from '@bureaucromancer/lantern-schema';
import type { TSchema } from '@sinclair/typebox';
import { afterEach, describe, expect, it } from 'vitest';

import { DEV_MODEL_ID } from '../engine/catalog/index.js';
import { newId } from '../ids.js';
import {
  makeTestApp,
  TEST_HOST,
  TEST_ORIGIN,
  type TestApp,
  type TestAppOptions,
} from '../test-app.js';
import { createValidator } from '../validation/ajv.js';

const apps: TestApp[] = [];
const ajv = createValidator();

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function conforms(schema: TSchema, value: unknown): boolean {
  if (!ajv.validate(schema, value)) throw new Error(ajv.errorsText());
  return true;
}

async function start(options: TestAppOptions = {}): Promise<TestApp & { lib: string }> {
  const app = await makeTestApp({ storage: true, mock: {}, ...options });
  apps.push(app);
  return { ...app, lib: app.libraries.list()[0]!.id };
}

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    schema_version: 1,
    mode: 'txt2img',
    prompt: { positive: 'a red barn' },
    geometry: { width: 64, height: 64 },
    sampling: { seed: 42, steps: 2 },
    ...overrides,
  };
}

const json = { 'content-type': 'application/json', origin: TEST_ORIGIN };

async function submit(
  app: TestApp & { lib: string },
  extra: Record<string, unknown> = {},
  headers = {},
) {
  return await app.request({
    method: 'POST',
    url: `/api/v1/libraries/${app.lib}/jobs`,
    headers: { ...json, ...headers },
    payload: { request: request(), model: DEV_MODEL_ID, ...extra },
  });
}

describe('POST /api/v1/libraries/{lib}/jobs', () => {
  it('queues a job (202) that runs to its outputs', async () => {
    const app = await start();
    const response = await submit(app, { collection: 'session-1', priority: 2 });
    expect(response.statusCode).toBe(202);
    const body = response.json<SubmitResponse>();
    expect(conforms(SubmitResponse, body)).toBe(true);
    expect(body).toMatchObject({
      replayed: false,
      job: { library: app.lib, state: 'queued', collection: 'session-1', priority: 2 },
    });
    expect(body.field_report['/sampling/steps']).toMatchObject({ used: 2 });

    await app.services.engine.settled();
    const detail = (
      await app.request({ method: 'GET', url: `/api/v1/libraries/${app.lib}/jobs/${body.job.id}` })
    ).json<JobDetail>();
    expect(conforms(JobDetail, detail)).toBe(true);
    expect(detail).toMatchObject({ state: 'finished', outcome: 'done' });
    expect(detail.outputs).toHaveLength(1);
    expect(detail.effective).toMatchObject({ sampling: { seed: 42, steps: 2 } });
  });

  it('answers the first job again for the same Idempotency-Key (200), and 409 for another body', async () => {
    const app = await start();
    const first = await submit(app, {}, { 'idempotency-key': 'abc-1' });
    const again = await submit(app, {}, { 'idempotency-key': 'abc-1' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true, job: { id: first.json().job.id } });
    const other = await submit(
      app,
      { request: request({ prompt: { positive: 'else' } }) },
      { 'idempotency-key': 'abc-1' },
    );
    expect(other.statusCode).toBe(409);
    expect((await submit(app, {}, { 'idempotency-key': 'has space' })).statusCode).toBe(422);
    await app.services.engine.settled();
  });

  it('refuses an unknown model and a request the route cannot take (422)', async () => {
    const app = await start();
    const unknown = await submit(app, { model: 'nope' });
    expect(unknown.json().issues).toEqual([{ path: '/model', message: 'is not a known model' }]);
    const bad = await submit(app, { request: request({ sampling: { seed: 1, steps: 500 } }) });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().issues[0].path).toBe('/request/sampling/steps');
  });

  it('answers 404 for an unknown library', async () => {
    const app = await start();
    const response = await app.request({
      method: 'POST',
      url: `/api/v1/libraries/${newId('lib')}/jobs`,
      headers: json,
      payload: { request: request(), model: DEV_MODEL_ID },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('history, cancel and reruns', () => {
  it('pages history newest first', async () => {
    const app = await start();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) ids.push((await submit(app)).json().job.id);
    await app.services.engine.settled();
    const base = `/api/v1/libraries/${app.lib}/jobs`;
    const first = (await app.request({ method: 'GET', url: `${base}?limit=2` })).json<JobPage>();
    expect(conforms(JobPage, first)).toBe(true);
    expect(first.jobs.map((job) => job.id)).toEqual([ids[2], ids[1]]);
    const second = (
      await app.request({
        method: 'GET',
        url: `${base}?limit=2&cursor=${String(first.next_cursor)}`,
      })
    ).json<JobPage>();
    expect(second.jobs.map((job) => job.id)).toEqual([ids[0]]);
    expect((await app.request({ method: 'GET', url: `${base}?state=live` })).json().jobs).toEqual(
      [],
    );
    expect((await app.request({ method: 'GET', url: `${base}?cursor=zz` })).statusCode).toBe(422);
  });

  it('cancels a queued job (202) and changes nothing for a finished one', async () => {
    const app = await start({ mock: { stepMs: 30 } });
    const running = (
      await submit(app, { request: request({ sampling: { seed: 1, steps: 10 } }) })
    ).json().job.id;
    const queued = (await submit(app)).json().job.id;
    const cancel = (id: string) =>
      app.request({
        method: 'POST',
        url: `/api/v1/libraries/${app.lib}/jobs/${id}/cancel`,
        headers: { origin: TEST_ORIGIN },
      });
    const response = await cancel(queued);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ state: 'finished', outcome: 'cancelled' });
    expect((await cancel(queued)).json()).toMatchObject({ outcome: 'cancelled' });
    await cancel(running);
    await app.services.engine.settled();
    expect((await cancel(newId('job'))).statusCode).toBe(404);
  });

  it('reproduces and re-rolls (202), with the job as parent', async () => {
    const app = await start();
    const original = (await submit(app)).json<SubmitResponse>().job.id;
    await app.services.engine.settled();
    const rerun = async (kind: string) =>
      await app.request({
        method: 'POST',
        url: `/api/v1/libraries/${app.lib}/jobs/${original}/${kind}`,
        headers: { origin: TEST_ORIGIN },
      });
    const reproduced = await rerun('reproduce');
    expect(reproduced.statusCode).toBe(202);
    expect(reproduced.json().job.parent_id).toBe(original);
    const rerolled = await rerun('reroll');
    expect(rerolled.statusCode).toBe(202);
    await app.services.engine.settled();
    const outputs = (id: string) =>
      app.request({ method: 'GET', url: `/api/v1/libraries/${app.lib}/jobs/${id}` });
    const pixel = async (id: string) =>
      (await outputs(id)).json<JobDetail>().outputs[0]?.pixel_hash;
    expect(await pixel(reproduced.json().job.id)).toBe(await pixel(original));
    expect(await pixel(rerolled.json().job.id)).not.toBe(await pixel(original));
  });
});

describe('GET /api/v1/queue', () => {
  it("lists live jobs in dispatch order, collapsing other libraries' (A19)", async () => {
    const app = await start({ mock: { stepMs: 20 } });
    const other = await app.libraries.create('Other');
    await submit(app, { request: request({ sampling: { seed: 1, steps: 10 } }) });
    await app.request({
      method: 'POST',
      url: `/api/v1/libraries/${other.id}/jobs`,
      headers: json,
      payload: { request: request(), model: DEV_MODEL_ID, priority: 3 },
    });
    await submit(app);
    const queue = (
      await app.request({ method: 'GET', url: `/api/v1/queue?library=${app.lib}` })
    ).json<QueueResponse>();
    expect(conforms(QueueResponse, queue)).toBe(true);
    expect(queue.entries.map((entry) => [entry.library === app.lib, entry.job === null])).toEqual([
      [true, false],
      // The other library's job runs next (priority 3) and is collapsed.
      [false, true],
      [true, false],
    ]);
    expect(queue.entries[1]).toMatchObject({ mode: 'txt2img', state: 'queued', position: 1 });
    await app.services.engine.settled();
    expect(
      (await app.request({ method: 'GET', url: '/api/v1/queue' })).json<QueueResponse>().entries,
    ).toEqual([]);
  });
});

describe('GET /api/v1/events', () => {
  async function listen(app: TestApp): Promise<string> {
    await app.app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.app.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('Not listening.');
    return `http://127.0.0.1:${String(address.port)}`;
  }

  /** Reads the stream until `until` holds for what has arrived, then aborts it. */
  async function read(
    url: string,
    headers: Record<string, string>,
    until: (text: string) => boolean,
    started?: () => Promise<void>,
  ): Promise<{ text: string; response: Response }> {
    const controller = new AbortController();
    const response = await fetch(url, {
      headers: { host: TEST_HOST, ...headers },
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let kicked = false;
    const deadline = Date.now() + 5000;
    while (!until(text)) {
      if (Date.now() > deadline) throw new Error(`Timed out; got:\n${text}`);
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
      if (!kicked && started !== undefined) {
        kicked = true;
        await started();
      }
    }
    controller.abort();
    return { text, response };
  }

  it('streams job events as SSE, with ids that resume', async () => {
    const app = await start();
    const base = await listen(app);
    const { text, response } = await read(
      `${base}/api/v1/events`,
      {},
      (seen) => seen.includes('event: asset.created'),
      async () => {
        // Through the engine: once listening, the Origin the test client sends names another port.
        await app.services.engine.submit(app.lib, { request: request(), model: DEV_MODEL_ID });
      },
    );
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(text).toContain('event: job.updated');
    expect(text).toMatch(/id: boot_test:\d+/);
    const firstId = /id: (boot_test:\d+)/.exec(text)![1]!;

    // A reconnect replays what came after the id it gives.
    const replay = await read(`${base}/api/v1/events`, { 'last-event-id': firstId }, (seen) =>
      seen.includes('event: asset.created'),
    );
    expect(replay.text).not.toContain(`id: ${firstId}\n`);
    expect(replay.text).toContain('event: job.updated');
  });

  it('sends reset for an id from another boot', async () => {
    const app = await start();
    const base = await listen(app);
    const { text } = await read(`${base}/api/v1/events`, { 'last-event-id': 'other:3' }, (seen) =>
      seen.includes('event: reset'),
    );
    expect(text).toContain('event: reset\ndata: {}');
  });

  it('ends open streams when the daemon closes, so shutdown does not wait on them', async () => {
    const app = await start();
    const base = await listen(app);
    const response = await fetch(`${base}/api/v1/events`, { headers: { host: TEST_HOST } });
    const reader = response.body!.getReader();
    await reader.read();
    const started = Date.now();
    await app.app.close();
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await reader.read()).done).toBe(true);
  });
});
