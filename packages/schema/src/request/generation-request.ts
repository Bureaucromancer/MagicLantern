// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The canonical request (design doc, "Canonical request"; plan, "Request
 * rules"): one rich schema every client speaks, whatever the backend.
 *
 * Three things hold throughout, so the server's non-rewriting Ajv (rule 5)
 * refuses rather than repairs:
 * - every object is closed (`additionalProperties: false`), except the
 *   contents of `extensions`, which belong to the backend kind that names them;
 * - no `default` keyword anywhere: defaults belong to the resolver;
 * - no `$id`s, so nothing here changes the OpenAPI spec until a route uses it.
 *
 * The schema checks shape and per-value bounds. The rules a schema can't state
 * well, chiefly what each mode requires, live in
 * {@link checkGenerationRequest} (`check.ts`), because Ajv's errors on a union
 * can't name the offending field and the promised 422 must (A4). A request is
 * valid when it passes both; the `Static<>` types describe a request that has.
 */

import { type Static, Type } from '@sinclair/typebox';

// ---------------------------------------------------------------------------
// Versions and identifiers
// ---------------------------------------------------------------------------

/**
 * The version every request written by this package carries. Stored requests
 * keep the version they were written with; upgrade functions bring older ones
 * forward when they are read (plan, "Provenance"), so the schema only ever
 * validates the current version.
 */
export const GENERATION_REQUEST_SCHEMA_VERSION = 1;

/** An asset id: the SHA-256 of its bytes, as 64 lowercase hex digits. */
export const ASSET_ID_PATTERN = '^[0-9a-f]{64}$';

export const AssetId = Type.String({
  pattern: ASSET_ID_PATTERN,
  description: "An asset id: the SHA-256 of the asset's bytes, as 64 lowercase hex digits.",
});
export type AssetId = Static<typeof AssetId>;

/** A backend kind as an `extensions` key: `sdcpp`, `comfy`, `openai`. */
export const BACKEND_KIND_PATTERN = '^[a-z][a-z0-9_-]*$';

/** The values of a union of string literals, in schema order. */
function valuesOf<T extends string>(union: { anyOf: readonly { const: T }[] }): readonly T[] {
  return union.anyOf.map((member) => member.const);
}

// ---------------------------------------------------------------------------
// Seeds (A1)
// ---------------------------------------------------------------------------

/** The seed that asks Lantern to draw one. The drawn seed is stored in `effective`. */
export const RANDOM_SEED = 'random';

/** The largest seed a request may carry: 2^53 − 1, so it survives JSON in JavaScript. */
export const SEED_MAX = Number.MAX_SAFE_INTEGER;

/**
 * Lantern draws seeds in [0, SEED_DRAW_LIMIT), which every backend accepts
 * (A1111 seeds are 32-bit). Output k of a batch uses seed + k, emulated
 * fan-out included.
 */
export const SEED_DRAW_LIMIT = 2 ** 32;

export const Seed = Type.Union(
  [Type.Literal(RANDOM_SEED), Type.Integer({ minimum: 0, maximum: SEED_MAX })],
  {
    description:
      '`"random"`, or an integer from 0 to 2^53 − 1. Lantern draws random seeds below 2^32; output k of a batch uses seed + k.',
  },
);
export type Seed = Static<typeof Seed>;

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const GenerationMode = Type.Union(
  [
    Type.Literal('txt2img'),
    Type.Literal('img2img'),
    Type.Literal('inpaint'),
    Type.Literal('edit'),
    Type.Literal('txt2vid'),
    Type.Literal('img2vid'),
    Type.Literal('vid_extend'),
    Type.Literal('upscale'),
  ],
  {
    description:
      'What to make. Required and authoritative: it decides which inputs are needed and which are used (A4).',
  },
);
export type GenerationMode = Static<typeof GenerationMode>;
export const GENERATION_MODES = valuesOf(GenerationMode);

export const InputRole = Type.Union(
  [
    Type.Literal('init'),
    Type.Literal('mask'),
    Type.Literal('ref'),
    Type.Literal('style'),
    Type.Literal('control'),
    Type.Literal('ip_adapter'),
    Type.Literal('first_frame'),
    Type.Literal('last_frame'),
    Type.Literal('annotation'),
  ],
  {
    description:
      "What an input is for. `ref` is a likeness or content reference; `style` a style exemplar (StoryEngine's split).",
  },
);
export type InputRole = Static<typeof InputRole>;
export const INPUT_ROLES = valuesOf(InputRole);

export const AdapterKind = Type.Union([Type.Literal('lora'), Type.Literal('embedding')], {
  description: 'The kind of adapter.',
});
export type AdapterKind = Static<typeof AdapterKind>;
export const ADAPTER_KINDS = valuesOf(AdapterKind);

