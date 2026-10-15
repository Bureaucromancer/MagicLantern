// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { createHash } from 'node:crypto';

import {
  AssetLineage,
  AssetPage,
  AssetProvenance,
  AssetSummary,
  LibrarySummary,
  type GenerationRequest,
} from '@bureaucromancer/lantern-schema';
import type { TSchema } from '@sinclair/typebox';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import { newId } from '../ids.js';
import type { FinishedJob, Library, LibraryRegistry } from '../store/index.js';
import { makePng, SVG } from '../store/test-images.js';
import { makeTestApp, TEST_ORIGIN, type TestApp, type TestAppOptions } from '../test-app.js';
import { createValidator } from '../validation/ajv.js';

/** The daemon's own Ajv, which knows the date-time format (TypeBox's Value does not, by default). */
const ajv = createValidator();

function conforms(schema: TSchema, value: unknown): boolean {
  const valid = ajv.validate(schema, value);
  if (!valid) throw new Error(ajv.errorsText());
  return valid;
}

const apps: TestApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function start(
  options: TestAppOptions = {},
): Promise<TestApp & { lib: string; library: Library }> {
  const app = await makeTestApp({ storage: true, ...options });
  apps.push(app);
  const lib = app.libraries.list()[0]!.id;
  return { ...app, lib, library: app.libraries.library(lib)! };
}

interface Part {
  readonly name: string;
  readonly filename?: string;
  readonly type?: string;
  readonly body: Buffer | string;
}

