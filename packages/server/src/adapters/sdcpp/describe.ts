// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The descriptor for an sd-server route (SD1): a pure function of the
 * capabilities document and the backend's settings, so a manager can supply
 * the document instead of the instance (L3) and the result is cacheable.
 *
 * - **Modes.** `img_gen` is every image mode; the canonical mode decides
 *   which inputs are sent. txt2img always; img2img with `init_image`;
 *   inpaint with `init_image` and `mask_image` (A33); edit with
 *   `ref_images`. Video waits for 0.9, upscale for 0.3.
 * - **Defaults** are the server's own (`defaults_by_mode.img_gen`, from its
 *   command line), so `effective` and `wire` write them out (L7) and a
 *   request reproduces on an instance started with other flags. A default
 *   the model decides (`null`, `"default"`) is no default here.
 * - **Vocabulary.** Lantern's sampler and scheduler names are sd.cpp's, so
 *   the mapping is the identity; a name the vocabulary lacks is offered as
 *   `native:<name>`. `normal` is sd.cpp's alias for `discrete` and is not
 *   offered twice. Enums are strict because sd-server quietly keeps its
 *   default for a name it does not know.
 * - **Limits.** `capabilities.limits` is hard-coded and advisory, apart from
 *   what the server enforces in code: steps are clamped to 100 and batches
 *   to 8, so those are the maxima. Profile constraints narrow the rest.
 * - **What the capabilities cannot say.** sd-server lists `control_image`
 *   and `ip_adapter_image` whether or not it was started with a ControlNet
 *   or an IP-Adapter, and ignores them without one, so those inputs are
 *   offered only when the backend's settings say the instance has them (rule
 *   4: no silent drops). `ref_images` has the same gap; the model's profile
 *   removes edit from families that cannot use it.
 * - **Control.** Queued jobs cancel when `cancel_queued` says so; running
 *   ones only when `cancel_generating` does (SP1 settles which builds say
 *   what). Progress is in steps where the build has native previews and the
 *   adapter asks for one, else none: an elapsed timer.
 */

import {
  checkRouteDescriptor,
  isCanonicalSampler,
  isCanonicalScheduler,
  NATIVE_PREFIX,
  type CollectionCapability,
  type FieldCapability,
  type ModeDescriptor,
  type RouteDescriptor,
} from '@bureaucromancer/lantern-schema';

import { defaultAt, servesImages, type SdcppCapabilities } from './capabilities.js';

/** sd.cpp clamps `sample_steps` to this in the server (strict mode). */
export const SDCPP_MAX_STEPS = 100;

/** The backend kind, and the key of its `extensions` block. */
export const SDCPP_KIND = 'sdcpp';

export interface DescribeOptions {
  /** The instance was started with a ControlNet (`--control-net`). */
  readonly controlNet: boolean;
  /** The instance was started with an IP-Adapter. */
  readonly ipAdapter: boolean;
  /** The preview mode the adapter asks for, or null for none. */
  readonly preview: string | null;
}

/** Lantern's name for a backend sampler or scheduler: itself, or `native:<name>`. */
export function canonicalName(name: string, isCanonical: (name: string) => boolean): string {
  return isCanonical(name) ? name : `${NATIVE_PREFIX}${name}`;
}

/** The backend's name for one of Lantern's: `native:` removed. */
export function nativeName(name: string): string {
  return name.startsWith(NATIVE_PREFIX) ? name.slice(NATIVE_PREFIX.length) : name;
}

/** Names the server answers with when nothing is set: the model decides. */
const UNSET_NAMES: ReadonlySet<string> = new Set(['default', 'NONE', '']);

function samplerNames(capabilities: SdcppCapabilities): string[] {
  return [...new Set(capabilities.samplers.filter((name) => !UNSET_NAMES.has(name)))].map((name) =>
    canonicalName(name, isCanonicalSampler),
  );
}

function schedulerNames(capabilities: SdcppCapabilities): string[] {
  return [
    ...new Set(
      capabilities.schedulers.filter((name) => !UNSET_NAMES.has(name) && name !== 'normal'),
    ),
  ].map((name) => canonicalName(name, isCanonicalScheduler));
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value);

