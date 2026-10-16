// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import {
  ErrorCodes,
  GetHealthRoute,
  GetInfoRoute,
  GetSessionRoute,
  ListLibrariesRoute,
  LoginRoute,
  LogoutRoute,
  type ResolveBody,
} from '@bureaucromancer/lantern-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLanternClient, type LanternClient } from './client.js';
import { errorCode, INVALID_RESPONSE_CODE, LanternApiError, UNKNOWN_ERROR_CODE } from './errors.js';
import { empty, type FakeAnswer, fakeFetch, json, text } from './test-fetch.js';

const BASE = 'http://127.0.0.1:7600';
const LIBRARY = { id: 'lib_01JA2B3C4D5E6F7G8H9JKMNPQR', name: 'Library', status: 'ok' } as const;
const RESOLVE_BODY: ResolveBody = {
  request: {
    schema_version: 1,
    mode: 'txt2img',
    prompt: { positive: 'a lighthouse' },
    sampling: { seed: 'random' },
  },
  model: 'mdl_a',
};
const RESOLUTION = {
  effective: { ...RESOLVE_BODY.request, sampling: { seed: 7 } },
  field_report: {},
  route: {
    id: 'rt_a',
    backend_kind: 'sdcpp',
    priority: 0,
    health: { status: 'ok', load_state: 'cold' },
  },
  warnings: [],
  skipped_routes: [],
  descriptor_digest: 'd'.repeat(64),
  provisional: true,
};

/** A client over a fake fetch that gives `answers` in turn. */
function clientAnswering(...answers: FakeAnswer[]) {
  const fake = fakeFetch(...answers);
  return { client: createLanternClient({ baseUrl: BASE, fetch: fake.fetch }), fake };
}

/** The rejection of `promise`, failing the test if it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to reject, and it resolved.');
}

async function apiErrorOf(promise: Promise<unknown>): Promise<LanternApiError> {
  const error = await rejectionOf(promise);
  expect(error).toBeInstanceOf(LanternApiError);
  return error as LanternApiError;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('where requests go', () => {
  /** Every client method, the route it calls, and an answer that satisfies it. */
  const calls: [string, (client: LanternClient) => Promise<unknown>, string, string, Response][] = [
    ['health', (c) => c.health(), 'GET', GetHealthRoute.path, json(200, { status: 'ok' })],
    [
      'session',
      (c) => c.session(),
      'GET',
      GetSessionRoute.path,
      json(200, { mode: 'none', authenticated: true }),
    ],
    ['login', (c) => c.login('pw'), 'POST', LoginRoute.path, empty(204)],
    ['logout', (c) => c.logout(), 'DELETE', LogoutRoute.path, empty(204)],
    [
      'info',
      (c) => c.info(),
      'GET',
      GetInfoRoute.path,
      json(200, { name: 'lantern', version: '0.1.0', apiVersion: 'v1' }),
    ],
    [
      'listLibraries',
      (c) => c.listLibraries(),
      'GET',
      ListLibrariesRoute.path,
      json(200, { libraries: [] }),
    ],
    [
      'resolve',
      (c) => c.resolve(LIBRARY.id, RESOLVE_BODY),
      'POST',
      `/api/v1/libraries/${LIBRARY.id}/resolve`,
      json(200, RESOLUTION),
    ],
  ];

  it.each(calls)('%s calls %s %s', async (_name, call, method, path, answer) => {
    const { client, fake } = clientAnswering(answer);
    await call(client);

    expect(fake.only().method).toBe(method);
    expect(fake.only().url).toBe(`${BASE}${path}`);
  });

  it.each([
    ['a trailing slash', `${BASE}/`, `${BASE}/healthz`],
    ['several trailing slashes', `${BASE}///`, `${BASE}/healthz`],
    ['a path prefix (a reverse proxy)', `${BASE}/lantern/`, `${BASE}/lantern/healthz`],
    ['https', 'https://lantern.example', 'https://lantern.example/healthz'],
  ])('join a base URL with %s', async (_label, baseUrl, expected) => {
    const fake = fakeFetch(json(200, { status: 'ok' }));
    await createLanternClient({ baseUrl, fetch: fake.fetch }).health();

    expect(fake.only().url).toBe(expected);
  });

  describe('outside a browser', () => {
    it('need an absolute base URL', () => {
      expect('location' in globalThis).toBe(false);
      expect(() => createLanternClient()).toThrow(/needs an absolute baseUrl/);
      expect(() => createLanternClient({ baseUrl: '' })).toThrow(/needs an absolute baseUrl/);
      expect(() => createLanternClient({ baseUrl: '/lantern' })).toThrow(
        /needs an absolute baseUrl/,
      );
    });

    it.each(['localhost:7600', '127.0.0.1:7600', 'ftp://127.0.0.1', 'lantern'])(
      'refuse %s, which is neither an http(s) URL nor a path',
      (baseUrl) => {
        expect(() => createLanternClient({ baseUrl })).toThrow(TypeError);
        expect(() => createLanternClient({ baseUrl })).toThrow(/http\(s\) URL or a path/);
      },
    );
  });

  describe('in a browser', () => {
    function inABrowser(): void {
      vi.stubGlobal('location', new URL('http://localhost:5173/l/lib_x/generate'));
    }

    it('go relative to the page without a base URL', async () => {
      inABrowser();
      const fake = fakeFetch(json(200, { libraries: [] }));
      await createLanternClient({ fetch: fake.fetch }).listLibraries();

      expect(fake.only().url).toBe('/api/v1/libraries');
    });

    it('may go under a path prefix', async () => {
      inABrowser();
      const fake = fakeFetch(json(200, { status: 'ok' }));
      await createLanternClient({ baseUrl: '/lantern/', fetch: fake.fetch }).health();

      expect(fake.only().url).toBe('/lantern/healthz');
    });
  });
});