/** A multipart/form-data body, as a browser's FormData sends it. */
function multipart(parts: readonly Part[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----lantern-test-boundary';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition =
      part.filename === undefined
        ? `form-data; name="${part.name}"`
        : `form-data; name="${part.name}"; filename="${part.filename}"`;
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: ${disposition}\r\n` +
          (part.type === undefined ? '' : `Content-Type: ${part.type}\r\n`) +
          '\r\n',
      ),
      Buffer.from(part.body),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, origin: TEST_ORIGIN },
  };
}

function fileParts(bytes: Buffer): readonly Part[] {
  return [{ name: 'file', filename: 'image.png', type: 'image/png', body: bytes }];
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function upload(app: TestApp, lib: string, bytes: Buffer) {
  return await app.request({
    method: 'POST',
    url: `/api/v1/libraries/${lib}/assets`,
    ...multipart(fileParts(bytes)),
  });
}

const json = { 'content-type': 'application/json', origin: TEST_ORIGIN };

describe('creating and renaming libraries', () => {
  it('creates one (201), usable at once, and refuses its name again (409)', async () => {
    const app = await start();
    const created = await app.request({
      method: 'POST',
      url: '/api/v1/libraries',
      headers: json,
      payload: { name: 'Sketches' },
    });
    expect(created.statusCode).toBe(201);
    const summary = created.json<{ id: string }>();
    expect(summary).toMatchObject({ name: 'Sketches', status: 'ok' });
    expect(conforms(LibrarySummary, summary)).toBe(true);

    expect((await upload(app, summary.id, makePng())).statusCode).toBe(201);

    const again = await app.request({
      method: 'POST',
      url: '/api/v1/libraries',
      headers: json,
      payload: { name: 'SKETCHES' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'conflict' });
  });

  it.each([[''], [' Leading'], ['Trailing '], ['Tab\there'], ['x'.repeat(101)]])(
    'refuses the name %j (422), never trimming it',
    async (name) => {
      const app = await start();
      const response = await app.request({
        method: 'POST',
        url: '/api/v1/libraries',
        headers: json,
        payload: { name },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().issues[0].path).toBe('/name');
    },
  );

  it('renames one (200), and answers 404 for an unknown one and 409 for a taken name', async () => {
    const app = await start();
    const rename = (lib: string, name: string) =>
      app.request({
        method: 'PATCH',
        url: `/api/v1/libraries/${lib}`,
        headers: json,
        payload: { name },
      });
    const renamed = await rename(app.lib, 'Main');
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: app.lib, name: 'Main' });
    expect((await rename(newId('lib'), 'Other')).statusCode).toBe(404);
    await app.libraries.create('Other');
    expect((await rename(app.lib, 'other')).json()).toMatchObject({ error: 'conflict' });
  });

  it('lists libraries with the disk each uses', async () => {
    const app = await start();
    await upload(app, app.lib, makePng(32, 32));
    const response = await app.request({ method: 'GET', url: '/api/v1/libraries' });
    const [library] = response.json().libraries;
    expect(library.usage).toMatchObject({
      assets_bytes: expect.any(Number),
      database_bytes: expect.any(Number),
      cache_bytes: expect.any(Number),
    });
    expect(library.usage.assets_bytes).toBeGreaterThan(0);
  });
});

describe('POST /api/v1/libraries/{lib}/assets', () => {
  it('stores the file as sent (201), and answers the same asset for the same bytes (200)', async () => {
    const app = await start();
    const bytes = makePng(10, 6, { texts: { parameters: 'as sent' } });
    const first = await upload(app, app.lib, bytes);
    expect(first.statusCode).toBe(201);
    const asset = first.json<AssetSummary>();
    expect(conforms(AssetSummary, asset)).toBe(true);
    expect(asset).toMatchObject({
      id: sha256(bytes),
      media_type: 'image/png',
      bytes: bytes.length,
      width: 10,
      height: 6,
      origin: 'uploaded',
      bytes_state: 'present',
      rating: null,
      output_of: null,
    });
    const second = await upload(app, app.lib, bytes);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(asset);

    const served = await app.request({
      method: 'GET',
      url: `/api/v1/libraries/${app.lib}/assets/${asset.id}`,
    });
    expect(served.rawPayload.equals(bytes)).toBe(true);
  });

  it('refuses a file that is not an image Lantern takes (422 at /file)', async () => {
    const app = await start();
    for (const bytes of [SVG, Buffer.from('plain text'), Buffer.alloc(0)]) {
      const response = await upload(app, app.lib, bytes);
      expect(response.statusCode).toBe(422);
      expect(response.json().issues[0].path).toBe('/file');
    }
  });

  it('needs exactly one part, named file (422)', async () => {
    const app = await start();
    const send = (parts: readonly Part[]) =>
      app.request({
        method: 'POST',
        url: `/api/v1/libraries/${app.lib}/assets`,
        ...multipart(parts),
      });

    const none = await send([{ name: 'note', body: 'hello' }]);
    expect(none.statusCode).toBe(422);
    expect(none.json().issues).toEqual([
      { path: '/note', message: 'is not a part this upload takes' },
    ]);

    const misnamed = await send([{ name: 'image', filename: 'a.png', body: makePng() }]);
    expect(misnamed.json().issues[0].path).toBe('/image');

    const two = await send([
      ...fileParts(makePng(4, 4, { seed: 1 })),
      ...fileParts(makePng(4, 4, { seed: 2 })),
    ]);
    expect(two.statusCode).toBe(422);
    expect(two.json().issues[0].message).toBe('is a second file; send one');

    const empty = await send([]);
    expect(empty.json().issues).toEqual([{ path: '/file', message: 'is required' }]);
  });

  it('refuses a file over limits.maxUploadMb (413)', async () => {
    const app = await start({ config: { limits: { maxUploadMb: 1 } } });
    const big = makePng(700, 700, { seed: 3 });
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const response = await upload(app, app.lib, big);
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: 'payload-too-large',
      message: 'The file is over the upload limit of 1 MB.',
    });
    expect(app.library.queryAssets({ limit: 5 }).assets).toEqual([]);
  });

  it('answers malformed multipart with 400', async () => {
    const app = await start();
    const response = await app.request({
      method: 'POST',
      url: `/api/v1/libraries/${app.lib}/assets`,
      headers: { 'content-type': 'multipart/form-data; boundary=x', origin: TEST_ORIGIN },
      payload: '--x\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n\r\ntrunc',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('bad-request');
  });

  it('takes multipart only, and only here (415)', async () => {
    const app = await start();
    const asJson = await app.request({
      method: 'POST',
      url: `/api/v1/libraries/${app.lib}/assets`,
      headers: json,
      payload: { file: 'x' },
    });
    expect(asJson.statusCode).toBe(415);
    expect(asJson.json().message).toBe('The body must be multipart/form-data.');

    const elsewhere = await app.request({
      method: 'POST',
      url: '/api/v1/libraries',
      ...multipart([{ name: 'name', body: 'Sneaky' }]),
    });
    expect(elsewhere.statusCode).toBe(415);
  });

  it('refuses an upload from another web page (403), before reading it', async () => {
    const app = await start();
    const { payload, headers } = multipart(fileParts(makePng()));
    const response = await app.request({
      method: 'POST',
      url: `/api/v1/libraries/${app.lib}/assets`,
      payload,
      headers: { ...headers, origin: 'https://evil.example' },
    });
    expect(response.statusCode).toBe(403);
    expect(app.library.queryAssets({ limit: 5 }).assets).toEqual([]);
  });

  it('answers 404 for an unknown library and 422 for a malformed id', async () => {
    const app = await start();
    expect((await upload(app, newId('lib'), makePng())).statusCode).toBe(404);
    expect((await upload(app, 'lib_nope', makePng())).statusCode).toBe(422);
  });
});

describe('GET an asset and its thumbnail', () => {
  it('serves the bytes under their type, cacheable for good, sandboxed, with an ETag', async () => {
    const app = await start();
    const bytes = makePng(400, 200);
    const { id } = (await upload(app, app.lib, bytes)).json<{ id: string }>();
    const url = `/api/v1/libraries/${app.lib}/assets/${id}`;
    const response = await app.request({ method: 'GET', url });
    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      'content-type': 'image/png',
      etag: `"${id}"`,
      'cache-control': 'private, max-age=31536000, immutable',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
    });
    expect(response.rawPayload.equals(bytes)).toBe(true);

    const revalidated = await app.request({
      method: 'GET',
      url,
      headers: { 'if-none-match': `"${id}"` },
    });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.rawPayload.length).toBe(0);

    const thumb = await app.request({ method: 'GET', url: `${url}/thumb` });
    expect(thumb.headers['content-type']).toBe('image/webp');
    expect(await sharp(thumb.rawPayload).metadata()).toMatchObject({ width: 384, height: 192 });
  });

  it('answers 404 for an unknown asset and 422 for a malformed id', async () => {
    const app = await start();
    const base = `/api/v1/libraries/${app.lib}/assets`;
    expect(
      (await app.request({ method: 'GET', url: `${base}/${'f'.repeat(64)}` })).statusCode,
    ).toBe(404);
    expect(
      (await app.request({ method: 'GET', url: `${base}/${'F'.repeat(64)}` })).statusCode,
    ).toBe(422);
    expect((await app.request({ method: 'GET', url: `${base}/../x` })).statusCode).not.toBe(200);
  });
});

describe('rating and deleting', () => {
  it('rates (200), clears, and refuses a rating outside 1 to 5 (422)', async () => {
    const app = await start();
    const { id } = (await upload(app, app.lib, makePng())).json<{ id: string }>();
    const patch = (rating: unknown) =>
      app.request({
        method: 'PATCH',
        url: `/api/v1/libraries/${app.lib}/assets/${id}`,
        headers: json,
        payload: { rating },
      });
    expect((await patch(4)).json()).toMatchObject({ id, rating: 4 });
    expect((await patch(null)).json()).toMatchObject({ rating: null });
    expect((await patch(6)).statusCode).toBe(422);
    expect((await patch('5')).statusCode).toBe(422);
  });

  it('deletes the bytes (204); they answer 410 while the provenance stays', async () => {
    const app = await start();
    const { id } = (await upload(app, app.lib, makePng())).json<{ id: string }>();
    const url = `/api/v1/libraries/${app.lib}/assets/${id}`;
    const deleted = await app.request({ method: 'DELETE', url, headers: { origin: TEST_ORIGIN } });
    expect(deleted.statusCode).toBe(204);
    for (const path of [url, `${url}/thumb`]) {
      const response = await app.request({ method: 'GET', url: path });
      expect(response.statusCode).toBe(410);
      expect(response.json().error).toBe('gone');
    }
    const provenance = await app.request({ method: 'GET', url: `${url}/provenance` });
    expect(provenance.json().asset).toMatchObject({ id, bytes_state: 'trashed' });
    expect(
      (await app.request({ method: 'DELETE', url, headers: { origin: TEST_ORIGIN } })).statusCode,
    ).toBe(204);
  });
});

function request(positive: string): GenerationRequest {
  return { schema_version: 1, mode: 'txt2img', prompt: { positive }, sampling: { seed: 7 } };
}

let clock = 1_750_000_000_000;

function job(overrides: Partial<FinishedJob> = {}): FinishedJob {
  clock += 1000;
  const canonical = overrides.canonical ?? request('a lighthouse at dusk');
  return {
    id: newId('job'),
    modelId: 'sdxl',
    routeId: 'rt_1',
    routeSnapshot: { backend: { kind: 'mock' } },
    outcome: 'done',
    createdAt: clock,
    finishedAt: clock + 10,
    canonical,
    effective: canonical,
    inputs: [],
    outputs: [{ index: 0, bytes: makePng(8, 8, { seed: clock }), seed: 7 }],
    ...overrides,
  };
}

describe('GET /api/v1/libraries/{lib}/assets', () => {
  it('pages newest first with a cursor, and filters', async () => {
    const app = await start();
    const outputs: string[] = [];
    for (const positive of ['long_hair girl', 'a red barn', 'long_hair cat']) {
      const imported = await app.library.importFinishedJob(job({ canonical: request(positive) }));
      outputs.push(imported.outputs[0]!.id);
    }
    const base = `/api/v1/libraries/${app.lib}/assets`;
    const first = await app.request({ method: 'GET', url: `${base}?limit=2` });
    const page = first.json<AssetPage>();
    expect(conforms(AssetPage, page)).toBe(true);
    expect(page.assets.map((asset: { id: string }) => asset.id)).toEqual([outputs[2], outputs[1]]);
    expect(page.assets[0]!.output_of).toMatchObject({ index: 0, seed: 7, model_id: 'sdxl' });
    const second = (
      await app.request({
        method: 'GET',
        url: `${base}?limit=2&cursor=${String(page.next_cursor)}`,
      })
    ).json();
    expect(second).toEqual({
      assets: [expect.objectContaining({ id: outputs[0] })],
      next_cursor: null,
    });

    const search = (
      await app.request({ method: 'GET', url: `${base}?q=${encodeURIComponent('long_hair')}` })
    ).json();
    expect(search.assets.map((asset: { id: string }) => asset.id)).toEqual([
      outputs[2],
      outputs[0],
    ]);

    const none = (await app.request({ method: 'GET', url: `${base}?model=flux` })).json();
    expect(none.assets).toEqual([]);
  });

  it('refuses a malformed limit, cursor or date (422)', async () => {
    const app = await start();
    const base = `/api/v1/libraries/${app.lib}/assets`;
    for (const query of [
      'limit=0',
      'limit=201',
      'limit=x',
      'cursor=bm9wZQ',
      'created_after=yesterday',
      'rating_min=6',
      'extra=1',
    ]) {
      const response = await app.request({ method: 'GET', url: `${base}?${query}` });
      expect(response.statusCode, query).toBe(422);
    }
  });
});

describe('provenance and lineage', () => {
  it('answer what made an output, and its family', async () => {
    const app = await start();
    const parent = (await upload(app, app.lib, makePng(8, 8, { seed: 21 }))).json<{ id: string }>();
    const made = await app.library.importFinishedJob(
      job({ inputs: [{ position: 0, assetId: parent.id, role: 'init', weight: 0.5 }] }),
    );
    const child = made.outputs[0]!.id;
    const base = `/api/v1/libraries/${app.lib}/assets/${child}`;

    const provenance = (await app.request({ method: 'GET', url: `${base}/provenance` })).json();
    expect(conforms(AssetProvenance, provenance)).toBe(true);
    expect(provenance.job).toMatchObject({
      id: made.job.id,
      state: 'finished',
      outcome: 'done',
      model_id: 'sdxl',
      canonical: request('a lighthouse at dusk'),
      inputs: [
        {
          position: 0,
          asset_id: parent.id,
          role: 'init',
          weight: 0.5,
          region: null,
          crop: null,
          source_library: null,
        },
      ],
      outputs: [{ index: 0, asset_id: child, seed: 7 }],
    });
    expect(provenance.job.created_at).toMatch(/Z$/);

    const lineage = (await app.request({ method: 'GET', url: `${base}/lineage` })).json();
    expect(conforms(AssetLineage, lineage)).toBe(true);
    expect(lineage.nodes.map((node: { id: string }) => node.id)).toEqual([child, parent.id]);
    expect(lineage.edges).toEqual([
      { parent: parent.id, child, kind: 'job', job_id: made.job.id, role: 'init' },
    ]);

    const uploaded = (
      await app.request({
        method: 'GET',
        url: `/api/v1/libraries/${app.lib}/assets/${parent.id}/provenance`,
      })
    ).json();
    expect(uploaded).toMatchObject({ job: null, derived_from: null });
  });
});

describe('libraries that cannot take the request', () => {
  function wrap(registry: LibraryRegistry, change: Partial<LibraryRegistry>): LibraryRegistry {
    return {
      list: () => registry.list(),
      get: (id) => registry.get(id),
      library: (id) => registry.library(id),
      jobs: (id) => registry.jobs(id),
      create: (name) => registry.create(name),
      rename: (id, name) => registry.rename(id, name),
      close: () => {
        registry.close();
      },
      ...change,
    };
  }

  it('a read-only library serves reads and refuses writes (409 library-read-only)', async () => {
    const real = await start();
    const { id } = (await upload(real, real.lib, makePng())).json<{ id: string }>();
    const readOnly = Object.create(real.library, { writable: { value: false } }) as Library;
    const app = await makeTestApp({
      dataDir: real.dataDir,
      libraries: wrap(real.libraries, {
        get: (lib) => ({ ...real.libraries.get(lib)!, status: 'read-only' }),
        library: () => readOnly,
      }),
    });
    apps.push(app);
    const url = `/api/v1/libraries/${real.lib}/assets`;
    expect((await app.request({ method: 'GET', url: `${url}/${id}` })).statusCode).toBe(200);
    const refused = await upload(app, real.lib, makePng(4, 4, { seed: 2 }));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('library-read-only');
    const deleted = await app.request({
      method: 'DELETE',
      url: `${url}/${id}`,
      headers: { origin: TEST_ORIGIN },
    });
    expect(deleted.json().error).toBe('library-read-only');
  });

  it('an unavailable library answers 409 library-unavailable, with its reason', async () => {
    const real = await start();
    const app = await makeTestApp({
      dataDir: real.dataDir,
      libraries: wrap(real.libraries, {
        get: (lib) => ({
          ...real.libraries.get(lib)!,
          status: 'unavailable',
          reason: 'Its database was not found.',
        }),
        library: () => undefined,
      }),
    });
    apps.push(app);
    const response = await app.request({
      method: 'GET',
      url: `/api/v1/libraries/${real.lib}/assets`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'library-unavailable',
      message: 'The library is unavailable. Its database was not found.',
    });
  });
});