export const AdapterStage = Type.Union([Type.Literal('high_noise'), Type.Literal('low_noise')], {
  description:
    "Which expert of a two-stage model the adapter applies to (Wan 2.2's high- and low-noise models; sd.cpp's `is_high_noise`). Absent: the model's only stage.",
});
export type AdapterStage = Static<typeof AdapterStage>;
export const ADAPTER_STAGES = valuesOf(AdapterStage);

export const PassKind = Type.Union([Type.Literal('hires'), Type.Literal('upscale')], {
  description:
    '`hires`: upscale, then resample. `upscale`: upscale only. `refine` and `face_fix` stay out until designed (A9).',
});
export type PassKind = Static<typeof PassKind>;
export const PASS_KINDS = valuesOf(PassKind);

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const SOURCE_RECT_DESCRIPTION =
  'A rectangle normalised to 0..1, so it survives the image being resized or re-encoded.';

/**
 * A normalised rectangle, mirroring StoryEngine's `SourceRect` so the two line
 * up. Each value is in 0..1 here; that the rectangle has an area and stays
 * inside the image (`x + width ≤ 1`, `y + height ≤ 1`) is checked in code.
 * Field paths treat a `SourceRect` (found by its `title`) as one value
 * (`inputs.ref.crop`).
 *
 * @param description what this rectangle means where it is used
 */
function sourceRect(description = SOURCE_RECT_DESCRIPTION) {
  return Type.Object(
    {
      x: Type.Number({
        minimum: 0,
        maximum: 1,
        description: 'Left edge, as a fraction of the width.',
      }),
      y: Type.Number({
        minimum: 0,
        maximum: 1,
        description: 'Top edge, as a fraction of the height.',
      }),
      width: Type.Number({
        minimum: 0,
        maximum: 1,
        description: 'Width, as a fraction of the width; greater than 0, and x + width ≤ 1.',
      }),
      height: Type.Number({
        minimum: 0,
        maximum: 1,
        description: 'Height, as a fraction of the height; greater than 0, and y + height ≤ 1.',
      }),
    },
    { title: 'SourceRect', additionalProperties: false, description },
  );
}

export const SourceRect = sourceRect();
export type SourceRect = Static<typeof SourceRect>;

const CROP_DESCRIPTION =
  'The part of the asset to use (A7). Lantern saves the crop as a derived asset, which `effective` references.';

function denoise(description: string) {
  return Type.Number({ minimum: 0, maximum: 1, description });
}

function steps(description: string) {
  return Type.Integer({ minimum: 1, description });
}

const Scale = Type.Number({
  exclusiveMinimum: 0,
  description: 'The factor to scale each side by.',
});

const Upscaler = Type.String({
  minLength: 1,
  description: "The upscaler to use, by the route's name for it.",
});

function pixelSize(description: string) {
  return Type.Object(
    {
      width: Type.Integer({ minimum: 1, description: 'Width in pixels.' }),
      height: Type.Integer({ minimum: 1, description: 'Height in pixels.' }),
    },
    { additionalProperties: false, description },
  );
}

/** A size in pixels. */
export const PixelSize = pixelSize('A size in pixels.');
export type PixelSize = Static<typeof PixelSize>;

// ---------------------------------------------------------------------------
// Request parts
// ---------------------------------------------------------------------------

export const Prompt = Type.Object(
  {
    positive: Type.String({ description: 'What to make.' }),
    negative: Type.Optional(Type.String({ description: 'What to avoid.' })),
    dialect_hint: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "How the prompt is written (for example tag lists or prose), so the resolver can warn when it doesn't suit the model.",
      }),
    ),
  },
  { additionalProperties: false, description: 'The prompt.' },
);
export type Prompt = Static<typeof Prompt>;

export const Input = Type.Object(
  {
    role: InputRole,
    asset_id: AssetId,
    weight: Type.Optional(
      Type.Number({
        description:
          'Strength, defined per role (control strength, IP-adapter scale). Never init strength: that is `sampling.denoise`, and `init` and `mask` inputs take no weight.',
      }),
    ),
    region: Type.Optional(
      sourceRect('Where in the output the input applies, distinct from `crop` (A7).'),
    ),
    crop: Type.Optional(sourceRect(CROP_DESCRIPTION)),
  },
  { additionalProperties: false, description: 'An asset given to the generation.' },
);
export type Input = Static<typeof Input>;