describe('what is sent', () => {
  it('asks for JSON and lets the browser send cookies only to its own origin', async () => {
    const { client, fake } = clientAnswering(json(200, { status: 'ok' }));
    await client.health();

    expect(fake.only().headers.get('accept')).toBe('application/json');
    expect(fake.only().credentials).toBe('same-origin');
  });

  it('sends the password as a JSON body', async () => {
    const { client, fake } = clientAnswering(empty(204));
    await client.login('correct horse');

    expect(fake.only().headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(fake.only().body!)).toEqual({ password: 'correct horse' });
  });

  it('sends a resolve body as JSON to the library’s path, its id encoded', async () => {
    const { client, fake } = clientAnswering(json(200, RESOLUTION));
    expect(await client.resolve('lib/../x', { ...RESOLVE_BODY, route: 'rt_a' })).toEqual(
      RESOLUTION,
    );

    expect(fake.only().url).toBe(`${BASE}/api/v1/libraries/lib%2F..%2Fx/resolve`);
    expect(fake.only().headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(fake.only().body!)).toEqual({ ...RESOLVE_BODY, route: 'rt_a' });
  });

  it('sends no body and no content type when there is nothing to send', async () => {
    const { client, fake } = clientAnswering(empty(204), json(200, { status: 'ok' }));
    await client.logout();
    await client.health();

    for (const request of fake.requests) {
      expect(request.body).toBeUndefined();
      expect(request.headers.has('content-type')).toBe(false);
    }
  });

  it('adds the configured headers to every request', async () => {
    const fake = fakeFetch(json(200, { status: 'ok' }), empty(204));
    const client = createLanternClient({
      baseUrl: BASE,
      fetch: fake.fetch,
      headers: { 'X-Lantern-Client': 'storyengine' },
    });
    await client.health();
    await client.login('pw');

    for (const request of fake.requests) {
      expect(request.headers.get('x-lantern-client')).toBe('storyengine');
    }
  });

  it('keeps accept and content-type its own, whatever their case in the configured headers', async () => {
    const fake = fakeFetch(empty(204), empty(204));
    const client = createLanternClient({
      baseUrl: BASE,
      fetch: fake.fetch,
      headers: { Accept: 'text/html', 'Content-Type': 'text/plain' },
    });
    await client.login('pw');
    await client.logout();

    const [login, logout] = fake.requests;
    // Not "text/html, application/json": one value, not two merged.
    expect(login!.headers.get('accept')).toBe('application/json');
    expect(login!.headers.get('content-type')).toBe('application/json');
    expect(logout!.headers.has('content-type')).toBe(false);
  });

  it('refuses a malformed configured header when the client is made, not on first use', () => {
    expect(() =>
      createLanternClient({
        baseUrl: BASE,
        headers: { 'Bad Name': 'x' },
        fetch: fakeFetch().fetch,
      }),
    ).toThrow(TypeError);
  });

  it('passes the abort signal through', async () => {
    const { client, fake } = clientAnswering(json(200, { status: 'ok' }));
    const controller = new AbortController();
    await client.health({ signal: controller.signal });

    expect(fake.only().signal).toBe(controller.signal);
  });

  it('uses the global fetch, looked up when a request is made, when none is given', async () => {
    const client = createLanternClient({ baseUrl: BASE });
    // Stubbed after the client was made: a client must not capture the global.
    const fake = fakeFetch(json(200, { status: 'ok' }));
    vi.stubGlobal('fetch', fake.fetch);
    await client.health();

    expect(fake.only().url).toBe(`${BASE}/healthz`);
  });
});

