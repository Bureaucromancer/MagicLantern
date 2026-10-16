// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Contract tests for the sd.cpp adapter (SD8) against the pinned build's
 * fixtures: the descriptor its capabilities map to (SD1), the wire request
 * per mode (SD2), the job lifecycle (SD3), results and their metadata (SD4),
 * and identity and health (SD5). The lifecycle runs against a fake instance
 * at the root and under a path prefix (L1), replaying fixture answers.
 */

import {
  checkRouteDescriptor,
  type GenerationRequest,
  type RouteDescriptor,
} from '@bureaucromancer/lantern-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CancelRefused,
  HttpStatusError,
  isAssetPlaceholder,
  RejectedBeforeStart,
  type JobHandle,
} from '../shared/index.js';
import {
  describeCapabilities,
  extensionSchema,
  generatorOf,
  identityOf,
  parseCapabilities,
  parseSdcppSection,
  prepareImgGen,
  readImageMetadata,
  readSdcppSettings,
  SdcppAdapter,
  type DescribeOptions,
  type SdcppCapabilities,
} from './index.js';
import {
  FakeSdServer,
  pinnedCapabilities,
  pinnedExchanges,
  PINNED_BUILD,
  withModel,
  withPreviews,
} from './test-sdserver.js';

const INIT = 'a'.repeat(64);
const MASK = 'b'.repeat(64);
const REF_1 = 'c'.repeat(64);
const REF_2 = 'd'.repeat(64);

const NO_EXTRAS: DescribeOptions = { controlNet: false, ipAdapter: false, preview: null };

function pinned(): SdcppCapabilities {
  return parseCapabilities(pinnedCapabilities());
}

function describePinned(options: Partial<DescribeOptions> = {}): RouteDescriptor {
  return describeCapabilities('rt_sdxl', pinned(), { ...NO_EXTRAS, ...options });
}

describe('the capabilities document', () => {
  it('reads the pinned build: model, modes, defaults, LoRAs and limits', () => {
    const capabilities = pinned();
    expect(capabilities.model.stem).toBe('sd_xl_base_1.0');
    expect(capabilities.supportedModes).toEqual(['img_gen']);
    expect(capabilities.imgFeatures['cancel_generating']).toBe(false);
    expect(capabilities.loras.map((lora) => lora.path)).toEqual([
      'detail-tweaker-xl.safetensors',
      'style/film-grain.safetensors',
    ]);
    expect(capabilities.previewModes).toEqual([]);
    expect(capabilities.limits).toMatchObject({ maxBatchCount: 8, maxQueueSize: 64 });
  });

  it('falls back to the deprecated top-level mirrors only when the mode-aware fields are missing', () => {
    const document = pinnedCapabilities();
    delete document['features_by_mode'];
    delete document['defaults_by_mode'];
    delete document['supported_modes'];
    const capabilities = parseCapabilities(document);
    expect(capabilities.supportedModes).toEqual(['img_gen']);
    expect(capabilities.imgFeatures['init_image']).toBe(true);
    expect(capabilities.imgDefaults?.['batch_count']).toBe(1);
  });

  it('is the model file the instance reports, as its identity (L4)', () => {
    expect(identityOf(pinned())).toEqual({
      kind: 'file',
      path: expect.stringMatching(/sd_xl_base_1\.0\.safetensors$/),
      stem: 'sd_xl_base_1.0',
    });
  });

  it('refuses something that is not a capabilities document', () => {
    expect(() => parseCapabilities([])).toThrow(/not a JSON object/);
    expect(() => parseCapabilities({ samplers: [] })).toThrow(/name no model/);
  });
});

