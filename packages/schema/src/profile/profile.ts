// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Model profiles (design doc, "Model profile"; plan, Phase 2 SC3): what Lantern
 * knows about a model family whatever route serves it. A profile supplies the
 * `profile` layer of the precedence (A3: request > preset > model overrides >
 * profile > descriptor default), narrows a route's descriptor through its
 * constraints (A6: profile constraints may only narrow), and carries the
 * advice that depends on values, as warnings.
 *
 * A profile never states a capability. "Negatives do nothing at CFG 1" is a
 * warning with a condition, never an `ignored` state, so descriptors stay
 * static and cacheable (A6).
 *
 * Every field path is in the request path grammar (`REQUEST_PATHS`). Defaults
 * name their source, and a value the sources did not confirm says so with the
 * source `unconfirmed` rather than passing for a checked one.
 *
 * Built-in profiles live as JSON in the repository's `profiles/` directory.
 */

import { type Static, Type } from '@sinclair/typebox';

import { FieldNarrowing, NarrowingMap } from '../descriptor/narrowing.js';
import { GenerationMode, PixelSize } from '../request/generation-request.js';

/** The version every profile written against this schema carries. */
export const MODEL_PROFILE_SCHEMA_VERSION = 1;

/** A family or variant id: lowercase, digits, `.`, `_` and `-`. */
export const PROFILE_ID_PATTERN = '^[a-z0-9][a-z0-9._-]*$';

/** The source id that marks a value the sources did not confirm. */
export const UNCONFIRMED_SOURCE = 'unconfirmed';

const ProfileId = (description: string) =>
  Type.String({ pattern: PROFILE_ID_PATTERN, description });

const Note = Type.String({ minLength: 1 });

// ---------------------------------------------------------------------------
// Sources and licence
// ---------------------------------------------------------------------------

export const ProfileSource = Type.Object(
  {
    id: ProfileId('How defaults cite this source, e.g. `card` or `sdcpp`.'),
    url: Type.String({ pattern: '^https://', description: 'Where the facts were checked.' }),
    title: Type.Optional(Type.String({ minLength: 1, description: 'What the page is.' })),
    checked: Type.String({
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      description: 'The date the page was read, YYYY-MM-DD.',
    }),
  },
  { additionalProperties: false, description: 'A page the profile was checked against.' },
);
export type ProfileSource = Static<typeof ProfileSource>;

/**
 * A source id as cited: a {@link ProfileSource} id of the profile, or
 * `unconfirmed`. Checked against the profile's sources in code.
 */
const SourceRef = ProfileId(
  "The `id` of one of the profile's sources, or `unconfirmed` for a value no source confirmed.",
);

export const Licence = Type.Object(
  {
    id: Type.String({
      minLength: 1,
      description: 'An SPDX identifier where one exists, otherwise a `LicenseRef-` id.',
    }),
    name: Type.String({ minLength: 1, description: "The licence's name." }),
    url: Type.Optional(Type.String({ pattern: '^https://' })),
    commercial_use: Type.Boolean({
      description: 'Whether the weights may be used commercially.',
    }),
    outputs_commercial_use: Type.Optional(
      Type.Boolean({
        description:
          "Whether outputs may be used commercially, where that differs from the weights' terms.",
      }),
    ),
    source: SourceRef,
    note: Type.Optional(Note),
  },
  { additionalProperties: false, description: "The model's licence." },
);
export type Licence = Static<typeof Licence>;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const PromptDialect = Type.Union(
  [Type.Literal('tags'), Type.Literal('natural'), Type.Literal('unconfirmed')],
  {
    description:
      '`tags`: comma-separated tag lists (SD1.5, SDXL). `natural`: sentences (Flux, Qwen, most DiTs). `unconfirmed`: not known (the generic profile).',
  },
);
export type PromptDialect = Static<typeof PromptDialect>;

export const PromptRules = Type.Object(
  {
    dialect: PromptDialect,
    encoders: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description: 'The text encoders, by name.',
      }),
    ),
    token_limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "The encoder's token limit (CLIP 77; T5 or LLM max sequence length).",
      }),
    ),
    chunked: Type.Optional(
      Type.Boolean({
        description:
          'Whether backends commonly split longer prompts into `token_limit` chunks rather than truncate.',
      }),
    ),
    languages: Type.Optional(
      Type.Array(Type.String({ minLength: 2 }), {
        minItems: 1,
        description: 'Prompt languages the sources name, as BCP 47 tags.',
      }),
    ),
    source: SourceRef,
    note: Type.Optional(Note),
  },
  { additionalProperties: false, description: 'How prompts for this family are written.' },
);
export type PromptRules = Static<typeof PromptRules>;

