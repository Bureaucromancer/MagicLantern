// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { GenerationRequest } from '@bureaucromancer/lantern-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../ids.js';
import { assetPath, spoolPath, thumbnailPath } from './asset-files.js';
import { openInstall } from './install.js';
import { openLibraries } from './libraries.js';
import {
  AssetUnavailableError,
  LibraryReadOnlyError,
  type FinishedJob,
  type Library,
} from './library-types.js';
import { IngestError, LocalLibrary } from './local-library.js';
import { ImageRefusedError } from './media.js';
import { libraryPaths, type LibraryPaths } from './paths.js';
import { PIXEL_HASH_ALG, pngPixelHash } from './pixel-hash.js';
import { decodeText, hasKeyword, readChunks } from './png.js';
import { collectingLog, removeDir, tempDir, testBoot } from './test-store.js';
import { makeImage, makePng, SVG } from './test-images.js';
import type { InstallStore, LibraryRegistry } from './types.js';

let dataDir: string;
let install: InstallStore;
let registry: LibraryRegistry;
let library: LocalLibrary;
let paths: LibraryPaths;

async function openRegistry(): Promise<void> {
  registry = (await openLibraries(install, dataDir, { log: collectingLog() })).registry;
  const record = registry.list()[0]!;
  library = registry.library(record.id) as LocalLibrary;
  paths = libraryPaths(dataDir, record.path);
}

beforeEach(async () => {
  dataDir = await tempDir('library');
  install = (await openInstall(dataDir, { boot: testBoot(), log: collectingLog() })).store;
  await openRegistry();
});

afterEach(async () => {
  registry.close();
  install.close();
  await removeDir(dataDir);
});

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function request(positive: string, negative?: string): GenerationRequest {
  return {
    schema_version: 1,
    mode: 'txt2img',
    prompt: { positive, ...(negative === undefined ? {} : { negative }) },
    sampling: { seed: 42 },
  };
}

let clock = 1_700_000_000_000;

function finishedJob(overrides: Partial<FinishedJob> = {}): FinishedJob {
  clock += 1000;
  const canonical = overrides.canonical ?? request('a red fox in snow');
  return {
    id: newId('job'),
    modelId: 'sdxl',
    routeId: 'rt_1',
    routeSnapshot: { backend: { kind: 'mock' }, descriptor_digest: 'd1' },
    outcome: 'done',
    createdAt: clock,
    finishedAt: clock + 500,
    canonical,
    effective: { ...canonical, sampling: { seed: 42, steps: 20 } },
    fieldReport: { 'sampling.steps': { state: 'native', source: 'profile', used: 20 } },
    wire: { prompt: canonical.prompt.positive, init: { $asset: 'none' } },
    backendResponse: { generator: 'mock 1' },
    inputs: [],
    outputs: [{ index: 0, bytes: makePng(8, 8, { seed: clock }), seed: 42 }],
    ...overrides,
  };
}