describe('describe (SD1)', () => {
  it('passes every descriptor rule, and matches its snapshot', () => {
    const descriptor = describePinned();
    expect(checkRouteDescriptor(descriptor)).toEqual([]);
    expect(descriptor).toMatchSnapshot();
  });

  it('serves txt2img, img2img, inpaint (A33) and edit from one img_gen route', () => {
    const descriptor = describePinned();
    expect(Object.keys(descriptor.modes)).toEqual(['txt2img', 'img2img', 'inpaint', 'edit']);
    expect(descriptor.modes.inpaint?.inputs).toMatchObject({
      init: { min: 1, max: 1 },
      mask: { min: 1, max: 1 },
    });
    expect(descriptor.modes.edit?.inputs?.ref).toMatchObject({ min: 1 });
  });

  it('drops a mode whose feature the build does not report', () => {
    const document = pinnedCapabilities();
    const features = (document['features_by_mode'] as Record<string, Record<string, boolean>>)[
      'img_gen'
    ]!;
    features['mask_image'] = false;
    features['ref_images'] = false;
    const descriptor = describeCapabilities('rt', parseCapabilities(document), NO_EXTRAS);
    expect(Object.keys(descriptor.modes)).toEqual(['txt2img', 'img2img']);
  });

  it('takes the server’s defaults, and none where the model decides', () => {
    const fields = describePinned().modes.txt2img!.fields;
    expect(fields['sampling.steps']).toMatchObject({ minimum: 1, maximum: 100, default: 20 });
    expect(fields['sampling.cfg']).toMatchObject({ default: 7 });
    expect(fields['sampling.distilled_guidance']).toMatchObject({ default: 3.5 });
    expect(fields['prompt.negative']).toMatchObject({ default: '' });
    // "default" sampler and scheduler, null eta and flow shift, clip skip -1: the model decides.
    for (const path of [
      'sampling.sampler',
      'sampling.scheduler',
      'sampling.eta',
      'sampling.flow_shift',
      'sampling.image_cfg',
      'sampling.clip_skip',
    ]) {
      expect(fields[path], path).not.toHaveProperty('default');
    }
    expect(fields['count']).toMatchObject({ native_max: 8, default: 1 });
    expect(fields['geometry.width']).toMatchObject({ minimum: 64, maximum: 4096, default: 512 });
  });

  it('offers the canonical vocabulary as it is, without the "normal" alias or "default"', () => {
    const fields = describePinned().modes.txt2img!.fields;
    expect(fields['sampling.sampler']?.enum).toContain('euler_a');
    expect(fields['sampling.sampler']?.enum).toHaveLength(21);
    expect(fields['sampling.scheduler']?.enum).toContain('discrete');
    expect(fields['sampling.scheduler']?.enum).not.toContain('normal');
  });

  it('offers a name the vocabulary lacks as native:<name>', () => {
    const document = pinnedCapabilities();
    (document['samplers'] as string[]).push('euler_new');
    const fields = describeCapabilities('rt', parseCapabilities(document), NO_EXTRAS).modes.txt2img!
      .fields;
    expect(fields['sampling.sampler']?.enum).toContain('native:euler_new');
  });

  it('lists LoRAs as options, by the path a request must name', () => {
    expect(describePinned().modes.txt2img?.adapters?.lora?.options).toEqual([
      { id: 'detail-tweaker-xl.safetensors', label: 'detail-tweaker-xl' },
      { id: 'style/film-grain.safetensors', label: 'film-grain' },
    ]);
  });

  it('says a queued job cancels and a running one does not, and progress is none on the pinned build', () => {
    expect(describePinned().modes.txt2img?.control).toEqual({
      cancel_queued: true,
      cancel_running: false,
      progress: 'none',
    });
  });

  it('reports steps where the build has previews and the adapter asks for one', () => {
    const later = parseCapabilities(withPreviews(pinnedCapabilities()));
    expect(
      describeCapabilities('rt', later, { ...NO_EXTRAS, preview: 'proj' }).modes.txt2img?.control
        .progress,
    ).toBe('steps');
    expect(describeCapabilities('rt', later, NO_EXTRAS).modes.txt2img?.control.progress).toBe(
      'none',
    );
  });

  it('follows cancel_generating where a build sets it', () => {
    const document = pinnedCapabilities();
    (document['features_by_mode'] as Record<string, Record<string, boolean>>)['img_gen']![
      'cancel_generating'
    ] = true;
    const descriptor = describeCapabilities('rt', parseCapabilities(document), NO_EXTRAS);
    expect(descriptor.modes.txt2img?.control.cancel_running).toBe(true);
  });

  it('offers control and IP-Adapter images only when the settings say the instance has them', () => {
    expect(describePinned().modes.txt2img?.inputs).toBeUndefined();
    const extras = describePinned({ controlNet: true, ipAdapter: true });
    expect(Object.keys(extras.modes.txt2img?.inputs ?? {})).toEqual(['control', 'ip_adapter']);
    expect(extras.modes.txt2img?.fields['inputs.control.weight']).toMatchObject({
      default: 0.8999999761581421,
    });
  });

  it('derives the extension schema from the defaults, VAE tiling written out (L7)', () => {
    const schema = extensionSchema(pinned(), 'plain');
    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties)).toEqual([
      'slg',
      'shifted_timestep',
      'vae_tiling_params',
      'cache_mode',
      'cache_option',
      'scm_mask',
      'scm_policy_dynamic',
      'image_preprocess',
    ]);
    const tiling = properties['vae_tiling_params']!['properties'] as Record<string, unknown>;
    // Lemonade starts Vulkan children with --vae-tiling: the default is on.
    expect(tiling['enabled']).toEqual({ type: 'boolean', default: true });
    expect(Object.keys(tiling)).not.toContain('temporal_tiling');
    expect(Object.keys(extensionSchema(pinned(), 'edit')['properties'] as object)).toContain(
      'ref_image_args',
    );
  });

  it('keys VAE tiling as the build does: x and y on the pinned build, w and h later', () => {
    const later = extensionSchema(parseCapabilities(withPreviews(pinnedCapabilities())), 'plain');
    const tiling = (later['properties'] as Record<string, Record<string, unknown>>)[
      'vae_tiling_params'
    ]!['properties'] as Record<string, unknown>;
    expect(Object.keys(tiling)).toContain('tile_size_w');
    expect(Object.keys(tiling)).not.toContain('tile_size_x');
  });

  it('leaves out a default that does not fit, rather than break the descriptor', () => {
    const document = pinnedCapabilities();
    const defaults = (document['defaults_by_mode'] as Record<string, Record<string, unknown>>)[
      'img_gen'
    ]!;
    (defaults['sample_params'] as Record<string, unknown>)['sample_steps'] = 250;
    defaults['batch_count'] = 12;
    const descriptor = describeCapabilities('rt', parseCapabilities(document), NO_EXTRAS);
    expect(checkRouteDescriptor(descriptor)).toEqual([]);
    expect(descriptor.modes.txt2img?.fields['sampling.steps']).not.toHaveProperty('default');
    expect(descriptor.modes.txt2img?.fields['count']).not.toHaveProperty('default');
  });

  it('describes no mode for an instance that serves no images', () => {
    const document = pinnedCapabilities();
    document['supported_modes'] = ['vid_gen'];
    delete document['defaults_by_mode'];
    document['current_mode'] = 'vid_gen';
    expect(describeCapabilities('rt', parseCapabilities(document), NO_EXTRAS).modes).toEqual({});
  });
});

