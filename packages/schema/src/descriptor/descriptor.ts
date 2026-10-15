// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The capability descriptor (A5): what a route does with each canonical
 * field, per mode. Adapters produce one per route from `describe()`; the
 * daemon layers probe results, user overrides and profile constraints over it
 * (A6) to get the effective descriptor the resolver and the UI read.
 *
 * - **Absent means not listed.** A field, collection or mode the descriptor
 *   leaves out is refused by the compiled validator; every listed one is
 *   `native`, `emulated` or `ignored` (rule 4: no silent drops).
 * - **Paths** are the request path grammar (`REQUEST_PATHS`): `fields` takes
 *   field paths (`sampling.steps`, `inputs.ref.weight`, `passes.hires.scale`),
 *   and the three collection maps take the discriminator values (`inputs.ref`
 *   is `inputs.ref` here, `adapters.lora` is `adapters.lora`).
 * - **Narrowing** is JSON Schema keywords ({@link FieldNarrowing}); a field's
 *   type always comes from the request schema.
 * - **Static.** Nothing here depends on another field's value: "negatives do
 *   nothing at CFG 1" is a profile warning, not a capability state. That keeps
 *   descriptors cacheable and their digest meaningful in `route_snapshot`.
 *
 * {@link checkRouteDescriptor} holds the rules a schema can't state.
 */

import { type Static, Type } from '@sinclair/typebox';

import {
  ADAPTER_KINDS,
  BACKEND_KIND_PATTERN,
  GENERATION_MODES,
  INPUT_ROLES,
  PASS_KINDS,
} from '../request/generation-request.js';
import { FieldNarrowing } from './narrowing.js';
import { partialRecord } from './partial-record.js';

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export const CapabilityState = Type.Union(
  [Type.Literal('native'), Type.Literal('emulated'), Type.Literal('ignored')],
  {
    description:
      '`native`: the backend does it. `emulated`: Lantern does it around the backend. `ignored`: accepted, has no effect, and the field report says so. A field not listed at all is refused.',
  },
);
export type CapabilityState = Static<typeof CapabilityState>;
export const CAPABILITY_STATES: readonly CapabilityState[] = ['native', 'emulated', 'ignored'];

/** The state a layer gives to remove an entry; never part of an effective descriptor. */
export const ABSENT = 'absent';

/**
 * Rank for demotion and promotion (A6): native > emulated > ignored > absent.
 * A probe may only move an entry down; a user override may only move it up.
 */
export const STATE_RANK: Readonly<Record<CapabilityState | typeof ABSENT, number>> = {
  native: 3,
  emulated: 2,
  ignored: 1,
  absent: 0,
};

const reason = Type.String({
  minLength: 1,
  description: 'Why the field is emulated or ignored, for people. Static: never value-dependent.',
});

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** Field-entry properties beyond the narrowing keywords. */
const fieldProperties = {
  state: CapabilityState,
  reason: Type.Optional(reason),
  default: Type.Optional(
    Type.Unknown({
      description:
        "The route's default, the last step of precedence (A3). Never compiled into the validator: defaults belong to the resolver.",
    }),
  ),
  native_max: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: '`count` only: the most outputs the backend makes in one job.',
    }),
  ),
  emulated_max: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        '`count` only: the most outputs Lantern will make by fanning out jobs; at least `native_max`.',
    }),
  ),
};

export const FieldCapability = Type.Object(
  { ...fieldProperties, ...FieldNarrowing.properties },
  {
    additionalProperties: false,
    description:
      "What a route does with one field, and how it narrows the field's values. Narrowing keywords are JSON Schema's own; the type comes from the request schema.",
  },
);
export type FieldCapability = Static<typeof FieldCapability>;

/** The narrowing keywords a field entry may carry, in a fixed order. */
export const NARROWING_KEYWORDS = Object.keys(
  FieldNarrowing.properties,
) as readonly (keyof FieldNarrowing)[];

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

const collectionProperties = {
  state: CapabilityState,
  reason: Type.Optional(reason),
  min: Type.Optional(
    Type.Integer({ minimum: 0, description: 'The fewest items a request must give.' }),
  ),
  max: Type.Optional(
    Type.Integer({ minimum: 0, description: 'The most items a request may give.' }),
  ),
  media: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      uniqueItems: true,
      description: 'Media types the items may be, e.g. `image/png` or `image/*`.',
    }),
  ),
};

export const CollectionCapability = Type.Object(collectionProperties, {
  additionalProperties: false,
  description: 'What a route does with one input role or pass kind: `{state, min, max, media}`.',
});
export type CollectionCapability = Static<typeof CollectionCapability>;

/**
 * One adapter a route offers (L8). The validator narrows on `id`; the rest is
 * for the picker, and a manager's LoRA library can fill it in.
 */
