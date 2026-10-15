// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * POST /api/v1/libraries/{lib}/resolve on the real app: the dry run end to
 * end over the in-memory catalog, its refusals in the shared envelope, and
 * the auth gate and security hooks in front of it.
 */

import {
  fillPath,
  type GenerationRequest,
  ResolveResponse,
  ResolveRoute,
} from '@bureaucromancer/lantern-schema';
import { Value } from '@sinclair/typebox/value';
import { afterEach, describe, expect, it } from 'vitest';

import { type CatalogModel, DEV_MODEL, DEV_MODEL_ID } from '../engine/catalog/index.js';
import {
  fakeLibraries,
  libraryRecord,
  makeTestApp,
  TEST_ORIGIN,
  type TestApp,
  type TestAppOptions,
} from '../test-app.js';

const LIB = 'lib_01JA0000000000000000000000';
const URL = fillPath(ResolveRoute.path, { lib: LIB });
const PASSWORD = 'correct horse battery staple';

/** A second model: a cold priority route that ignores comfy extensions, and the dev route. */
const TWO_ROUTES: CatalogModel = {
  id: 'mdl_two',
  family: 'sdxl',
  routes: [
    { ...DEV_MODEL.routes[0]!, id: 'rt_second', priority: 0 },
    {
      ...DEV_MODEL.routes[0]!,
      id: 'rt_first',
      priority: 5,
      health: { status: 'ok', load_state: 'cold' },
    },
  ],
};
const NO_ROUTES: CatalogModel = { id: 'mdl_empty', family: 'sdxl', routes: [] };

const REQUEST: GenerationRequest = {
  schema_version: 1,
  mode: 'txt2img',
  prompt: { positive: 'a lighthouse at dusk', negative: 'blurry' },
  sampling: { seed: 'random', cfg: 1, clip_skip: 2 },
  extensions: {
    mock: { delay_ms: 5 },
    comfy: { nested: { list: [1, null, 'x'], deep: { on: true } } },
  },
};

let servers: TestApp[] = [];

afterEach(async () => {
  for (const server of servers) await server.close();
  servers = [];
});

async function start(options: TestAppOptions = {}): Promise<TestApp> {
  const server = await makeTestApp({
    libraries: fakeLibraries([libraryRecord(LIB, 'Library')]),
    models: [DEV_MODEL, TWO_ROUTES, NO_ROUTES],
    drawSeed: () => 1234,
    ...options,
  });
  servers.push(server);
  return server;
}

function post(server: TestApp, payload: object, url = URL) {
  return server.request({ method: 'POST', url, headers: { origin: TEST_ORIGIN }, payload });
}