/**
 * An entry with a default, when the default is of the field's type and meets
 * the entry's own narrowing; without one otherwise, so a server started with
 * an odd flag never makes the whole descriptor invalid.
 */
function withDefault(
  entry: FieldCapability,
  value: unknown,
  ofType: (value: unknown) => boolean,
): FieldCapability {
  if (value === undefined || !ofType(value)) return entry;
  if (entry.enum !== undefined && !entry.enum.includes(value as never)) return entry;
  if (typeof value === 'number') {
    if (entry.minimum !== undefined && value < entry.minimum) return entry;
    if (entry.maximum !== undefined && value > entry.maximum) return entry;
    if (entry.exclusiveMinimum !== undefined && value <= entry.exclusiveMinimum) return entry;
    if (entry.exclusiveMaximum !== undefined && value >= entry.exclusiveMaximum) return entry;
  }
  return { ...entry, default: value };
}

const native = (extra: Partial<FieldCapability> = {}): FieldCapability => ({
  state: 'native',
  ...extra,
});

function sampleFields(capabilities: SdcppCapabilities): ModeDescriptor['fields'] {
  const d = (path: string): unknown => defaultAt(capabilities, path);
  const samplers = samplerNames(capabilities);
  const schedulers = schedulerNames(capabilities);
  const method = d('sample_params.sample_method');
  const scheduler = d('sample_params.scheduler');
  const clipSkip = d('clip_skip');
  return {
    'prompt.positive': native(),
    'prompt.negative': withDefault(native(), d('negative_prompt'), (v) => typeof v === 'string'),
    'prompt.dialect_hint': {
      state: 'ignored',
      reason: "A hint for Lantern's advice about the prompt; nothing is sent to the backend.",
    },
    'sampling.seed': native(),
    'sampling.steps': withDefault(
      native({ minimum: 1, maximum: SDCPP_MAX_STEPS }),
      d('sample_params.sample_steps'),
      isInteger,
    ),
    'sampling.cfg': withDefault(native(), d('sample_params.guidance.txt_cfg'), isNumber),
    'sampling.distilled_guidance': withDefault(
      native(),
      d('sample_params.guidance.distilled_guidance'),
      isNumber,
    ),
    'sampling.image_cfg': withDefault(native(), d('sample_params.guidance.img_cfg'), isNumber),
    'sampling.clip_skip': withDefault(native(), clipSkip, (v) => isInteger(v) && v >= 1),
    'sampling.sampler': withDefault(
      native(samplers.length > 0 ? { enum: samplers } : {}),
      typeof method === 'string' && !UNSET_NAMES.has(method)
        ? canonicalName(method, isCanonicalSampler)
        : undefined,
      (v) => typeof v === 'string',
    ),
    'sampling.scheduler': withDefault(
      native(schedulers.length > 0 ? { enum: schedulers } : {}),
      typeof scheduler === 'string' && !UNSET_NAMES.has(scheduler)
        ? canonicalName(scheduler === 'normal' ? 'discrete' : scheduler, isCanonicalScheduler)
        : undefined,
      (v) => typeof v === 'string',
    ),
    'sampling.eta': withDefault(native(), d('sample_params.eta'), (v) => isNumber(v) && v >= 0),
    'sampling.flow_shift': withDefault(native(), d('sample_params.flow_shift'), isNumber),
    count: withDefault(
      native({ native_max: capabilities.limits.maxBatchCount }),
      d('batch_count'),
      (v) => isInteger(v) && v >= 1 && v <= capabilities.limits.maxBatchCount,
    ),
  };
}

function geometryFields(capabilities: SdcppCapabilities): ModeDescriptor['fields'] {
  const { limits } = capabilities;
  return {
    'geometry.width': withDefault(
      native({ minimum: limits.minWidth, maximum: limits.maxWidth }),
      defaultAt(capabilities, 'width'),
      isInteger,
    ),
    'geometry.height': withDefault(
      native({ minimum: limits.minHeight, maximum: limits.maxHeight }),
      defaultAt(capabilities, 'height'),
      isInteger,
    ),
  };
}