describe('successful answers', () => {
  it('are returned as parsed', async () => {
    const { client } = clientAnswering(
      json(200, { status: 'ok' }),
      json(200, { mode: 'password', authenticated: false }),
      json(200, { name: 'lantern', version: '0.1.0', apiVersion: 'v1' }),
      json(200, { libraries: [LIBRARY] }),
    );

    expect(await client.health()).toEqual({ status: 'ok' });
    expect(await client.session()).toEqual({ mode: 'password', authenticated: false });
    expect(await client.info()).toEqual({ name: 'lantern', version: '0.1.0', apiVersion: 'v1' });
    expect(await client.listLibraries()).toEqual({ libraries: [LIBRARY] });
  });

  it('keep fields a newer daemon adds', async () => {
    const { client } = clientAnswering(
      json(200, { libraries: [{ ...LIBRARY, colour: 'teal' }], cursor: 'next' }),
    );

    expect(await client.listLibraries()).toEqual({
      libraries: [{ ...LIBRARY, colour: 'teal' }],
      cursor: 'next',
    });
  });

  it('resolve sign-in and sign-out with nothing on 204', async () => {
    const { client } = clientAnswering(empty(204), empty(204));

    await expect(client.login('pw')).resolves.toBeUndefined();
    await expect(client.logout()).resolves.toBeUndefined();
  });

  it('ignore a body on a sign-in success', async () => {
    const { client } = clientAnswering(json(200, { welcome: true }));

    await expect(client.login('pw')).resolves.toBeUndefined();
  });

  it.each([
    ['empty', empty(200)],
    ['a 204', empty(204)],
    ['whitespace', text(200, ' \n', 'application/json')],
  ])('are a protocol error when a body is due and the answer is %s', async (_label, answer) => {
    const { client } = clientAnswering(answer);
    const error = await apiErrorOf(client.info());

    expect(error.code).toBe(INVALID_RESPONSE_CODE);
    expect(error.message).toMatch(/GET \/api\/v1\/info with an empty body/);
  });

  it.each([
    ['null', null],
    ['an array', [LIBRARY]],
    ['a string', 'ok'],
    ['a number', 42],
  ])('are a protocol error when the JSON is %s rather than an object', async (_label, body) => {
    const { client } = clientAnswering(json(200, body));
    const error = await apiErrorOf(client.listLibraries());

    expect(error.status).toBe(200);
    expect(error.code).toBe(INVALID_RESPONSE_CODE);
    expect(error.message).toMatch(/not an object/);
  });

  it('are a protocol error when the body is not JSON', async () => {
    const { client } = clientAnswering(text(200, '<!doctype html><title>Lantern</title>'));
    const error = await apiErrorOf(client.session());

    expect(error.status).toBe(200);
    expect(error.code).toBe(INVALID_RESPONSE_CODE);
    expect(error.message).toMatch(/GET \/api\/v1\/session with a body that is not JSON/);
  });
});