describe('POST /api/v1/libraries/{lib}/resolve', () => {
  it('answers the resolution, in the response schema', async () => {
    const server = await start();
    const response = await post(server, { request: REQUEST, model: DEV_MODEL_ID });

    expect(response.statusCode).toBe(200);
    const body = response.json<ResolveResponse>();
    expect(Value.Check(ResolveResponse, body)).toBe(true);
    expect(body).toMatchSnapshot();
  });

  it('keeps opaque extension values whole through serialisation (rule 5)', async () => {
    const server = await start();
    const body = (
      await post(server, { request: REQUEST, model: DEV_MODEL_ID })
    ).json<ResolveResponse>();

    expect(body.effective.extensions).toEqual(REQUEST.extensions);
    expect(body.field_report['/extensions/comfy']).toEqual({
      field: 'extensions.comfy',
      state: 'ignored',
      source: 'request',
      requested: REQUEST.extensions?.['comfy'],
      reason: 'Extensions for another backend kind (`comfy`); this route is `mock`.',
    });
  });

  it('chooses by priority, a cold route included, or takes the route asked for', async () => {
    const server = await start();
    const chosen = await post(server, { request: REQUEST, model: 'mdl_two' });
    const asked = await post(server, { request: REQUEST, model: 'mdl_two', route: 'rt_second' });

    expect(chosen.json()).toMatchObject({
      route: { id: 'rt_first', health: { load_state: 'cold' } },
    });
    expect(asked.json()).toMatchObject({ route: { id: 'rt_second' } });
  });

  it('answers 404 for an unknown library', async () => {
    const server = await start();
    const response = await post(
      server,
      { request: REQUEST, model: DEV_MODEL_ID },
      fillPath(ResolveRoute.path, { lib: 'lib_01JB0000000000000000000000' }),
    );

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not-found', message: 'No such library.' });
  });

  it.each([
    [
      'a malformed library id',
      fillPath(ResolveRoute.path, { lib: 'nope' }),
      { request: REQUEST, model: DEV_MODEL_ID },
    ],
    ['an unknown body field', URL, { request: REQUEST, model: DEV_MODEL_ID, preset: {} }],
    [
      'an unknown request field',
      URL,
      { request: { ...REQUEST, colour: 'teal' }, model: DEV_MODEL_ID },
    ],
    ['a missing model', URL, { request: REQUEST }],
    ['an unknown model', URL, { request: REQUEST, model: 'mdl_nope' }],
    ['an unknown route', URL, { request: REQUEST, model: DEV_MODEL_ID, route: 'rt_nope' }],
    ['a model with no routes', URL, { request: REQUEST, model: 'mdl_empty' }],
    [
      'a value out of range, with a suggestion',
      URL,
      { request: { ...REQUEST, sampling: { seed: 1, steps: 200 } }, model: DEV_MODEL_ID },
    ],
    ['a mode rule', URL, { request: { ...REQUEST, mode: 'img2img' }, model: DEV_MODEL_ID }],
    [
      'a mode the profile does not support',
      URL,
      {
        request: { ...REQUEST, mode: 'edit', inputs: [{ role: 'ref', asset_id: 'a'.repeat(64) }] },
        model: DEV_MODEL_ID,
      },
    ],
  ])('answers 422 for %s, naming the field', async (_label, url, payload) => {
    const server = await start();
    const response = await post(server, payload, url);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchSnapshot();
  });

  it('answers 415 for a body that is not JSON', async () => {
    const server = await start();
    const response = await server.request({
      method: 'POST',
      url: URL,
      headers: { origin: TEST_ORIGIN, 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(response.statusCode).toBe(415);
  });

  it('works on a development daemon’s catalog', async () => {
    const server = await start({ models: [DEV_MODEL] });
    const response = await post(server, {
      request: {
        schema_version: 1,
        mode: 'txt2img',
        prompt: { positive: 'x' },
        sampling: { seed: 3 },
      },
      model: DEV_MODEL_ID,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<ResolveResponse>().effective.sampling.seed).toBe(3);
  });
});

describe('the gate in front of it', () => {
  it('refuses it without a session in password mode, and serves it after sign-in', async () => {
    const server = await start({ password: PASSWORD });
    const before = await post(server, { request: REQUEST, model: DEV_MODEL_ID });
    expect(before.statusCode).toBe(401);
    expect(before.json()).toMatchObject({ error: 'unauthenticated' });

    expect((await server.signIn(PASSWORD)).statusCode).toBe(204);
    expect((await post(server, { request: REQUEST, model: DEV_MODEL_ID })).statusCode).toBe(200);
  });

  it('refuses another origin before anything else, signed in or not', async () => {
    const server = await start({ password: PASSWORD });
    await server.signIn(PASSWORD);
    const response = await server.request({
      method: 'POST',
      url: URL,
      headers: { origin: 'http://evil.example' },
      payload: { request: REQUEST, model: DEV_MODEL_ID },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'forbidden-origin' });
  });

  it('refuses a foreign Host', async () => {
    const server = await start();
    const response = await server.request({
      method: 'POST',
      url: URL,
      headers: { host: 'evil.example', origin: 'http://evil.example' },
      payload: { request: REQUEST, model: DEV_MODEL_ID },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'forbidden-host' });
  });
});