const CROP_REASON = 'Lantern crops the image before sending it.';

/** An image input of one role: listed, with its crop emulated. */
function imageInput(
  role: string,
  limits: { min?: number; max?: number },
  extra: ModeDescriptor['fields'] = {},
): { fields: ModeDescriptor['fields']; entry: CollectionCapability } {
  return {
    fields: {
      [`inputs.${role}.asset_id`]: native(),
      [`inputs.${role}.crop`]: { state: 'emulated', reason: CROP_REASON },
      ...extra,
    },
    entry: { state: 'native', ...limits, media: ['image/*'] },
  };
}

/** The hires pass, where the server has it. */
function hiresPass(capabilities: SdcppCapabilities): Pick<ModeDescriptor, 'fields' | 'passes'> {
  const d = (path: string): unknown => defaultAt(capabilities, path);
  const upscalers = capabilities.upscalers.filter((name) => name !== 'None');
  return {
    fields: {
      'passes.hires.scale': withDefault(
        native({ exclusiveMinimum: 0 }),
        d('hires.scale'),
        isNumber,
      ),
      'passes.hires.target.width': native({ maximum: capabilities.limits.maxWidth }),
      'passes.hires.target.height': native({ maximum: capabilities.limits.maxHeight }),
      'passes.hires.steps': withDefault(
        native({ maximum: SDCPP_MAX_STEPS }),
        d('hires.steps'),
        (v) => isInteger(v) && v >= 1,
      ),
      'passes.hires.denoise': withDefault(
        native({ exclusiveMinimum: 0, maximum: 1 }),
        d('hires.denoising_strength'),
        isNumber,
      ),
      'passes.hires.upscaler': withDefault(
        native(upscalers.length > 0 ? { enum: upscalers } : {}),
        d('hires.upscaler'),
        (v) => typeof v === 'string' && v !== 'None',
      ),
    },
    passes: { hires: { state: 'native', max: 1 } },
  };
}

type JsonSchema = Record<string, unknown>;

/** A property schema with the server's default, when the default has the property's type. */
function property(
  schema: JsonSchema,
  value: unknown,
  ofType: (value: unknown) => boolean,
): JsonSchema {
  return value !== undefined && ofType(value) ? { ...schema, default: value } : schema;
}

const STRING_OR_LIST = (value: unknown): boolean =>
  typeof value === 'string' ||
  (Array.isArray(value) && value.every((item) => typeof item === 'string'));

/** The VAE tiling keys sd-server takes, by type; a build names sizes x/y, a later one w/h. */
const TILING_TYPES: Readonly<Record<string, 'boolean' | 'integer' | 'number' | 'string'>> = {
  enabled: 'boolean',
  tile_size_x: 'integer',
  tile_size_y: 'integer',
  tile_size_w: 'integer',
  tile_size_h: 'integer',
  target_overlap: 'number',
  rel_size_x: 'number',
  rel_size_y: 'number',
  rel_size_w: 'number',
  rel_size_h: 'number',
  extra_tiling_args: 'string',
};

function typed(kind: 'boolean' | 'integer' | 'number' | 'string'): {
  schema: JsonSchema;
  check: (value: unknown) => boolean;
} {
  switch (kind) {
    case 'boolean':
      return { schema: { type: 'boolean' }, check: (v) => typeof v === 'boolean' };
    case 'integer':
      return { schema: { type: 'integer', minimum: 0 }, check: (v) => isInteger(v) && v >= 0 };
    case 'number':
      return { schema: { type: 'number', minimum: 0 }, check: (v) => isNumber(v) && v >= 0 };
    case 'string':
      return { schema: { type: 'string' }, check: (v) => typeof v === 'string' };
  }
}

/**
 * `extensions.sdcpp`: the server's long tail, derived from its defaults so
 * every key is one this build reads, and every default is written out (L7).
 * Keys the server does not report are left out rather than guessed.
 */
