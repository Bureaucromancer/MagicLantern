// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Narrowing: the one shape every layer uses to tighten a field's values
 * (A5, A6). A descriptor's field entry carries it, and so do a model
 * profile's constraints, which may only narrow what a route declares.
 *
 * The keywords are JSON Schema's own, so a route and mode compile to a single
 * Ajv validator. The field's type always comes from the request schema;
 * narrowing never changes it.
 */

import { Type, type Static } from '@sinclair/typebox';

export const FieldNarrowing = Type.Object(
  {
    minimum: Type.Optional(Type.Number()),
    maximum: Type.Optional(Type.Number()),
    exclusiveMinimum: Type.Optional(Type.Number()),
    exclusiveMaximum: Type.Optional(Type.Number()),
    multipleOf: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    enum: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number()]), { minItems: 1 })),
    minLength: Type.Optional(Type.Integer({ minimum: 0 })),
    maxLength: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  {
    additionalProperties: false,
    description: 'JSON Schema keywords that narrow a field; never its type.',
  },
);
export type FieldNarrowing = Static<typeof FieldNarrowing>;

/** Narrowing per field path (see `REQUEST_PATHS`), e.g. `{ 'sampling.steps': { maximum: 8 } }`. */
export const NarrowingMap = Type.Record(Type.String(), FieldNarrowing, {
  description: 'Narrowing keyed by request field path.',
});
export type NarrowingMap = Static<typeof NarrowingMap>;