export const Geometry = Type.Object(
  {
    width: Type.Integer({ minimum: 1, description: 'Output width in pixels.' }),
    height: Type.Integer({ minimum: 1, description: 'Output height in pixels.' }),
    frames: Type.Optional(Type.Integer({ minimum: 1, description: 'Video frames.' })),
    fps: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: 'Video frame rate.' })),
    duration_s: Type.Optional(
      Type.Number({ exclusiveMinimum: 0, description: 'Video duration in seconds.' }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "The output's size, and for video its length. Optional: the resolver takes it from the init input where the mode derives it, and from the profile otherwise.",
  },
);
export type Geometry = Static<typeof Geometry>;

export const Sampling = Type.Object(
  {
    seed: Seed,
    steps: Type.Optional(steps('Sampling steps.')),
    cfg: Type.Optional(Type.Number({ minimum: 0, description: 'Classifier-free guidance scale.' })),
    distilled_guidance: Type.Optional(
      Type.Number({ minimum: 0, description: 'Guidance for guidance-distilled models (Flux).' }),
    ),
    image_cfg: Type.Optional(
      Type.Number({
        minimum: 0,
        description: 'Image guidance scale, for instruction-edit models (A8).',
      }),
    ),
    denoise: Type.Optional(
      denoise('Strength for img2img and inpaint: 0 keeps the init image, 1 replaces it (A8).'),
    ),
    clip_skip: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          'CLIP layers to skip, in the A1111 and sd.cpp convention: 1 is the last layer, 2 the penultimate (Comfy writes −2).',
      }),
    ),
    sampler: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          'A name from the canonical sampler vocabulary, or `native:<name>` for a backend name.',
      }),
    ),
    scheduler: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          'A name from the canonical scheduler vocabulary, or `native:<name>` for a backend name.',
      }),
    ),
    eta: Type.Optional(
      Type.Number({ minimum: 0, description: 'Noise multiplier for ancestral samplers.' }),
    ),
    flow_shift: Type.Optional(
      Type.Number({ description: 'Timestep shift for flow-matching models.' }),
    ),
  },
  { additionalProperties: false, description: 'How to sample.' },
);
export type Sampling = Static<typeof Sampling>;

export const Adapter = Type.Object(
  {
    kind: AdapterKind,
    id: Type.String({
      minLength: 1,
      description: "The adapter's id, local to the route in 0.1.",
    }),
    weight: Type.Number({ description: 'Strength; may be negative.' }),
    stage: Type.Optional(AdapterStage),
  },
  { additionalProperties: false, description: 'A LoRA or embedding to apply.' },
);
export type Adapter = Static<typeof Adapter>;

/** A hires pass. Exactly one of `scale` and `target` is given (checked in code). */
export const HiresPass = Type.Object(
  {
    kind: Type.Literal('hires'),
    scale: Type.Optional(Scale),
    target: Type.Optional(pixelSize('The size to upscale to.')),
    steps: Type.Optional(steps('Steps for the second sampling.')),
    denoise: Type.Optional(denoise('Strength of the second sampling.')),
    upscaler: Type.Optional(Upscaler),
  },
  {
    additionalProperties: false,
    description: 'Upscale, then sample again: `scale` or `target`, not both.',
  },
);
export type HiresPass = Static<typeof HiresPass>;

export const UpscalePass = Type.Object(
  {
    kind: Type.Literal('upscale'),
    scale: Scale,
    upscaler: Type.Optional(Upscaler),
  },
  { additionalProperties: false, description: 'Upscale only.' },
);
export type UpscalePass = Static<typeof UpscalePass>;

/** Each pass kind's own schema: the fields it takes, and which are required. */
export const PASS_SCHEMAS = { hires: HiresPass, upscale: UpscalePass } as const;

/**
 * One pass, as the wire schema validates it: a single closed object holding
 * every pass kind's fields, so Ajv's errors name the field rather than
 * reporting a failed union. {@link checkGenerationRequest} then holds each
 * pass to its kind's schema in {@link PASS_SCHEMAS}. The static type is the
 * discriminated union, which a request that passed both satisfies.
 */
export const Pass = Type.Unsafe<HiresPass | UpscalePass>(
  Type.Object(
    {
      kind: PassKind,
      scale: Type.Optional(Scale),
      target: HiresPass.properties.target,
      steps: HiresPass.properties.steps,
      denoise: HiresPass.properties.denoise,
      upscaler: Type.Optional(Upscaler),
    },
    {
      additionalProperties: false,
      description:
        'A pass run after generation, in the order given. `hires` takes `scale` or `target`, and optionally `steps`, `denoise` and `upscaler`; `upscale` takes `scale` and optionally `upscaler`.',
    },
  ),
);
export type Pass = Static<typeof Pass>;

