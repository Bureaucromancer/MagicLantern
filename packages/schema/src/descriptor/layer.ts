// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * A descriptor layer (A6): a partial descriptor laid over a route's
 * `describe()` result. Probe results, user overrides and profile constraints
 * all take this one shape; what each may do with it differs, and the daemon's
 * merge enforces that, recording a note for anything a layer may not do:
 *
 * - a **probe** may only demote (native → emulated → ignored → absent);
 * - a **user override** may add or widen (the Tier 3 extension path);
 * - a **profile** may only narrow, or remove.
 *
 * Every entry is partial: only what the layer says changes. `state: "absent"`
 * removes an entry (or, on a mode, the whole mode).
 */

import { type Static, Type } from '@sinclair/typebox';

import {
  ADAPTER_KINDS,
  BACKEND_KIND_PATTERN,
  GENERATION_MODES,
  INPUT_ROLES,
  PASS_KINDS,
} from '../request/generation-request.js';
import {
  AdapterOption,
  CapabilityState,
  CollectionCapability,
  ExtensionSchema,
  FieldCapability,
  ModeControl,
} from './descriptor.js';
import { partialRecord } from './partial-record.js';

export const LayerState = Type.Union([CapabilityState, Type.Literal('absent')], {
  description: 'A state, or `absent` to remove the entry.',
});
export type LayerState = Static<typeof LayerState>;

export const FieldLayer = Type.Object(
  {
    state: Type.Optional(LayerState),
    ...Type.Partial(Type.Omit(FieldCapability, ['state'])).properties,
  },
  { additionalProperties: false, description: 'Changes to one field entry.' },
);
export type FieldLayer = Static<typeof FieldLayer>;

export const CollectionLayer = Type.Object(
  {
    state: Type.Optional(LayerState),
    ...Type.Partial(Type.Omit(CollectionCapability, ['state'])).properties,
  },
  { additionalProperties: false, description: 'Changes to one input role or pass kind.' },
);
export type CollectionLayer = Static<typeof CollectionLayer>;

export const AdapterLayer = Type.Object(
  { ...CollectionLayer.properties, options: Type.Optional(Type.Array(AdapterOption)) },
  {
    additionalProperties: false,
    description: 'Changes to one adapter kind; `options` adds adapters (overrides only).',
  },
);
export type AdapterLayer = Static<typeof AdapterLayer>;

export const ModeLayer = Type.Object(
  {
    state: Type.Optional(
      Type.Literal('absent', { description: 'Remove the mode (probes and profiles).' }),
    ),
    fields: Type.Optional(Type.Record(Type.String(), FieldLayer)),
    inputs: Type.Optional(partialRecord(INPUT_ROLES, CollectionLayer, 'Changes by input role.')),
    adapters: Type.Optional(partialRecord(ADAPTER_KINDS, AdapterLayer, 'Changes by adapter kind.')),
    passes: Type.Optional(partialRecord(PASS_KINDS, CollectionLayer, 'Changes by pass kind.')),
    extensions: Type.Optional(
      Type.Record(Type.String({ pattern: BACKEND_KIND_PATTERN }), ExtensionSchema, {
        additionalProperties: false,
        description: 'Extension schemas to add, by backend kind (overrides only).',
      }),
    ),
    control: Type.Optional(Type.Partial(ModeControl)),
  },
  { additionalProperties: false, description: 'Changes to one mode.' },
);
export type ModeLayer = Static<typeof ModeLayer>;

export const DescriptorLayer = Type.Object(
  { modes: partialRecord(GENERATION_MODES, ModeLayer, 'Changes by mode.') },
  {
    additionalProperties: false,
    description:
      'A partial descriptor laid over a route: a probe result, a user override or profile constraints (A6).',
  },
);
export type DescriptorLayer = Static<typeof DescriptorLayer>;

/** Where a layer comes from, which decides what it may do. */
export type LayerSource = 'probe' | 'override' | 'profile';