describe('uploads', () => {
  it('are stored exactly as sent, named by their hash, with a thumbnail', async () => {
    const bytes = makePng(10, 6, { seed: 2, texts: { parameters: 'kept as sent' } });
    const { asset, created } = await library.ingestUpload(bytes);
    expect(created).toBe(true);
    expect(asset).toMatchObject({
      id: sha256(bytes),
      mediaType: 'image/png',
      bytes: bytes.length,
      width: 10,
      height: 6,
      frames: null,
      origin: 'uploaded',
      bytesState: 'present',
      retention: 'keep',
      rating: null,
      pixelHash: pngPixelHash(bytes),
      pixelHashAlg: PIXEL_HASH_ALG,
      outputOf: null,
      derivedFrom: null,
    });
    const stored = await readFile(assetPath(paths, asset.id, 'image/png'));
    expect(stored.equals(bytes)).toBe(true);
    expect(existsSync(thumbnailPath(paths, asset.id))).toBe(true);
    expect(assetPath(paths, asset.id, 'image/png')).toContain(
      join('assets', asset.id.slice(0, 2), asset.id.slice(2, 4)),
    );
  });

  it('take other raster formats, with no pixel hash', async () => {
    const { asset } = await library.ingestUpload(await makeImage('jpeg', 12, 8));
    expect(asset).toMatchObject({
      mediaType: 'image/jpeg',
      width: 12,
      height: 8,
      pixelHash: null,
      pixelHashAlg: null,
    });
    expect(existsSync(assetPath(paths, asset.id, 'image/jpeg'))).toBe(true);
  });

  it('answer the existing asset for bytes already held', async () => {
    const bytes = makePng(4, 4, { seed: 9 });
    const first = await library.ingestUpload(bytes);
    const second = await library.ingestUpload(bytes);
    expect(second).toEqual({ asset: first.asset, created: false });
  });

  it('refuse anything but an accepted raster image, storing nothing', async () => {
    await expect(library.ingestUpload(SVG)).rejects.toThrow(ImageRefusedError);
    await expect(library.ingestUpload(Buffer.from('not an image'))).rejects.toThrow(
      ImageRefusedError,
    );
    expect(library.queryAssets({ limit: 10 }).assets).toEqual([]);
    expect(existsSync(paths.assets)).toBe(false);
  });

  it('of the same bytes at once store one asset', async () => {
    const bytes = makePng(4, 4, { seed: 10 });
    const results = await Promise.all([library.ingestUpload(bytes), library.ingestUpload(bytes)]);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
  });
});

describe('deleting an asset (A23)', () => {
  it('removes the bytes and thumbnail and keeps the record', async () => {
    const { asset } = await library.ingestUpload(makePng(4, 4, { seed: 3 }));
    const deleted = await library.deleteAsset(asset.id);
    expect(deleted).toMatchObject({
      id: asset.id,
      bytesState: 'trashed',
      pixelHash: asset.pixelHash,
    });
    expect(existsSync(assetPath(paths, asset.id, 'image/png'))).toBe(false);
    expect(existsSync(thumbnailPath(paths, asset.id))).toBe(false);
    expect(await library.readAsset(asset.id)).toMatchObject({ kind: 'gone' });
    expect(await library.readThumbnail(asset.id)).toMatchObject({ kind: 'gone' });
    expect(library.queryAssets({ limit: 10 }).assets).toEqual([]);
    expect(library.provenance(asset.id)?.asset.bytesState).toBe('trashed');
  });

  it('succeeds again, and is undefined for an unknown asset', async () => {
    const { asset } = await library.ingestUpload(makePng(4, 4, { seed: 3 }));
    await library.deleteAsset(asset.id);
    expect((await library.deleteAsset(asset.id))?.bytesState).toBe('trashed');
    expect(await library.deleteAsset('f'.repeat(64))).toBeUndefined();
  });

  it('is undone by uploading the same bytes, which keeps the rating', async () => {
    const bytes = makePng(4, 4, { seed: 3 });
    const { asset } = await library.ingestUpload(bytes);
    library.rate(asset.id, 4);
    await library.deleteAsset(asset.id);
    const again = await library.ingestUpload(bytes);
    expect(again.created).toBe(false);
    expect(again.asset).toMatchObject({ bytesState: 'present', rating: 4, origin: 'uploaded' });
    expect((await library.readAsset(asset.id)).kind).toBe('present');
  });
});

describe('ratings', () => {
  it('are set and cleared', async () => {
    const { asset } = await library.ingestUpload(makePng(4, 4));
    expect(library.rate(asset.id, 5)?.rating).toBe(5);
    expect(library.rate(asset.id, null)?.rating).toBeNull();
    expect(library.rate('e'.repeat(64), 3)).toBeUndefined();
  });

  it('are refused by the database outside 1 to 5', async () => {
    const { asset } = await library.ingestUpload(makePng(4, 4));
    expect(() => library.rate(asset.id, 6)).toThrow(/CHECK/);
  });
});