export function extensionSchema(
  capabilities: SdcppCapabilities,
  mode: 'plain' | 'edit',
): JsonSchema {
  const d = (path: string): unknown => defaultAt(capabilities, path);
  const properties: Record<string, JsonSchema> = {};

  const slgDefaults = d('sample_params.guidance.slg');
  if (typeof slgDefaults === 'object' && slgDefaults !== null) {
    properties['slg'] = {
      type: 'object',
      additionalProperties: false,
      description: 'Skip-layer guidance (SD3.5, Wan).',
      properties: {
        layers: property(
          { type: 'array', items: { type: 'integer', minimum: 0 } },
          d('sample_params.guidance.slg.layers'),
          (v) => Array.isArray(v) && v.every((item) => isInteger(item) && item >= 0),
        ),
        layer_start: property(
          { type: 'number', minimum: 0, maximum: 1 },
          d('sample_params.guidance.slg.layer_start'),
          (v) => isNumber(v) && v >= 0 && v <= 1,
        ),
        layer_end: property(
          { type: 'number', minimum: 0, maximum: 1 },
          d('sample_params.guidance.slg.layer_end'),
          (v) => isNumber(v) && v >= 0 && v <= 1,
        ),
        scale: property(
          { type: 'number', minimum: 0 },
          d('sample_params.guidance.slg.scale'),
          (v) => isNumber(v) && v >= 0,
        ),
      },
    };
  }
  if (d('sample_params.shifted_timestep') !== undefined) {
    properties['shifted_timestep'] = property(
      { type: 'integer', minimum: 0, maximum: 1000, description: 'Timestep shift (NitroFusion).' },
      d('sample_params.shifted_timestep'),
      (v) => isInteger(v) && v >= 0 && v <= 1000,
    );
  }

  const tiling = d('vae_tiling_params');
  if (typeof tiling === 'object' && tiling !== null) {
    const tilingProperties: Record<string, JsonSchema> = {};
    for (const [key, value] of Object.entries(tiling)) {
      const kind = TILING_TYPES[key];
      if (kind === undefined) continue;
      const { schema, check } = typed(kind);
      tilingProperties[key] = property(schema, value === null ? undefined : value, check);
    }
    properties['vae_tiling_params'] = {
      type: 'object',
      additionalProperties: false,
      description: 'VAE tiling: saves memory, and can change pixels (L7).',
      properties: tilingProperties,
    };
  }

  for (const [key, kind] of [
    ['cache_mode', 'string'],
    ['cache_option', 'string'],
    ['scm_mask', 'string'],
    ['scm_policy_dynamic', 'boolean'],
  ] as const) {
    const value = d(key);
    if (value === undefined) continue;
    const { schema, check } = typed(kind);
    properties[key] = property(schema, value, check);
  }
  if (d('image_preprocess') !== undefined) {
    properties['image_preprocess'] = property(
      {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'Input geometry rules applied once to every input image.',
      },
      d('image_preprocess'),
      STRING_OR_LIST,
    );
  }
  if (mode === 'edit') {
    if (d('ref_image_args') !== undefined) {
      properties['ref_image_args'] = property(
        { type: 'string' },
        d('ref_image_args'),
        (v) => typeof v === 'string',
      );
    }
    if (d('increase_ref_index') !== undefined) {
      properties['increase_ref_index'] = property(
        { type: 'boolean' },
        d('increase_ref_index'),
        (v) => typeof v === 'boolean',
      );
    }
  }
  return { type: 'object', additionalProperties: false, properties };
}

/**
 * The route's descriptor.
 *
 * @param route the route id to name in it
 * @param capabilities the instance's capabilities
 * @param options what the capabilities cannot say
 * @throws Error when the result breaks a descriptor rule (a mapping bug)
 */