/** An effective request, as the resolver would leave it for this route. */
function effective(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    schema_version: 1,
    mode: 'txt2img',
    prompt: { positive: 'a lighthouse at dusk', negative: '' },
    geometry: { width: 1024, height: 1024 },
    sampling: { seed: 1234, steps: 30, cfg: 6.5, distilled_guidance: 3.5, sampler: 'euler_a' },
    count: 1,
    extensions: {
      sdcpp: {
        slg: { layers: [7, 8, 9], layer_start: 0.01, layer_end: 0.2, scale: 0 },
        shifted_timestep: 0,
        vae_tiling_params: { enabled: true, tile_size_x: 0, tile_size_y: 0, target_overlap: 0.5 },
        cache_mode: '',
        image_preprocess: '',
      },
    },
    ...overrides,
  };
}

describe('prepare (SD2)', () => {
  const plain = { preview: null };

  it('maps txt2img, writing out what the server would otherwise assume (L7)', () => {
    const wire = prepareImgGen(effective(), plain);
    expect(wire).toMatchSnapshot();
    expect(wire).toMatchObject({
      negative_prompt: '',
      clip_skip: -1,
      lora: [],
      hires: { enabled: false },
      vae_tiling_params: { enabled: true },
      embed_image_metadata: true,
      output_format: 'png',
    });
    expect(wire).not.toHaveProperty('strength');
    expect(wire).not.toHaveProperty('init_image');
  });

  it('maps img2img: the init image as a placeholder, denoise as strength', () => {
    const wire = prepareImgGen(
      effective({
        mode: 'img2img',
        inputs: [{ role: 'init', asset_id: INIT }],
        sampling: { seed: 7, steps: 20, sampler: 'euler', denoise: 0.6 },
      }),
      plain,
    );
    expect(wire).toMatchSnapshot();
    expect(wire['init_image']).toEqual({ $asset: INIT });
    expect(wire['strength']).toBe(0.6);
  });

  it('maps inpaint with an uploaded mask (A33)', () => {
    const wire = prepareImgGen(
      effective({
        mode: 'inpaint',
        inputs: [
          { role: 'init', asset_id: INIT },
          { role: 'mask', asset_id: MASK },
        ],
        sampling: { seed: 7, steps: 20, denoise: 0.9 },
      }),
      plain,
    );
    expect(wire).toMatchSnapshot();
    expect(wire['mask_image']).toEqual({ $asset: MASK });
  });

  it('maps edit: reference images in order', () => {
    const wire = prepareImgGen(
      effective({
        mode: 'edit',
        inputs: [
          { role: 'ref', asset_id: REF_1 },
          { role: 'ref', asset_id: REF_2 },
        ],
      }),
      plain,
    );
    expect(wire['ref_images']).toEqual([{ $asset: REF_1 }, { $asset: REF_2 }]);
  });

  it('maps LoRAs by path, the hires pass, a native sampler and a batch', () => {
    const wire = prepareImgGen(
      effective({
        count: 4,
        sampling: {
          seed: 9,
          steps: 20,
          sampler: 'native:euler_new',
          scheduler: 'karras',
          clip_skip: 2,
        },
        adapters: [{ kind: 'lora', id: 'style/film-grain.safetensors', weight: 0.6 }],
        passes: [{ kind: 'hires', scale: 1.5, denoise: 0.5, upscaler: 'Lanczos' }],
      }),
      plain,
    );
    expect(wire).toMatchSnapshot();
    expect(wire['lora']).toEqual([
      { path: 'style/film-grain.safetensors', multiplier: 0.6, is_high_noise: false },
    ]);
    expect(wire['hires']).toEqual({
      enabled: true,
      upscaler: 'Lanczos',
      scale: 1.5,
      target_width: 0,
      target_height: 0,
      steps: 0,
      denoising_strength: 0.5,
    });
    expect(wire['batch_count']).toBe(4);
    expect(wire['clip_skip']).toBe(2);
    expect((wire['sample_params'] as Record<string, unknown>)['sample_method']).toBe('euler_new');
  });

  it('asks for a preview only when told to', () => {
    expect(prepareImgGen(effective(), { preview: 'proj' })).toMatchObject({
      preview: 'proj',
      preview_interval: 1,
    });
    expect(prepareImgGen(effective(), plain)).not.toHaveProperty('preview');
  });

  it('refuses a request that is not effective', () => {
    expect(() => prepareImgGen(effective({ sampling: { seed: 'random' } }), plain)).toThrow(
      /concrete seeds/,
    );
    const sizeless = effective();
    delete sizeless.geometry;
    expect(() => prepareImgGen(sizeless, plain)).toThrow(/no geometry/);
  });

  it('is pure: the same request gives the same body', () => {
    expect(prepareImgGen(effective(), plain)).toEqual(prepareImgGen(effective(), plain));
  });
});