describe('thumbnails', () => {
  it('are remade when the cache lost them', async () => {
    const { asset } = await library.ingestUpload(makePng(500, 250));
    const path = thumbnailPath(paths, asset.id);
    const first = await readFile(path);
    await removeDir(paths.cache);
    const remade = await library.readThumbnail(asset.id);
    expect(remade.kind).toBe('present');
    expect(remade.kind === 'present' && remade.bytes.equals(first)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });
});

describe('importFinishedJob', () => {
  it("stores outputs with the lantern chunk, keeping the backend's chunks and pixels (A24, rule 7)", async () => {
    const backend = makePng(8, 8, { seed: 5, texts: { parameters: 'a red fox\nSteps: 20' } });
    const job = finishedJob({ outputs: [{ index: 0, bytes: backend, seed: 42 }] });
    const { outputs, imported } = await library.importFinishedJob(job);
    expect(imported).toBe(true);
    const [output] = outputs;

    const stored = await readFile(assetPath(paths, output!.id, 'image/png'));
    expect(output!.id).toBe(sha256(stored));
    expect(output).toMatchObject({
      origin: 'generated',
      pixelHash: pngPixelHash(backend),
      outputOf: { jobId: job.id, index: 0, seed: 42, modelId: 'sdxl' },
    });

    const before = readChunks(backend);
    const after = readChunks(stored);
    const lantern = after.filter((chunk) => hasKeyword(chunk, 'lantern'));
    expect(lantern).toHaveLength(1);
    expect(after.filter((chunk) => !lantern.includes(chunk))).toEqual(before);
    expect(lantern[0]!.type).toBe('iTXt');

    const meta = JSON.parse(decodeText(lantern[0]!).text);
    expect(meta).toEqual({
      format: 1,
      job_id: job.id,
      library_id: library.id,
      output: { index: 0, seed: 42 },
      model_id: 'sdxl',
      canonical: job.canonical,
      effective: job.effective,
      route_snapshot: job.routeSnapshot,
    });
    expect(JSON.stringify(meta)).not.toContain('$asset');
  });

  it('writes the provenance, with the backend text chunks in backend_response', async () => {
    const backend = makePng(8, 8, { seed: 6, texts: { parameters: 'SDCPP: {"seed":42}' } });
    const job = finishedJob({ outputs: [{ index: 0, bytes: backend, seed: 42 }] });
    const { outputs } = await library.importFinishedJob(job);
    const provenance = library.provenance(outputs[0]!.id);
    expect(provenance?.job).toMatchObject({
      record: {
        id: job.id,
        state: 'finished',
        outcome: 'done',
        modelId: 'sdxl',
        routeId: 'rt_1',
        routeSnapshot: job.routeSnapshot,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
      },
      canonical: job.canonical,
      effective: job.effective,
      fieldReport: job.fieldReport,
      wire: job.wire,
      backendResponse: {
        generator: 'mock 1',
        png_text: [{ index: 0, chunks: { parameters: 'SDCPP: {"seed":42}' } }],
      },
      inputs: [],
      outputs: [{ index: 0, assetId: outputs[0]!.id, seed: 42 }],
    });
  });

  it('is a no-op the second time, as recovery may run it (A17)', async () => {
    const job = finishedJob();
    const first = await library.importFinishedJob(job);
    const second = await library.importFinishedJob(job);
    expect(second.imported).toBe(false);
    expect(second.outputs.map((asset) => asset.id)).toEqual(first.outputs.map((asset) => asset.id));
  });

  it('finishes a job the job store filed as queued', async () => {
    const job = finishedJob();
    library.insertQueued({
      id: job.id,
      modelId: job.modelId,
      canonical: job.canonical,
      createdAt: job.createdAt,
      collection: 'session-1',
    });
    expect(library.liveJobs().map((live) => live.id)).toEqual([job.id]);
    await library.importFinishedJob(job);
    expect(library.liveJobs()).toEqual([]);
    expect(library.getJob(job.id)).toMatchObject({
      state: 'finished',
      outcome: 'done',
      collection: 'session-1',
    });
  });

  it('records a failed job with no outputs', async () => {
    const job = finishedJob({ outcome: 'failed', outcomeReason: 'backend_error', outputs: [] });
    const { job: record, outputs } = await library.importFinishedJob(job);
    expect(outputs).toEqual([]);
    expect(record).toMatchObject({ outcome: 'failed', outcomeReason: 'backend_error' });
  });

  it('refuses an output that is not an image, storing nothing', async () => {
    const job = finishedJob({ outputs: [{ index: 0, bytes: Buffer.from('nope'), seed: 1 }] });
    await expect(library.importFinishedJob(job)).rejects.toThrow(IngestError);
    expect(library.getJob(job.id)).toBeUndefined();
  });

  it('refuses inputs that are not in this library', async () => {
    const job = finishedJob({ inputs: [{ position: 0, assetId: 'c'.repeat(64), role: 'init' }] });
    await expect(library.importFinishedJob(job)).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe('queries (ST5)', () => {
  it('list present assets newest first, a page at a time, with a stable cursor', async () => {
    const ids: string[] = [];
    for (let seed = 1; seed <= 5; seed += 1) {
      ids.push((await library.ingestUpload(makePng(4, 4, { seed }))).asset.id);
    }
    const first = library.queryAssets({ limit: 2 });
    expect(first.assets.map((asset) => asset.id)).toEqual([ids[4], ids[3]]);
    // An asset added between pages does not shift what comes next.
    await library.ingestUpload(makePng(4, 4, { seed: 99 }));
    const second = library.queryAssets({ limit: 2, after: first.next! });
    expect(second.assets.map((asset) => asset.id)).toEqual([ids[2], ids[1]]);
    const third = library.queryAssets({ limit: 2, after: second.next! });
    expect(third.assets.map((asset) => asset.id)).toEqual([ids[0]]);
    expect(third.next).toBeNull();
  });

  it('search prompts, keeping long_hair one word', async () => {
    const fox = await library.importFinishedJob(
      finishedJob({ canonical: request('1girl, long_hair, red dress', 'blurry') }),
    );
    await library.importFinishedJob(finishedJob({ canonical: request('a house, long hair') }));
    const ids = (text: string) =>
      library.queryAssets({ limit: 10, text }).assets.map((asset) => asset.id);
    expect(ids('long_hair')).toEqual([fox.outputs[0]!.id]);
    expect(ids('red long_hair')).toEqual([fox.outputs[0]!.id]);
    // The negative prompt is searched too.
    expect(ids('blurry')).toEqual([fox.outputs[0]!.id]);
    expect(ids('hair')).toHaveLength(1);
    // Syntax is text, never an FTS operator or an error: OR is a word to find.
    expect(ids('"long_hair" (red* NEAR')).toEqual([]);
    expect(ids('"long_hair" (red*')).toEqual([fox.outputs[0]!.id]);
    expect(ids('-*-')).toEqual([]);
  });

  it('filter by model, route, collection, origin, rating and date', async () => {
    const sdxl = await library.importFinishedJob(finishedJob({ collection: 'c1' }));
    const flux = await library.importFinishedJob(finishedJob({ modelId: 'flux', routeId: 'rt_2' }));
    const upload = await library.ingestUpload(makePng(4, 4, { seed: 77 }));
    library.rate(flux.outputs[0]!.id, 4);
    const ids = (filter: object) =>
      library
        .queryAssets({ limit: 10, ...filter })
        .assets.map((asset) => asset.id)
        .sort();
    expect(ids({ modelId: 'flux' })).toEqual([flux.outputs[0]!.id]);
    expect(ids({ routeId: 'rt_1' })).toEqual([sdxl.outputs[0]!.id]);
    expect(ids({ collection: 'c1' })).toEqual([sdxl.outputs[0]!.id]);
    expect(ids({ origin: 'uploaded' })).toEqual([upload.asset.id]);
    expect(ids({ ratingMin: 3 })).toEqual([flux.outputs[0]!.id]);
    const uploadedAt = upload.asset.createdAt;
    expect(ids({ createdFrom: uploadedAt })).toEqual([upload.asset.id]);
    expect(ids({ createdBefore: uploadedAt })).toHaveLength(2);
  });
});

describe('lineage', () => {
  it('links inputs to outputs through jobs, and crops to their source', async () => {
    const upload = await library.ingestUpload(makePng(16, 16, { seed: 1 }));
    const crop = await library.deriveCrop(upload.asset.id, { x: 0, y: 0, width: 0.5, height: 0.5 });
    expect(crop.asset).toMatchObject({
      origin: 'derived',
      width: 8,
      height: 8,
      derivedFrom: {
        assetId: upload.asset.id,
        operation: { crop: { x: 0, y: 0, width: 0.5, height: 0.5 } },
      },
    });
    const img2img = await library.importFinishedJob(
      finishedJob({
        inputs: [
          {
            position: 0,
            assetId: crop.asset.id,
            role: 'init',
            crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
          },
        ],
      }),
    );
    const child = img2img.outputs[0]!.id;
    const grandchild = (
      await library.importFinishedJob(
        finishedJob({ inputs: [{ position: 0, assetId: child, role: 'init', weight: 0.6 }] }),
      )
    ).outputs[0]!.id;

    const lineage = library.lineage(child)!;
    expect(lineage.nodes.map((node) => node.id)).toEqual([
      child,
      ...[crop.asset.id, grandchild].sort(),
      upload.asset.id,
    ]);
    expect(lineage.edges).toEqual(
      expect.arrayContaining([
        { parent: crop.asset.id, child, kind: 'job', jobId: img2img.job.id, role: 'init' },
        expect.objectContaining({ parent: child, child: grandchild, kind: 'job' }),
        { parent: upload.asset.id, child: crop.asset.id, kind: 'derived', jobId: null, role: null },
      ]),
    );
    expect(lineage.edges).toHaveLength(3);
    expect(lineage.truncated).toBe(false);

    expect(library.provenance(child)?.job?.inputs).toEqual([
      {
        position: 0,
        assetId: crop.asset.id,
        role: 'init',
        weight: null,
        region: null,
        crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
        sourceLibrary: null,
      },
    ]);
    expect(library.provenance(crop.asset.id)?.asset.derivedFrom?.assetId).toBe(upload.asset.id);
  });

  it('is undefined for an unknown asset', () => {
    expect(library.lineage('d'.repeat(64))).toBeUndefined();
    expect(library.provenance('d'.repeat(64))).toBeUndefined();
  });

  it('refuses a crop with no area', async () => {
    const { asset } = await library.ingestUpload(makePng(4, 4));
    await expect(
      library.deriveCrop(asset.id, { x: 0.5, y: 0, width: 0.6, height: 1 }),
    ).rejects.toThrow(/inside the image/);
  });
});

describe('copying between libraries (A22)', () => {
  it('copies the bytes, so the id is the same, as imported', async () => {
    const other = await registry.create('Second');
    const target = registry.library(other.id)!;
    const { asset } = await library.ingestUpload(makePng(6, 6, { seed: 4 }));
    library.rate(asset.id, 5);
    const copied = await target.copyAssetFrom(library, asset.id);
    expect(copied.created).toBe(true);
    expect(copied.asset).toMatchObject({
      id: asset.id,
      origin: 'imported',
      rating: null,
      pixelHash: asset.pixelHash,
      width: 6,
    });
    const read = await target.readAsset(asset.id);
    expect(read.kind === 'present' && sha256(read.bytes)).toBe(asset.id);
    expect((await target.copyAssetFrom(library, asset.id)).created).toBe(false);
  });

  it('refuses an asset the source does not have, or whose bytes are gone', async () => {
    const other = await registry.create('Second');
    const target = registry.library(other.id)!;
    await expect(target.copyAssetFrom(library, 'a'.repeat(64))).rejects.toThrow(
      AssetUnavailableError,
    );
    const { asset } = await library.ingestUpload(makePng(4, 4));
    await library.deleteAsset(asset.id);
    await expect(target.copyAssetFrom(library, asset.id)).rejects.toMatchObject({ why: 'gone' });
  });
});

describe('the startup sweep (A23)', () => {
  it('removes temp files, orphans, thumbnails of deleted assets and ingested spools', async () => {
    const kept = await library.ingestUpload(makePng(4, 4, { seed: 1 }));
    const job = await library.importFinishedJob(finishedJob());
    const orphan = 'ab'.repeat(32);
    const orphanPath = assetPath(paths, orphan, 'image/png');
    await mkdir(join(orphanPath, '..'), { recursive: true });
    await writeFile(orphanPath, 'left by a crash');
    const tempPath = join(orphanPath, '..', '.tmp-abc123');
    await writeFile(tempPath, 'partial');
    const strangerPath = join(orphanPath, '..', 'notes.txt');
    await writeFile(strangerPath, 'not ours');
    const orphanThumb = thumbnailPath(paths, orphan);
    await mkdir(join(orphanThumb, '..'), { recursive: true });
    await writeFile(orphanThumb, 'thumb');
    await mkdir(spoolPath(paths, job.job.id), { recursive: true });
    const pending = spoolPath(paths, newId('job'));
    await mkdir(pending, { recursive: true });

    expect(await library.sweep()).toEqual({
      tempFiles: 1,
      orphanAssets: 1,
      orphanThumbnails: 1,
      staleSpools: 1,
    });
    expect(existsSync(orphanPath)).toBe(false);
    expect(existsSync(tempPath)).toBe(false);
    expect(existsSync(strangerPath)).toBe(true);
    expect(existsSync(pending)).toBe(true);
    expect(existsSync(assetPath(paths, kept.asset.id, 'image/png'))).toBe(true);
    expect(existsSync(thumbnailPath(paths, kept.asset.id))).toBe(true);
  });

  it('runs when the library opens', async () => {
    const orphanPath = assetPath(paths, 'cd'.repeat(32), 'image/png');
    await mkdir(join(orphanPath, '..'), { recursive: true });
    await writeFile(orphanPath, 'left by a crash');
    registry.close();
    await openRegistry();
    expect(existsSync(orphanPath)).toBe(false);
  });
});

describe('usage', () => {
  it('counts present assets, the database and the thumbnails', async () => {
    const { asset } = await library.ingestUpload(makePng(64, 64, { seed: 1 }));
    const usage = await library.usage();
    expect(usage.assets_bytes).toBe(asset.bytes);
    expect(usage.database_bytes).toBeGreaterThan(0);
    expect(usage.cache_bytes).toBeGreaterThan(0);
    expect(usage.total_bytes).toBe(usage.assets_bytes + usage.database_bytes + usage.cache_bytes);
    await library.deleteAsset(asset.id);
    expect((await library.usage()).assets_bytes).toBe(0);
  });
});

describe('a read-only library', () => {
  it('reads but refuses every write', async () => {
    const { asset } = await library.ingestUpload(makePng(4, 4));
    const readOnly: Library = new LocalLibrary({
      id: library.id,
      db: (library as unknown as { db: never }).db,
      paths,
      writable: false,
      log: collectingLog(),
    });
    expect(readOnly.getAsset(asset.id)?.id).toBe(asset.id);
    await expect(readOnly.ingestUpload(makePng(4, 4, { seed: 3 }))).rejects.toThrow(
      LibraryReadOnlyError,
    );
    expect(() => readOnly.rate(asset.id, 1)).toThrow(LibraryReadOnlyError);
    await expect(readOnly.deleteAsset(asset.id)).rejects.toThrow(LibraryReadOnlyError);
    await expect(readOnly.importFinishedJob(finishedJob())).rejects.toThrow(LibraryReadOnlyError);
  });
});