export const NegativePromptBehaviour = Type.Union(
  [Type.Literal('cfg'), Type.Literal('distilled'), Type.Literal('unconfirmed')],
  {
    description:
      '`cfg`: the negative is the unconditional prompt of classifier-free guidance, so it acts only at cfg > 1. `distilled`: the recommended settings run without CFG, so a negative has no effect at them. `unconfirmed`: the sources do not say.',
  },
);
export type NegativePromptBehaviour = Static<typeof NegativePromptBehaviour>;

export const NegativePromptRules = Type.Object(
  {
    behaviour: NegativePromptBehaviour,
    source: SourceRef,
    note: Type.Optional(Note),
  },
  { additionalProperties: false, description: 'What a negative prompt does on this family.' },
);
export type NegativePromptRules = Static<typeof NegativePromptRules>;

// ---------------------------------------------------------------------------
// Resolution and frames
// ---------------------------------------------------------------------------

export const AspectPreset = Type.Object(
  {
    aspect: Type.String({
      pattern: '^\\d+:\\d+$',
      description: 'The nominal aspect ratio, e.g. `16:9`.',
    }),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
  },
  {
    additionalProperties: false,
    description: 'A size for an aspect ratio. Width and height are multiples of `multiple_of`.',
  },
);
export type AspectPreset = Static<typeof AspectPreset>;

export const ResolutionRules = Type.Object(
  {
    multiple_of: Type.Integer({
      minimum: 1,
      description: 'Width and height must be multiples of this.',
    }),
    native: Type.Optional(
      Type.Object(PixelSize.properties, {
        additionalProperties: false,
        description: 'The size the family was trained at. Absent: the sources do not say.',
      }),
    ),
    presets: Type.Optional(
      Type.Array(AspectPreset, {
        description: 'Sizes per aspect ratio, from the sources. Absent: none published.',
      }),
    ),
    source: SourceRef,
    note: Type.Optional(Note),
  },
  { additionalProperties: false, description: "The family's sizes." },
);
export type ResolutionRules = Static<typeof ResolutionRules>;

/**
 * A frame-count rule `a·n + b` for video families: Wan takes 4n + 1, LTX
 * 8n + 1. The UI snaps to it.
 */
export const FrameRule = Type.Object(
  {
    a: Type.Integer({ minimum: 1, description: 'The step between valid counts.' }),
    b: Type.Integer({ minimum: 0, description: 'The offset: valid counts are a·n + b.' }),
    min: Type.Optional(Type.Integer({ minimum: 1 })),
    max: Type.Optional(Type.Integer({ minimum: 1 })),
    source: SourceRef,
  },
  { additionalProperties: false, description: 'Valid frame counts, a·n + b for n ≥ 0.' },
);
export type FrameRule = Static<typeof FrameRule>;

// ---------------------------------------------------------------------------
// Per-mode rules
// ---------------------------------------------------------------------------

export const ProfileDefault = Type.Object(
  {
    value: Type.Union([Type.String(), Type.Number(), Type.Boolean()], {
      description: "The value; it must satisfy the request schema's type for its path.",
    }),
    source: SourceRef,
    note: Type.Optional(Note),
  },
  { additionalProperties: false, description: 'A default and where it comes from.' },
);
export type ProfileDefault = Static<typeof ProfileDefault>;

export const CollectionLimit = Type.Object(
  {
    min: Type.Optional(Type.Integer({ minimum: 0 })),
    max: Type.Optional(Type.Integer({ minimum: 0 })),
    source: SourceRef,
    note: Type.Optional(Note),
  },
  {
    additionalProperties: false,
    description: 'How many items a collection (`inputs.ref`, `adapters.lora`) may hold.',
  },
);
export type CollectionLimit = Static<typeof CollectionLimit>;