describe('refusals', () => {
  it('become a LanternApiError carrying the envelope', async () => {
    const { client } = clientAnswering(
      json(401, { error: ErrorCodes.unauthenticated, message: 'Sign in first.' }),
    );
    const error = await apiErrorOf(client.listLibraries());

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('LanternApiError');
    expect(error.status).toBe(401);
    expect(error.code).toBe('unauthenticated');
    expect(error.message).toBe('Sign in first.');
    expect(error.issues).toBeUndefined();
    expect(errorCode(error)).toBe('unauthenticated');
  });

  it('carry the validation issues of a 422', async () => {
    const issues = [{ path: '/remember', message: 'must NOT have additional properties' }];
    const { client } = clientAnswering(
      json(422, { error: ErrorCodes.invalid, message: 'The request is not valid.', issues }),
    );
    const error = await apiErrorOf(client.login('pw'));

    expect(error.status).toBe(422);
    expect(error.code).toBe('invalid');
    expect(error.issues).toEqual(issues);
  });

  it('carry a resolve refusal’s issues, suggested values included', async () => {
    const issues = [{ path: '/request/sampling/steps', message: 'must be <= 150', suggested: 150 }];
    const { client } = clientAnswering(
      json(422, { error: ErrorCodes.invalid, message: 'The body is not valid.', issues }),
      json(404, { error: ErrorCodes.notFound, message: 'No such library.' }),
    );
    const invalid = await apiErrorOf(client.resolve(LIBRARY.id, RESOLVE_BODY));
    const missing = await apiErrorOf(client.resolve(LIBRARY.id, RESOLVE_BODY));

    expect(invalid.issues).toEqual(issues);
    expect(missing.status).toBe(404);
    expect(missing.code).toBe('not-found');
  });

  it.each([
    [401, ErrorCodes.invalidCredentials],
    [409, ErrorCodes.authDisabled],
    [415, ErrorCodes.unsupportedMediaType],
    [403, ErrorCodes.forbiddenOrigin],
  ])('keep the code of a %i on sign-in (%s)', async (status, code) => {
    const { client } = clientAnswering(json(status, { error: code, message: 'No.' }));
    const error = await apiErrorOf(client.login('pw'));

    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
  });

  it('keep an error code this client does not know, from a newer daemon', async () => {
    const { client } = clientAnswering(json(429, { error: 'rate-limited', message: 'Slow down.' }));

    expect((await apiErrorOf(client.health())).code).toBe('rate-limited');
  });

  it('without an envelope (a proxy’s error page) have the unknown code and say the status', async () => {
    const { client } = clientAnswering(text(502, '<html><body>Bad Gateway</body></html>'));
    const error = await apiErrorOf(client.info());

    expect(error.status).toBe(502);
    expect(error.code).toBe(UNKNOWN_ERROR_CODE);
    expect(error.message).toBe('The Lantern daemon answered with status 502.');
  });

  it('with no body at all have the unknown code', async () => {
    const { client } = clientAnswering(empty(500));
    const error = await apiErrorOf(client.logout());

    expect(error.status).toBe(500);
    expect(error.code).toBe(UNKNOWN_ERROR_CODE);
  });
});

describe('failures that are not answers', () => {
  it('pass a network error through unchanged', async () => {
    const failure = new TypeError('fetch failed');
    const { client } = clientAnswering(failure);
    const error = await rejectionOf(client.health());

    expect(error).toBe(failure);
    expect(errorCode(error)).toBeNull();
  });

  it('pass an abort through as the AbortError fetch raised', async () => {
    const controller = new AbortController();
    const { client } = clientAnswering((request) => {
      controller.abort();
      throw request.signal!.reason as Error;
    });
    const error = await rejectionOf(client.session({ signal: controller.signal }));

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
    expect(errorCode(error)).toBeNull();
  });
});

