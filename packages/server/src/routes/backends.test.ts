// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The backends, models and profiles routes, and Phase 5's exit run end to
 * end on fakes: txt2img, img2img, inpaint (an uploaded mask) and LoRA jobs on
 * an sd-server, standalone and under Lemonade, through the API and the
 * engine, with what sd-server does to jobs (a full queue, a purged result,
 * a running job that will not cancel, another model on the port).
 */

import {
  BackendKindListResponse,
  BackendListResponse,
  BackendSummary,
  DetectResponse,
  JobDetail,
  ModelDetail,
  ModelListResponse,
  ProfileListResponse,
  type FieldReport,
  type GenerationRequest,
} from '@bureaucromancer/lantern-schema';
import type { TSchema } from '@sinclair/typebox';
import { rm } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FakeSdServer,
  PINNED_BUILD,
  pinnedCapabilities,
  withModel,
} from '../adapters/sdcpp/test-sdserver.js';
import type { ConfigBackend } from '../engine/backends/index.js';
import { DEV_MODEL_ID } from '../engine/catalog/index.js';
import { FakeLemonade } from '../managers/lemonade/test-lemonade.js';
import { makePng } from '../store/test-images.js';
import {
  makeTestApp,
  tempRoot,
  TEST_ORIGIN,
  type TestApp,
  type TestAppOptions,
} from '../test-app.js';
import { createValidator } from '../validation/ajv.js';

const ajv = createValidator();
const apps: TestApp[] = [];
const servers: { close(): Promise<void> }[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function conforms(schema: TSchema, value: unknown): boolean {
  if (!ajv.validate(schema, value)) throw new Error(ajv.errorsText());
  return true;
}

const json = { 'content-type': 'application/json', origin: TEST_ORIGIN };

async function sdServer(options: Parameters<typeof FakeSdServer.start>[0] = {}) {
  const server = await FakeSdServer.start(options);
  servers.push(server);
  return server;
}

type Started = TestApp & { lib: string };

async function start(options: TestAppOptions = {}): Promise<Started> {
  const app = await makeTestApp({ storage: true, ...options });
  apps.push(app);
  return { ...app, lib: app.libraries.list()[0]!.id };
}

async function withSdServer(
  config: Partial<ConfigBackend> = {},
  server?: FakeSdServer,
): Promise<Started & { server: FakeSdServer; model: string }> {
  const fake = server ?? (await sdServer());
  const app = await start({
    backends: { config: [{ id: 'sdxl', kind: 'sdcpp', baseUrl: fake.url, ...config }] },
  });
  const model = app.services.backends.modelViews()[0]!.id;
  return { ...app, server: fake, model };
}

function txt2img(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    schema_version: 1,
    mode: 'txt2img',
    prompt: { positive: 'a lighthouse at dusk' },
    geometry: { width: 512, height: 512 },
    sampling: { seed: 42, steps: 4 },
    ...overrides,
  };
}

async function submit(app: Started, model: string, request: GenerationRequest) {
  const response = await app.request({
    method: 'POST',
    url: `/api/v1/libraries/${app.lib}/jobs`,
    headers: json,
    payload: { request, model },
  });
  if (response.statusCode !== 202) throw new Error(response.body);
  return response.json<{ job: { id: string } }>().job.id;
}

async function job(app: Started, id: string): Promise<JobDetail> {
  return (
    await app.request({ method: 'GET', url: `/api/v1/libraries/${app.lib}/jobs/${id}` })
  ).json<JobDetail>();
}

/** A job's stored effective request, which the wire schema leaves opaque. */
function effectiveOf(detail: JobDetail): GenerationRequest {
  return detail.effective as GenerationRequest;
}

/** A job's stored field report. */
function reportOf(detail: JobDetail): FieldReport {
  return detail.field_report as FieldReport;
}