describe('results (SD4)', () => {
  const exchanges = pinnedExchanges();

  it('finds the SDCPP section after a prompt that mentions it', () => {
    expect(parseSdcppSection('a cat, SDCPP: no\nSteps: 20, SDCPP: {"seed": 5}')).toEqual({
      seed: 5,
    });
    expect(parseSdcppSection('no metadata here')).toBeNull();
  });

  it('reads each image’s seed and the generator from its parameters chunk', () => {
    const body = exchanges['job_completed']!.response.body as {
      result: { images: { b64_json: string }[] };
    };
    const bytes = Buffer.from(body.result.images[1]!.b64_json, 'base64');
    const { sdcpp } = readImageMetadata(bytes);
    expect(sdcpp?.['seed']).toBe(1235);
    expect(generatorOf(sdcpp)).toBe(`stable-diffusion.cpp ${PINNED_BUILD}`);
  });

  it('names the commit when the version does not', () => {
    expect(generatorOf({ generator: { version: 'v1.2', commit: 'abc1234' } })).toBe(
      'stable-diffusion.cpp v1.2 (commit abc1234)',
    );
    expect(generatorOf(null)).toBeUndefined();
  });
});

describe('the settings', () => {
  it('apply defaults, and refuse what the kind does not take', () => {
    expect(readSdcppSettings({})).toMatchObject({ preview: 'auto', controlNet: false });
    expect(() => readSdcppSettings({ preview: 'fast' })).toThrow(/preview must be one of/);
    expect(() => readSdcppSettings({ controlnet: true })).toThrow(/Unknown sd.cpp setting/);
    expect(() => readSdcppSettings({ timeoutMs: 5 })).toThrow(/timeoutMs/);
  });
});