describe('libraries and assets', () => {
  const ASSET = 'a'.repeat(64);
  const SUMMARY = {
    id: ASSET,
    media_type: 'image/png',
    bytes: 10,
    width: 1,
    height: 1,
    frames: null,
    origin: 'uploaded',
    bytes_state: 'present',
    retention: 'keep',
    rating: null,
    pixel_hash: null,
    pixel_hash_alg: null,
    created_at: '2026-10-15T00:00:00.000Z',
    output_of: null,
  };
  const LIB = LIBRARY.id;

  it('creates and renames libraries with a JSON name', async () => {
    const { client, fake } = clientAnswering(json(201, LIBRARY), json(200, LIBRARY));
    expect(await client.createLibrary('Sketches')).toEqual(LIBRARY);
    expect(await client.renameLibrary(LIB, 'Main')).toEqual(LIBRARY);
    const [create, rename] = fake.requests;
    expect([create!.method, create!.url, JSON.parse(create!.body!)]).toEqual([
      'POST',
      `${BASE}/api/v1/libraries`,
      { name: 'Sketches' },
    ]);
    expect([rename!.method, rename!.url, JSON.parse(rename!.body!)]).toEqual([
      'PATCH',
      `${BASE}/api/v1/libraries/${LIB}`,
      { name: 'Main' },
    ]);
  });

  it('uploads a file as multipart, leaving the content type and boundary to fetch', async () => {
    const { client, fake } = clientAnswering(json(201, SUMMARY));
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    expect(await client.uploadAsset(LIB, file)).toEqual(SUMMARY);
    const request = fake.only();
    expect(request.url).toBe(`${BASE}/api/v1/libraries/${LIB}/assets`);
    expect(request.headers.has('content-type')).toBe(false);
    expect(request.form?.get('file')).toBeInstanceOf(Blob);
    expect([...request.form!.keys()]).toEqual(['file']);
  });

  it('writes the query string, numbers as numbers, nothing for what is absent', async () => {
    const page = { assets: [SUMMARY], next_cursor: null };
    const { client, fake } = clientAnswering(json(200, page), json(200, page));
    expect(
      await client.listAssets(LIB, { q: 'long_hair red', ratingMin: 3, limit: 20, cursor: 'abc' }),
    ).toEqual(page);
    await client.listAssets(LIB);
    const [filtered, plain] = fake.requests;
    expect(filtered!.url).toBe(
      `${BASE}/api/v1/libraries/${LIB}/assets?q=long_hair+red&rating_min=3&limit=20&cursor=abc`,
    );
    expect(plain!.url).toBe(`${BASE}/api/v1/libraries/${LIB}/assets`);
  });

  it('reads provenance and lineage, rates and deletes', async () => {
    const { client, fake } = clientAnswering(
      json(200, { asset: SUMMARY, job: null, derived_from: null }),
      json(200, { asset: ASSET, nodes: [SUMMARY], edges: [], truncated: false }),
      json(200, { ...SUMMARY, rating: 4 }),
      empty(204),
    );
    await client.assetProvenance(LIB, ASSET);
    await client.assetLineage(LIB, ASSET);
    expect((await client.rateAsset(LIB, ASSET, 4)).rating).toBe(4);
    await client.deleteAsset(LIB, ASSET);
    expect(fake.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET ${BASE}/api/v1/libraries/${LIB}/assets/${ASSET}/provenance`,
      `GET ${BASE}/api/v1/libraries/${LIB}/assets/${ASSET}/lineage`,
      `PATCH ${BASE}/api/v1/libraries/${LIB}/assets/${ASSET}`,
      `DELETE ${BASE}/api/v1/libraries/${LIB}/assets/${ASSET}`,
    ]);
    expect(JSON.parse(fake.requests[2]!.body!)).toEqual({ rating: 4 });
    expect(fake.requests[3]!.body).toBeUndefined();
  });

  it('builds image URLs without making a request', () => {
    const { client, fake } = clientAnswering();
    expect(client.assetUrl(LIB, ASSET)).toBe(`${BASE}/api/v1/libraries/${LIB}/assets/${ASSET}`);
    expect(client.thumbnailUrl(LIB, ASSET)).toBe(
      `${BASE}/api/v1/libraries/${LIB}/assets/${ASSET}/thumb`,
    );
    expect(fake.requests).toEqual([]);
  });

  it('rejects a taken name with conflict', async () => {
    const { client } = clientAnswering(
      json(409, { error: 'conflict', message: 'Another library is already called "A".' }),
    );
    expect((await apiErrorOf(client.createLibrary('A'))).code).toBe(ErrorCodes.conflict);
  });
});

describe('jobs and events', () => {
  const LIB = LIBRARY.id;
  const JOB = 'job_01JA2B3C4D5E6F7G8H9JKMNPQR';
  const SUBMITTED = { job: { id: JOB }, field_report: {}, warnings: [], replayed: false };

  it('submits a job with an Idempotency-Key when given one', async () => {
    const { client, fake } = clientAnswering(json(202, SUBMITTED), json(202, SUBMITTED));
    const body = { request: RESOLVE_BODY.request, model: 'mdl_a' };
    await client.submitJob(LIB, body, { idempotencyKey: 'k-1' });
    await client.submitJob(LIB, body);
    const [keyed, plain] = fake.requests;
    expect(keyed!.url).toBe(`${BASE}/api/v1/libraries/${LIB}/jobs`);
    expect(keyed!.headers.get('idempotency-key')).toBe('k-1');
    expect(JSON.parse(keyed!.body!)).toEqual(body);
    expect(plain!.headers.has('idempotency-key')).toBe(false);
  });

  it('reaches history, one job, cancel, reruns and the queue', async () => {
    const { client, fake } = clientAnswering(
      json(200, { jobs: [], next_cursor: null }),
      json(200, { id: JOB }),
      json(202, { id: JOB }),
      json(202, SUBMITTED),
      json(202, SUBMITTED),
      json(200, { entries: [] }),
    );
    await client.listJobs(LIB, { state: 'live', limit: 5 });
    await client.getJob(LIB, JOB);
    await client.cancelJob(LIB, JOB);
    await client.reproduceJob(LIB, JOB);
    await client.rerollJob(LIB, JOB);
    await client.queue(LIB);
    expect(fake.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET ${BASE}/api/v1/libraries/${LIB}/jobs?state=live&limit=5`,
      `GET ${BASE}/api/v1/libraries/${LIB}/jobs/${JOB}`,
      `POST ${BASE}/api/v1/libraries/${LIB}/jobs/${JOB}/cancel`,
      `POST ${BASE}/api/v1/libraries/${LIB}/jobs/${JOB}/reproduce`,
      `POST ${BASE}/api/v1/libraries/${LIB}/jobs/${JOB}/reroll`,
      `GET ${BASE}/api/v1/queue?library=${LIB}`,
    ]);
  });

  it('streams events, parsed, split across chunks, and answers the last id', async () => {
    const chunks = [
      ': connected\n\nid: b:1\nevent: job.updated\nda',
      'ta: {"library":"x"}\n\nid: b:2\nevent: reset\ndata: {}\n\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const { client, fake } = clientAnswering(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const seen: unknown[] = [];
    const last = await client.streamEvents((event) => seen.push(event), { lastEventId: 'b:0' });
    expect(seen).toEqual([
      { id: 'b:1', type: 'job.updated', data: { library: 'x' } },
      { id: 'b:2', type: 'reset', data: {} },
    ]);
    expect(last).toBe('b:2');
    expect(fake.only().headers.get('last-event-id')).toBe('b:0');
    expect(fake.only().headers.get('accept')).toBe('text/event-stream');
  });

  it('rejects a refused stream with the daemon’s code', async () => {
    const { client } = clientAnswering(
      json(401, { error: 'unauthenticated', message: 'Sign in first.' }),
    );
    expect((await apiErrorOf(client.streamEvents(() => undefined))).code).toBe('unauthenticated');
  });
});