export const AdapterOption = Type.Object(
  {
    id: Type.String({
      minLength: 1,
      description: 'The id a request names, local to the route in 0.1.',
    }),
    label: Type.Optional(Type.String({ minLength: 1, description: 'A name for people.' })),
    sha256: Type.Optional(
      Type.String({
        pattern: '^[0-9a-f]{64}$',
        description: "The file's SHA-256, for matching across routes later.",
      }),
    ),
    family: Type.Optional(
      Type.String({ minLength: 1, description: 'The base model family it was trained for.' }),
    ),
    default_weight: Type.Optional(Type.Number({ description: 'The weight to start from.' })),
    triggers: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { description: 'Trigger words.' }),
    ),
  },
  { additionalProperties: false, description: 'An adapter a route offers.' },
);
export type AdapterOption = Static<typeof AdapterOption>;

export const AdapterCapability = Type.Object(
  {
    ...collectionProperties,
    options: Type.Optional(
      Type.Array(AdapterOption, {
        description:
          'The adapters on offer. Present: a request may name only these ids. Absent: the route does not enumerate them.',
      }),
    ),
  },
  {
    additionalProperties: false,
    description: 'What a route does with one adapter kind, and which adapters it offers.',
  },
);
export type AdapterCapability = Static<typeof AdapterCapability>;

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

export const ProgressKind = Type.Union(
  [Type.Literal('fraction'), Type.Literal('steps'), Type.Literal('none')],
  { description: 'What progress to expect: a fraction, step counts, or none (an elapsed timer).' },
);
export type ProgressKind = Static<typeof ProgressKind>;

/** Rank for demotion and promotion, as {@link STATE_RANK}: fraction > steps > none. */
export const PROGRESS_RANK: Readonly<Record<ProgressKind, number>> = {
  fraction: 2,
  steps: 1,
  none: 0,
};

export const ModeControl = Type.Object(
  {
    cancel_queued: Type.Boolean({ description: 'Whether a queued job can be cancelled.' }),
    cancel_running: Type.Boolean({ description: 'Whether a running job can be cancelled.' }),
    progress: ProgressKind,
  },
  {
    additionalProperties: false,
    description:
      "Per mode, because a backend's modes differ (sd.cpp's upscale is synchronous where generation isn't).",
  },
);
export type ModeControl = Static<typeof ModeControl>;

// ---------------------------------------------------------------------------
// Modes and routes
// ---------------------------------------------------------------------------

/** A backend-kind extension: a JSON Schema object for `extensions.<kind>`. */
export const ExtensionSchema = Type.Record(Type.String(), Type.Unknown(), {
  description: 'A JSON Schema with `type: "object"`, validating `extensions.<kind>`.',
});
export type ExtensionSchema = Static<typeof ExtensionSchema>;

export const InputCapabilities = partialRecord(
  INPUT_ROLES,
  CollectionCapability,
  'Input roles the mode takes, by role.',
);
export type InputCapabilities = Static<typeof InputCapabilities>;

export const AdapterCapabilities = partialRecord(
  ADAPTER_KINDS,
  AdapterCapability,
  'Adapter kinds the mode takes, by kind.',
);
export type AdapterCapabilities = Static<typeof AdapterCapabilities>;

export const PassCapabilities = partialRecord(
  PASS_KINDS,
  CollectionCapability,
  'Pass kinds the mode takes, by kind.',
);
export type PassCapabilities = Static<typeof PassCapabilities>;

export const ModeDescriptor = Type.Object(
  {
    fields: Type.Record(Type.String(), FieldCapability, {
      description: 'Field entries by field path (`sampling.steps`, `inputs.ref.weight`).',
    }),
    inputs: Type.Optional(InputCapabilities),
    adapters: Type.Optional(AdapterCapabilities),
    passes: Type.Optional(PassCapabilities),
    extensions: Type.Optional(
      Type.Record(Type.String({ pattern: BACKEND_KIND_PATTERN }), ExtensionSchema, {
        additionalProperties: false,
        description: "JSON Schema for each backend kind's `extensions` block.",
      }),
    ),
    control: ModeControl,
  },
  { additionalProperties: false, description: 'What a route does in one mode.' },
);
export type ModeDescriptor = Static<typeof ModeDescriptor>;

export const RouteDescriptor = Type.Object(
  {
    route: Type.String({ minLength: 1, description: 'The route id.' }),
    modes: partialRecord(GENERATION_MODES, ModeDescriptor, 'The modes the route serves.'),
  },
  {
    additionalProperties: false,
    description: "One route's capabilities, per mode (A5).",
  },
);
export type RouteDescriptor = Static<typeof RouteDescriptor>;