describe.each([
  ['at the root', ''],
  ['under a path prefix (L1)', '/orchd/v1/models/sdxl/native'],
])('the job lifecycle %s (SD3, SD5)', (_where, prefix) => {
  let server: FakeSdServer;
  let adapter: SdcppAdapter;
  const exchanges = pinnedExchanges();
  const signal = new AbortController().signal;

  beforeEach(async () => {
    server = await FakeSdServer.start({ prefix });
    adapter = new SdcppAdapter();
    await adapter.init({ backendId: 'be_test', baseUrl: server.url, settings: {} });
  });

  afterEach(async () => {
    await server.close();
  });

  /** Replays a fixture exchange for the next matching request. */
  function replay(name: string): void {
    const exchange = exchanges[name];
    if (exchange === undefined) throw new Error(`no exchange ${name}`);
    server.scripted.push(exchange);
  }

  async function submitted(): Promise<JobHandle> {
    replay('submit_accepted');
    return await adapter.submit(
      'rt',
      prepareImgGen(effective({ count: 2 }), { preview: null }),
      signal,
    );
  }

  it('is healthy and loaded while the instance answers GET /, and down once it is gone', async () => {
    expect(await adapter.health()).toEqual({ status: 'ok', load_state: 'loaded' });
    expect(server.received.at(-1)?.path).toBe(`${prefix}/`);
    await server.close();
    expect(await adapter.health()).toMatchObject({ status: 'down' });
  });

  it('identifies the model from the capabilities, and notices another on the same port (A26)', async () => {
    expect(await adapter.identify('rt')).toMatchObject({ kind: 'file', stem: 'sd_xl_base_1.0' });
    server.capabilities = withModel(pinnedCapabilities(), '/models/flux-2-klein-4b.safetensors');
    expect(await adapter.identify('rt')).toMatchObject({ stem: 'flux-2-klein-4b' });
  });

  it('describes one route from the instance’s own capabilities', async () => {
    const [descriptor] = await adapter.describe();
    expect(descriptor?.modes.txt2img?.control.progress).toBe('none');
  });

  it('submits, and keeps the job id, seed and the instance it went to in the handle', async () => {
    const handle = await submitted();
    expect(handle).toEqual({
      resumable: true,
      instance: {
        base_url: server.url,
        model: expect.objectContaining({ stem: 'sd_xl_base_1.0' }),
      },
      data: { id: 'job_68ef1a2b_00000001', seed: 1234, batch_count: 2 },
    });
    const body = server.submitted[0]!;
    expect(body['seed']).toBe(1234);
    expect(body['vae_tiling_params']).toMatchObject({ enabled: true });
  });

  it('maps every state of a job, and spools nothing: the results arrive with the final status', async () => {
    const handle = await submitted();
    replay('job_queued');
    expect(await adapter.status(handle)).toEqual({
      state: 'queued',
      waiting: { reason: 'engine_queue', detail: expect.any(String), queue_position: 2 },
    });
    replay('job_generating');
    expect(await adapter.status(handle)).toEqual({ state: 'running' });
    replay('job_completed');
    const done = await adapter.status(handle);
    expect(done.state).toBe('done');
    expect(done.result?.outputs.map((output) => [output.index, output.seed])).toEqual([
      [0, 1234],
      [1, 1235],
    ]);
    expect(done.result?.generator).toBe(`stable-diffusion.cpp ${PINNED_BUILD}`);
    expect(done.result?.metadata).toMatchObject({
      job: { id: 'job_68ef1a2b_00000001', status: 'completed' },
      output_format: 'png',
      images: [
        { index: 0, seed: 1234, sdcpp: { seed: 1234 } },
        { index: 1, seed: 1235 },
      ],
    });
    // backend_response never holds image bytes.
    expect(JSON.stringify(done.result?.metadata)).not.toContain('b64_json');
    replay('job_failed');
    expect(await adapter.status(handle)).toEqual({
      state: 'failed',
      started: true,
      reason: 'generate_image returned no results',
    });
    replay('job_cancelled');
    expect(await adapter.status(handle)).toEqual({ state: 'cancelled' });
  });

  it('reports a purged (410) or unknown (404) job as lost', async () => {
    const handle = await submitted();
    replay('job_expired');
    expect(await adapter.status(handle)).toMatchObject({
      state: 'lost',
      reason: expect.stringMatching(/410/),
    });
    replay('job_not_found');
    expect(await adapter.status(handle)).toMatchObject({
      state: 'lost',
      reason: expect.stringMatching(/404/),
    });
  });

  it('turns a full queue (429) into a rejection before start (L5)', async () => {
    replay('submit_queue_full');
    await expect(
      adapter.submit('rt', prepareImgGen(effective(), { preview: null }), signal),
    ).rejects.toBeInstanceOf(RejectedBeforeStart);
  });

  it('fails a submit the server refuses (400), naming what it said', async () => {
    replay('submit_invalid');
    const attempt = adapter.submit('rt', prepareImgGen(effective(), { preview: null }), signal);
    await expect(attempt).rejects.toBeInstanceOf(HttpStatusError);
    await expect(attempt).rejects.toThrow(/invalid generation parameters/);
  });

  it('cancels a queued job, refuses a running one (409), and lets a gone one be', async () => {
    const handle = await submitted();
    replay('cancel_queued');
    await expect(adapter.cancel(handle)).resolves.toBeUndefined();
    replay('cancel_generating');
    await expect(adapter.cancel(handle)).rejects.toBeInstanceOf(CancelRefused);
    // The fake never had the fixture's job, so it answers 404: nothing to cancel.
    await expect(adapter.cancel(handle)).resolves.toBeUndefined();
  });

  it('runs a job end to end on the fake instance, with step progress where previews exist', async () => {
    server.capabilities = withPreviews(pinnedCapabilities());
    server.hold = true;
    await adapter.describe();
    const wire = await adapter.prepare('rt', effective({ count: 2 }));
    expect(wire).toMatchObject({ preview: 'proj' });
    const handle = await adapter.submit('rt', fillAssets(wire), signal);
    const running = await adapter.status(handle);
    expect(running).toMatchObject({
      state: 'running',
      progress: {
        step: 7,
        total_steps: 30,
        preview: expect.stringMatching(/^data:image\/png;base64,/),
      },
    });
    server.release();
    const done = await adapter.status(handle);
    expect(done.result?.outputs.map((output) => output.seed)).toEqual([1234, 1235]);
    await expect(adapter.fetchResult(handle)).resolves.toMatchObject({
      outputs: [{ index: 0 }, { index: 1 }],
    });
  });

  it('loses every job when the instance restarts', async () => {
    const wire = await adapter.prepare('rt', effective());
    server.hold = true;
    const handle = await adapter.submit('rt', fillAssets(wire), signal);
    await server.restart();
    expect(await adapter.status(handle)).toMatchObject({ state: 'lost' });
  });
});

/** A wire request with no placeholders left, as the engine fills it. */
function fillAssets(wire: unknown): unknown {
  return JSON.parse(JSON.stringify(wire), (_key, value: unknown) =>
    isAssetPlaceholder(value) ? 'AAAA' : value,
  ) as unknown;
}

describe('a capabilities document a manager supplies (L3)', () => {
  it('is read instead of the instance, which is never asked', async () => {
    const adapter = new SdcppAdapter({
      capabilities: () => Promise.resolve(pinnedCapabilities()),
      fetch: () => Promise.reject(new Error('the native URL must not be touched')),
    });
    await adapter.init({
      backendId: 'be',
      baseUrl: 'http://orchd:11434/orchd/v1/models/x/native',
      settings: {},
    });
    expect(await adapter.identify('rt')).toMatchObject({ stem: 'sd_xl_base_1.0' });
    expect((await adapter.describe())[0]?.modes.txt2img).toBeDefined();
  });
});