export function describeCapabilities(
  route: string,
  capabilities: SdcppCapabilities,
  options: DescribeOptions,
): RouteDescriptor {
  const descriptor: RouteDescriptor = { route, modes: {} };
  if (!servesImages(capabilities)) return descriptor;
  const features = capabilities.imgFeatures;
  const d = (path: string): unknown => defaultAt(capabilities, path);

  const control: ModeDescriptor['control'] = {
    cancel_queued: features['cancel_queued'] !== false,
    cancel_running: features['cancel_generating'] === true,
    progress: options.preview !== null && features['preview'] === true ? 'steps' : 'none',
  };

  // Inputs every mode may add: a ControlNet image and an IP-Adapter image.
  const extraInputs: Pick<ModeDescriptor, 'fields' | 'inputs'> = { fields: {}, inputs: {} };
  if (options.controlNet && features['control_image'] === true) {
    const control = imageInput(
      'control',
      { max: 1 },
      {
        'inputs.control.weight': withDefault(
          native({ minimum: 0 }),
          d('control_strength'),
          isNumber,
        ),
      },
    );
    Object.assign(extraInputs.fields, control.fields);
    extraInputs.inputs = { ...extraInputs.inputs, control: control.entry };
  }
  if (options.ipAdapter && features['ip_adapter_image'] === true) {
    const ipAdapter = imageInput(
      'ip_adapter',
      { max: 1 },
      {
        'inputs.ip_adapter.weight': withDefault(
          native({ minimum: 0 }),
          d('ip_adapter_strength'),
          isNumber,
        ),
      },
    );
    Object.assign(extraInputs.fields, ipAdapter.fields);
    extraInputs.inputs = { ...extraInputs.inputs, ip_adapter: ipAdapter.entry };
  }

  const lora =
    features['lora'] === true && capabilities.loras.length > 0
      ? {
          fields: { 'adapters.lora.id': native(), 'adapters.lora.weight': native() },
          adapters: {
            lora: {
              state: 'native' as const,
              options: capabilities.loras.map((entry) => ({
                id: entry.path,
                ...(entry.name === '' || entry.name === entry.path ? {} : { label: entry.name }),
              })),
            },
          },
        }
      : { fields: {}, adapters: undefined };
  const hires =
    features['hires'] === true ? hiresPass(capabilities) : { fields: {}, passes: undefined };

  const mode = (
    fields: ModeDescriptor['fields'],
    inputs: ModeDescriptor['inputs'],
    extension: 'plain' | 'edit',
  ): ModeDescriptor => ({
    fields: {
      ...sampleFields(capabilities),
      ...geometryFields(capabilities),
      ...fields,
      ...lora.fields,
      ...hires.fields,
    },
    ...(inputs === undefined || Object.keys(inputs).length === 0 ? {} : { inputs }),
    ...(lora.adapters === undefined ? {} : { adapters: lora.adapters }),
    ...(hires.passes === undefined ? {} : { passes: hires.passes }),
    extensions: { [SDCPP_KIND]: extensionSchema(capabilities, extension) },
    control,
  });

  descriptor.modes.txt2img = mode(extraInputs.fields, extraInputs.inputs, 'plain');

  if (features['init_image'] === true) {
    const init = imageInput('init', { min: 1, max: 1 });
    const denoise = {
      'sampling.denoise': withDefault(
        native(),
        d('strength'),
        (v) => isNumber(v) && v >= 0 && v <= 1,
      ),
    };
    descriptor.modes.img2img = mode(
      { ...init.fields, ...denoise, ...extraInputs.fields },
      { init: init.entry, ...extraInputs.inputs },
      'plain',
    );
    if (features['mask_image'] === true) {
      const mask = imageInput('mask', { min: 1, max: 1 });
      descriptor.modes.inpaint = mode(
        { ...init.fields, ...mask.fields, ...denoise, ...extraInputs.fields },
        { init: init.entry, mask: mask.entry, ...extraInputs.inputs },
        'plain',
      );
    }
  }

  if (features['ref_images'] === true) {
    const ref = imageInput(
      'ref',
      { min: 1 },
      {
        'inputs.ref.weight': {
          state: 'ignored',
          reason: 'sd-server takes no weight per reference image.',
        },
      },
    );
    descriptor.modes.edit = mode({ ...ref.fields }, { ref: ref.entry }, 'edit');
  }

  const issues = checkRouteDescriptor(descriptor);
  if (issues.length > 0) {
    throw new Error(
      `The sd-server descriptor breaks a rule: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
    );
  }
  return descriptor;
}