/** Polls until the job's state passes `until`, or the deadline. */
async function waitFor(
  app: Started,
  id: string,
  until: (detail: JobDetail) => boolean,
): Promise<JobDetail> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const detail = await job(app, id);
    if (until(detail)) return detail;
    if (Date.now() > deadline) throw new Error(`job ${id} stayed ${detail.state}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('GET /api/v1/backend-kinds', () => {
  it('lists the kinds with their settings schemas, and never the mock', async () => {
    const app = await start();
    const body = (
      await app.request({ method: 'GET', url: '/api/v1/backend-kinds' })
    ).json<BackendKindListResponse>();
    expect(conforms(BackendKindListResponse, body)).toBe(true);
    expect(body.kinds.map((kind) => [kind.kind, kind.role])).toEqual([
      ['sdcpp', 'adapter'],
      ['lemonade', 'manager'],
    ]);
    expect(body.kinds[1]).toMatchObject({
      adapter_kind: 'sdcpp',
      default_urls: ['http://127.0.0.1:13305', 'http://127.0.0.1:8000'],
      secrets_schema: { properties: { apiKey: { type: 'string' } } },
    });
  });
});

describe('POST /api/v1/backends/detect (A32, L9)', () => {
  it('tests a URL as every kind, and proposes what it finds (A26)', async () => {
    const server = await sdServer();
    const app = await start();
    const response = await app.request({
      method: 'POST',
      url: '/api/v1/backends/detect',
      headers: json,
      payload: { url: server.url },
    });
    const body = response.json<DetectResponse>();
    expect(conforms(DetectResponse, body)).toBe(true);
    expect(body.candidates).toEqual([
      {
        kind: 'sdcpp',
        base_url: server.url,
        name: `sd-server (stable-diffusion.cpp) at ${server.url}`,
        registered: null,
        detail: 'sd-server with sd_xl_base_1.0.safetensors',
        models: [
          {
            name: 'sd_xl_base_1.0',
            fingerprint: expect.objectContaining({ kind: 'file', stem: 'sd_xl_base_1.0' }),
            existing: null,
            guess: expect.objectContaining({ family: 'sdxl', confidence: 'high' }),
          },
        ],
      },
    ]);
    expect(body.probes).toEqual([
      { kind: 'sdcpp', url: `${server.url}/sdcpp/v1/capabilities`, found: true },
      expect.objectContaining({ kind: 'lemonade', found: false }),
    ]);
  });

  it('finds Lemonade and the models it has loaded', async () => {
    const child = await sdServer();
    const lemonade = await FakeLemonade.start();
    servers.push(lemonade);
    lemonade.children = [{ name: 'SDXL-Base-1.0', origin: child.origin }];
    const app = await start();
    const body = (
      await app.request({
        method: 'POST',
        url: '/api/v1/backends/detect',
        headers: json,
        payload: { url: lemonade.url },
      })
    ).json<DetectResponse>();
    expect(body.candidates).toEqual([
      expect.objectContaining({
        kind: 'lemonade',
        detail: 'Lemonade 9.3.3, 1 image model loaded',
        models: [
          expect.objectContaining({
            name: 'SDXL-Base-1.0',
            manager_ref: 'SDXL-Base-1.0',
            guess: expect.objectContaining({ family: 'sdxl' }),
          }),
        ],
      }),
    ]);
  });

  it('probes every kind’s default addresses when no URL is given', async () => {
    const app = await start();
    const body = (
      await app.request({
        method: 'POST',
        url: '/api/v1/backends/detect',
        headers: json,
        payload: {},
      })
    ).json<DetectResponse>();
    expect(body.probes.map((probe) => probe.url)).toEqual([
      'http://127.0.0.1:1234/sdcpp/v1/capabilities',
      'http://127.0.0.1:13305/api/v1/health',
      'http://127.0.0.1:8000/api/v1/health',
    ]);
  });
});

describe('/api/v1/backends', () => {
  it('adds a backend (201), lists it, refuses it twice (409), and refreshes it', async () => {
    const server = await sdServer();
    const app = await start({ backends: {} });
    const created = await app.request({
      method: 'POST',
      url: '/api/v1/backends',
      headers: json,
      payload: { kind: 'sdcpp', base_url: server.url, name: 'Desk' },
    });
    expect(created.statusCode).toBe(201);
    const summary = created.json<BackendSummary>();
    expect(conforms(BackendSummary, summary)).toBe(true);
    expect(summary).toMatchObject({
      name: 'Desk',
      source: 'ui',
      role: 'adapter',
      health: { status: 'ok' },
      routes: [{ adapter_kind: 'sdcpp', status: 'active', model_name: 'sd_xl_base_1.0' }],
    });

    const list = (
      await app.request({ method: 'GET', url: '/api/v1/backends' })
    ).json<BackendListResponse>();
    expect(conforms(BackendListResponse, list)).toBe(true);
    expect(list.backends.map((backend) => backend.id)).toEqual([summary.id]);

    const again = await app.request({
      method: 'POST',
      url: '/api/v1/backends',
      headers: json,
      payload: { kind: 'sdcpp', base_url: `${server.url}/` },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'conflict' });

    const refreshed = await app.request({
      method: 'POST',
      url: `/api/v1/backends/${summary.id}/refresh`,
      headers: { origin: TEST_ORIGIN },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json<BackendSummary>().routes[0]?.descriptor_fetched_at).toEqual(
      expect.any(String),
    );
    const missing = await app.request({
      method: 'POST',
      url: '/api/v1/backends/be_nope/refresh',
      headers: { origin: TEST_ORIGIN },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('refuses bad settings and an unknown profile (422), naming the field', async () => {
    const app = await start({ backends: {} });
    const bad = await app.request({
      method: 'POST',
      url: '/api/v1/backends',
      headers: json,
      payload: { kind: 'sdcpp', base_url: 'http://127.0.0.1:1', settings: { preview: 'often' } },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().issues).toEqual([
      { path: '/settings', message: 'preview must be one of auto, none, proj, tae, vae.' },
    ]);
    const unknownKey = await app.request({
      method: 'POST',
      url: '/api/v1/backends',
      headers: json,
      payload: { kind: 'sdcpp', base_url: 'http://127.0.0.1:1', colour: 'red' },
    });
    expect(unknownKey.statusCode).toBe(422);
  });

  it('keeps secrets, and never answers them', async () => {
    const lemonade = await FakeLemonade.start();
    servers.push(lemonade);
    lemonade.apiKey = 'open-sesame-12345';
    const app = await start({ backends: {} });
    const created = await app.request({
      method: 'POST',
      url: '/api/v1/backends',
      headers: json,
      payload: {
        kind: 'lemonade',
        base_url: lemonade.url,
        secrets: { apiKey: 'open-sesame-12345' },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ secrets: ['apiKey'], health: { status: 'ok' } });
    expect(created.body).not.toContain('open-sesame');
    const list = await app.request({ method: 'GET', url: '/api/v1/backends' });
    expect(list.body).not.toContain('open-sesame');
  });
});

describe('/api/v1/models and /api/v1/profiles', () => {
  it('lists models with their routes, and one with its effective descriptors', async () => {
    const app = await withSdServer();
    const list = (
      await app.request({ method: 'GET', url: '/api/v1/models' })
    ).json<ModelListResponse>();
    expect(conforms(ModelListResponse, list)).toBe(true);
    expect(list.models).toEqual([
      expect.objectContaining({
        id: app.model,
        display_name: 'sd_xl_base_1.0',
        family: 'sdxl',
        profile: { family: 'sdxl', name: 'Stable Diffusion XL 1.0' },
        modes: ['txt2img', 'img2img'],
        routes: [expect.objectContaining({ backend_id: 'sdxl', status: 'active' })],
      }),
    ]);

    const detail = (
      await app.request({ method: 'GET', url: `/api/v1/models/${app.model}` })
    ).json<ModelDetail>();
    expect(conforms(ModelDetail, detail)).toBe(true);
    // Effective: the profile's multiple of 8 is merged in (A6).
    expect(detail.routes[0]?.descriptor.modes.txt2img?.fields['geometry.width']).toMatchObject({
      multipleOf: 8,
    });
    expect((await app.request({ method: 'GET', url: '/api/v1/models/mdl_nope' })).statusCode).toBe(
      404,
    );
  });

  it('changes a model’s profile, refusing an unknown one (422) and the development model (409)', async () => {
    const app = await withSdServer();
    const patched = await app.request({
      method: 'PATCH',
      url: `/api/v1/models/${app.model}`,
      headers: json,
      payload: { family: 'generic', display_name: 'Base' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<ModelDetail>()).toMatchObject({
      display_name: 'Base',
      family: 'generic',
      modes: ['txt2img', 'img2img', 'inpaint'],
    });
    const unknown = await app.request({
      method: 'PATCH',
      url: `/api/v1/models/${app.model}`,
      headers: json,
      payload: { family: 'sd3' },
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().issues).toEqual([
      { path: '/family', message: 'is not a loaded profile (`sd3`)' },
    ]);

    const dev = await start({ mock: {} });
    const fixed = await dev.request({
      method: 'PATCH',
      url: `/api/v1/models/${DEV_MODEL_ID}`,
      headers: json,
      payload: { family: 'generic' },
    });
    expect(fixed.statusCode).toBe(409);
  });

  it('lists the profiles for the picker, generic first', async () => {
    const app = await start();
    const body = (
      await app.request({ method: 'GET', url: '/api/v1/profiles' })
    ).json<ProfileListResponse>();
    expect(conforms(ProfileListResponse, body)).toBe(true);
    expect(body.profiles[0]).toEqual({
      family: 'generic',
      name: 'Generic (backend defaults)',
      modes: ['txt2img', 'img2img', 'inpaint'],
      default_variant: null,
      variants: [],
    });
    expect(
      body.profiles.find((profile) => profile.family === 'flux2-klein')?.variants,
    ).toHaveLength(4);
  });
});

describe('jobs on sd-server (the Phase 5 exit, on fakes)', () => {
  it('runs txt2img with a LoRA to its outputs, every default written out (L7)', async () => {
    const app = await withSdServer();
    const id = await submit(
      app,
      app.model,
      txt2img({
        count: 2,
        adapters: [{ kind: 'lora', id: 'style/film-grain.safetensors', weight: 0.6 }],
      }),
    );
    const detail = await waitFor(app, id, (d) => d.state === 'finished');
    expect(detail).toMatchObject({ outcome: 'done' });
    expect(detail.outputs.map((output) => output.output_of?.seed)).toEqual([42, 43]);
    expect(effectiveOf(detail).extensions?.['sdcpp']).toMatchObject({
      vae_tiling_params: { enabled: true },
      cache_mode: '',
    });
    expect(reportOf(detail)['/extensions/sdcpp']).toMatchObject({ source: 'descriptor' });
    const wire = app.server.submitted[0]!;
    expect(wire).toMatchObject({
      seed: 42,
      batch_count: 2,
      width: 512,
      height: 512,
      negative_prompt: '',
      lora: [{ path: 'style/film-grain.safetensors', multiplier: 0.6, is_high_noise: false }],
      vae_tiling_params: { enabled: true },
      sample_params: { sample_steps: 4, guidance: { txt_cfg: 7 } },
    });
    expect(detail.wire).toMatchObject({ seed: 42 });
    expect(detail.route_snapshot).toMatchObject({
      backend: { id: 'sdxl', kind: 'sdcpp', base_url: app.server.url },
      fingerprint: { kind: 'file', stem: 'sd_xl_base_1.0' },
      generator: `stable-diffusion.cpp ${PINNED_BUILD}`,
    });
    expect(detail.backend_response).toMatchObject({
      job: { status: 'completed' },
      images: [
        { index: 0, seed: 42 },
        { index: 1, seed: 43 },
      ],
    });
  });

  it('runs img2img on an uploaded image, at its size, sent as base64', async () => {
    const app = await withSdServer();
    const library = app.libraries.library(app.lib)!;
    const { asset } = await library.ingestUpload(makePng(96, 64));
    const id = await submit(app, app.model, {
      schema_version: 1,
      mode: 'img2img',
      prompt: { positive: 'the same lighthouse at night' },
      inputs: [{ role: 'init', asset_id: asset.id }],
      sampling: { seed: 7, steps: 4 },
    });
    const detail = await waitFor(app, id, (d) => d.state === 'finished');
    expect(detail.outcome).toBe('done');
    expect(effectiveOf(detail).geometry).toEqual({ width: 96, height: 64 });
    expect(reportOf(detail)['/geometry/width']).toMatchObject({ source: 'input' });
    expect(detail.wire).toMatchObject({ init_image: { $asset: asset.id }, strength: 0.75 });
    const sent = app.server.submitted[0]!;
    expect(sent['init_image']).toBe(makePng(96, 64).toString('base64'));
    expect(sent).toMatchObject({ width: 96, height: 64 });
  });

  it('runs inpaint with an uploaded mask (A33) on a model with the generic profile', async () => {
    const app = await withSdServer();
    expect(app.services.backends.updateModel(app.model, { family: 'generic' })).toEqual({
      ok: true,
    });
    const library = app.libraries.library(app.lib)!;
    const init = (await library.ingestUpload(makePng(64, 64, { seed: 1 }))).asset;
    const mask = (await library.ingestUpload(makePng(64, 64, { seed: 2 }))).asset;
    const id = await submit(app, app.model, {
      schema_version: 1,
      mode: 'inpaint',
      prompt: { positive: 'a door' },
      inputs: [
        { role: 'init', asset_id: init.id },
        { role: 'mask', asset_id: mask.id },
      ],
      sampling: { seed: 9, steps: 4, denoise: 0.9 },
    });
    const detail = await waitFor(app, id, (d) => d.state === 'finished');
    expect(detail.outcome).toBe('done');
    expect(detail.wire).toMatchObject({
      init_image: { $asset: init.id },
      mask_image: { $asset: mask.id },
      strength: 0.9,
    });
  });

  it('puts a job sd-server turned away (429) back in Lantern’s queue, keeping its seed (L5)', async () => {
    const server = await sdServer();
    server.rejectSubmits = 1;
    const app = await withSdServer({}, server);
    const id = await submit(app, app.model, txt2img({ sampling: { seed: 'random', steps: 4 } }));
    const blocked = await waitFor(app, id, (d) => d.blocked_reason !== null);
    expect(blocked).toMatchObject({
      state: 'queued',
      blocked_reason: {
        code: 'backend_rejected',
        detail: expect.stringMatching(/queue is full \(429\)/),
      },
    });
    expect(typeof effectiveOf(blocked).sampling.seed).toBe('number');
  });

  it('fails a job as backend_lost when sd-server purged its result (410)', async () => {
    const server = await sdServer({ hold: true });
    const app = await withSdServer({}, server);
    const id = await submit(app, app.model, txt2img());
    await waitFor(app, id, (d) => d.state === 'running');
    server.expire(server.jobIds[0]!);
    const detail = await waitFor(app, id, (d) => d.state === 'finished');
    expect(detail).toMatchObject({ outcome: 'failed', outcome_reason: 'backend_lost' });
  });

  it('cannot cancel a running job on the pinned build, so discards its outputs when it ends', async () => {
    const server = await sdServer({ hold: true });
    const app = await withSdServer({}, server);
    const id = await submit(app, app.model, txt2img());
    await waitFor(app, id, (d) => d.state === 'running');
    const cancel = await app.request({
      method: 'POST',
      url: `/api/v1/libraries/${app.lib}/jobs/${id}/cancel`,
      headers: { origin: TEST_ORIGIN },
    });
    expect(cancel.json()).toMatchObject({ state: 'cancel_requested' });
    server.release();
    const detail = await waitFor(app, id, (d) => d.state === 'finished');
    expect(detail).toMatchObject({ outcome: 'cancelled', outcome_reason: 'user', outputs: [] });
  });

  it('blocks a job when another model answers on the port (A26), and never sends it there', async () => {
    const server = await sdServer();
    const app = await withSdServer({}, server);
    server.capabilities = withModel(pinnedCapabilities(), '/models/flux-2-klein-4b.safetensors');
    const id = await submit(app, app.model, txt2img());
    const blocked = await waitFor(app, id, (d) => d.blocked_reason !== null);
    expect(blocked.blocked_reason).toMatchObject({ code: 'identity_changed' });
    expect(server.submitted).toEqual([]);
  });
});

describe('a restart mid-job', () => {
  /** A daemon on a data directory both runs share; a closed one leaves it for the next. */
  async function running(server: FakeSdServer, dataDir: string) {
    const app = await makeTestApp({
      storage: true,
      dataDir,
      backends: { config: [{ id: 'sdxl', kind: 'sdcpp', baseUrl: server.url }] },
    });
    return { ...app, lib: app.libraries.list()[0]!.id };
  }

  async function dataDir(): Promise<string> {
    const dir = await tempRoot();
    dirs.push(dir);
    return dir;
  }

  it('resumes polling on the same instance and model, and finishes the job', async () => {
    const server = await sdServer({ hold: true });
    const dir = await dataDir();
    const first = await running(server, dir);
    const model = first.services.backends.modelViews()[0]!.id;
    const id = await submit(first, model, txt2img());
    await waitFor(first, id, (d) => d.state === 'running');
    // Lantern stops, leaving the job dispatched; sd-server keeps it.
    await first.close();

    const second = await running(server, dir);
    apps.push(second);
    server.release();
    const detail = await waitFor(second, id, (d) => d.state === 'finished');
    expect(detail).toMatchObject({ outcome: 'done' });
    expect(server.submitted).toHaveLength(1);
  });

  it('fails the job as backend_lost when the instance restarted meanwhile', async () => {
    const server = await sdServer({ hold: true });
    const dir = await dataDir();
    const first = await running(server, dir);
    const model = first.services.backends.modelViews()[0]!.id;
    const id = await submit(first, model, txt2img());
    await waitFor(first, id, (d) => d.state === 'running');
    await first.close();
    // sd-server keeps jobs in memory only.
    await server.restart();

    const second = await running(server, dir);
    apps.push(second);
    const detail = await waitFor(second, id, (d) => d.state === 'finished');
    expect(detail).toMatchObject({ outcome: 'failed', outcome_reason: 'backend_lost' });
  });
});

describe('jobs on a Lemonade child', () => {
  it('run on the child the route points at, naming Lemonade in the route snapshot', async () => {
    const child = await sdServer();
    const lemonade = await FakeLemonade.start();
    servers.push(lemonade);
    lemonade.children = [{ name: 'SDXL-Base-1.0', origin: child.origin }];
    const app = await start({
      backends: { config: [{ id: 'homelab', kind: 'lemonade', baseUrl: lemonade.url }] },
    });
    const model = app.services.backends.modelViews()[0]!;
    expect(model).toMatchObject({ displayName: 'SDXL-Base-1.0', family: 'sdxl' });
    const id = await submit({ ...app, lib: app.lib }, model.id, txt2img());
    const detail = await waitFor(app, id, (d) => d.state === 'finished');
    expect(detail.outcome).toBe('done');
    expect(detail.route_snapshot).toMatchObject({
      backend: {
        id: 'homelab',
        kind: 'sdcpp',
        base_url: child.origin,
        manager: { kind: 'lemonade', ref: 'SDXL-Base-1.0' },
      },
    });
    expect(child.submitted).toHaveLength(1);
  });
});