export const Audio = Type.Object(
  {
    enabled: Type.Boolean({ description: 'Whether to generate audio with the video.' }),
    prompt: Type.Optional(Type.String({ description: 'What the audio should be.' })),
  },
  { additionalProperties: false, description: 'Audio for video modes.' },
);
export type Audio = Static<typeof Audio>;

/**
 * Backend-specific long-tail fields, keyed by backend kind. Each value is
 * opaque here (its schema comes from the route's descriptor), and every value
 * schema is open, so validation never strips one and serialisation keeps it
 * whole (rule 5).
 */
export const Extensions = Type.Record(
  Type.String({ pattern: BACKEND_KIND_PATTERN }),
  Type.Record(Type.String(), Type.Unknown(), {
    description: "Fields for this backend kind, validated against the route's descriptor.",
  }),
  {
    additionalProperties: false,
    description:
      'Backend-specific fields keyed by backend kind (`sdcpp`, `comfy`, `openai`). Fields for another backend kind are reported as ignored, not refused.',
  },
);
export type Extensions = Static<typeof Extensions>;

// ---------------------------------------------------------------------------
// Experimental: subjects and styles (A10), designed at 0.5
// ---------------------------------------------------------------------------

const EXPERIMENTAL = 'Experimental: reserved for 0.5 (A10); the shape may change.';

/** StoryEngine's `VisualDescriptors` keys, so a character card maps across unchanged. */
export const VisualDescriptors = Type.Object(
  {
    face: Type.Optional(Type.String()),
    hair: Type.Optional(Type.String()),
    eyes: Type.Optional(Type.String()),
    build: Type.Optional(Type.String()),
    clothing: Type.Optional(Type.String()),
    accessories: Type.Optional(Type.String()),
    distinguishing: Type.Optional(Type.String()),
  },
  {
    additionalProperties: false,
    description: `Structured appearance, the emulated fallback for conveying a subject. ${EXPERIMENTAL}`,
  },
);
export type VisualDescriptors = Static<typeof VisualDescriptors>;

export const AssetReference = Type.Object(
  { asset_id: AssetId, crop: Type.Optional(sourceRect(CROP_DESCRIPTION)) },
  { additionalProperties: false, description: `An asset, optionally cropped. ${EXPERIMENTAL}` },
);
export type AssetReference = Static<typeof AssetReference>;

export const Subject = Type.Object(
  {
    label: Type.Optional(Type.String({ description: 'A name for people.' })),
    references: Type.Array(AssetReference, { description: 'Likeness references.' }),
    descriptors: Type.Optional(VisualDescriptors),
    adapters: Type.Optional(
      Type.Array(Adapter, { description: 'Adapters that carry the likeness.' }),
    ),
  },
  {
    additionalProperties: false,
    description: `Who appears, independent of how the route takes it. ${EXPERIMENTAL}`,
  },
);
export type Subject = Static<typeof Subject>;

export const Style = Type.Object(
  {
    exemplars: Type.Array(AssetReference, { description: 'Style exemplars.' }),
    text: Type.Optional(Type.String({ description: 'The style in words.' })),
  },
  {
    additionalProperties: false,
    description: `In what style, kept separate from likeness. ${EXPERIMENTAL}`,
  },
);
export type Style = Static<typeof Style>;

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export const GenerationRequest = Type.Object(
  {
    schema_version: Type.Literal(GENERATION_REQUEST_SCHEMA_VERSION, {
      description: 'The version of this schema the request was written against.',
    }),
    mode: GenerationMode,
    prompt: Prompt,
    inputs: Type.Optional(
      Type.Array(Input, {
        description: 'Assets given to the generation. Each mode fixes which roles it needs (A4).',
      }),
    ),
    subjects: Type.Optional(Type.Array(Subject, { description: `Who appears. ${EXPERIMENTAL}` })),
    style: Type.Optional(Style),
    geometry: Type.Optional(Geometry),
    sampling: Sampling,
    adapters: Type.Optional(Type.Array(Adapter, { description: 'Adapters to apply.' })),
    passes: Type.Optional(
      Type.Array(Pass, { description: 'Passes run after generation, in the order given.' }),
    ),
    count: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: 'How many outputs. Output k uses seed + k. Absent: the resolved default.',
      }),
    ),
    audio: Type.Optional(Audio),
    extensions: Type.Optional(Extensions),
  },
  {
    additionalProperties: false,
    description:
      'A canonical generation request. Absent optional fields take the resolved default (request > preset > model overrides > profile > descriptor default); the schema itself fills nothing in.',
  },
);
export type GenerationRequest = Static<typeof GenerationRequest>;