export const ModeRules = Type.Object(
  {
    defaults: Type.Optional(
      Type.Record(Type.String(), ProfileDefault, {
        description:
          "Defaults by field path, e.g. `sampling.steps`. Absent paths fall through to the descriptor default, the backend's own.",
      }),
    ),
    constraints: Type.Optional(NarrowingMap),
    collections: Type.Optional(
      Type.Record(Type.String(), CollectionLimit, {
        description: 'Limits by collection path, e.g. `inputs.ref`.',
      }),
    ),
  },
  { additionalProperties: false, description: "A supported mode's defaults and constraints." },
);
export type ModeRules = Static<typeof ModeRules>;

/** The supported modes, each with its rules. A mode not listed is not supported. */
export const ProfileModes = Type.Partial(
  Type.Record(GenerationMode, ModeRules, { additionalProperties: false }),
  { description: 'The supported modes and their rules; a mode not listed is not supported.' },
);
export type ProfileModes = Static<typeof ProfileModes>;

export const WarningCode = Type.String({
  pattern: '^[a-z][a-z0-9_]*$',
  description: 'A stable code clients can key on, e.g. `negative_prompt_ignored`.',
});

export const ProfileWarning = Type.Object(
  {
    code: WarningCode,
    modes: Type.Optional(
      Type.Array(GenerationMode, {
        minItems: 1,
        description: 'The modes it applies to. Absent: every supported mode.',
      }),
    ),
    when: Type.Optional(
      Type.Record(Type.String(), FieldNarrowing, {
        description:
          "The condition, as narrowing over effective values: it holds when every listed field has a value that satisfies its keywords. A field with no effective value doesn't satisfy. Absent: always.",
      }),
    ),
    message: Type.String({ minLength: 1, description: 'The advice, for people.' }),
    source: Type.Optional(SourceRef),
  },
  {
    additionalProperties: false,
    description:
      'Advice that depends on values (A6): never a capability state, so descriptors stay static.',
  },
);
export type ProfileWarning = Static<typeof ProfileWarning>;

// ---------------------------------------------------------------------------
// Variants and the profile
// ---------------------------------------------------------------------------

export const ProfileVariant = Type.Object(
  {
    id: ProfileId('The variant id, unique within the family, e.g. `base-9b`.'),
    name: Type.String({ minLength: 1, description: 'The display name.' }),
    licence: Type.Optional(Licence),
    prompt: Type.Optional(PromptRules),
    negative_prompt: Type.Optional(NegativePromptRules),
    resolution: Type.Optional(ResolutionRules),
    frames: Type.Optional(FrameRule),
    modes: Type.Optional(ProfileModes),
    warnings: Type.Optional(Type.Array(ProfileWarning)),
    sources: Type.Optional(Type.Array(ProfileSource)),
    notes: Type.Optional(Type.Array(Note)),
  },
  {
    additionalProperties: false,
    description:
      "A variant of the family. Its blocks replace the family's; its modes merge per mode and per path, the variant's entry winning; its warnings, sources and notes add to the family's.",
  },
);
export type ProfileVariant = Static<typeof ProfileVariant>;

export const ModelProfile = Type.Object(
  {
    schema_version: Type.Literal(MODEL_PROFILE_SCHEMA_VERSION),
    family: ProfileId('The family id, e.g. `sdxl` or `flux2-klein`.'),
    name: Type.String({ minLength: 1, description: 'The display name.' }),
    licence: Type.Optional(Licence),
    prompt: PromptRules,
    negative_prompt: NegativePromptRules,
    resolution: ResolutionRules,
    frames: Type.Optional(FrameRule),
    modes: ProfileModes,
    warnings: Type.Optional(Type.Array(ProfileWarning)),
    variants: Type.Optional(
      Type.Array(ProfileVariant, {
        minItems: 1,
        description: 'Variants where they differ in defaults, constraints or licence.',
      }),
    ),
    default_variant: Type.Optional(
      ProfileId('The variant to use when none is named. Absent: the family-level profile.'),
    ),
    sources: Type.Array(ProfileSource, { minItems: 1 }),
    notes: Type.Optional(
      Type.Array(Note, {
        description: 'How conflicts between sources were resolved, and other caveats.',
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "A model family's profile. `licence` may be left to the variants when they differ.",
  },
);
export type ModelProfile = Static<typeof ModelProfile>;
