// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Models and profiles.
 *
 * A model is what a person picks: a Lantern id plus a fingerprint (L4),
 * matched automatically when the model reappears after a reload (A26), and
 * the profile that supplies its defaults and constraints. Its routes are the
 * backends serving it; each has an effective descriptor (its `describe()`
 * result with the profile layered over, A6), which is what the form renders.
 *
 * Requires a session in password mode.
 */

import { type Static, Type } from '@sinclair/typebox';

import { RouteDescriptor } from '../descriptor/descriptor.js';
import { GenerationMode } from '../request/generation-request.js';
import { RouteHealth } from '../resolution/resolution.js';
import { BackendId, BackendKindName, ModelFingerprint } from './backends.js';
import { errorResponse, ForbiddenHostOrOrigin } from './errors.js';
import { ModelId, RouteId } from './resolve.js';
import { API_V1_PREFIX, type RouteContract } from './route.js';

export const ModelProfileRef = Type.Object(
  {
    family: Type.String(),
    name: Type.String({ description: "The profile's display name, or its variant's." }),
    variant: Type.Optional(Type.String()),
  },
  { additionalProperties: false, description: 'The profile a model uses.' },
);
export type ModelProfileRef = Static<typeof ModelProfileRef>;

export const ModelRouteSummary = Type.Object(
  {
    id: RouteId,
    backend_id: BackendId,
    backend_name: Type.String(),
    adapter_kind: BackendKindName,
    status: Type.Union([Type.Literal('active'), Type.Literal('retired')]),
    health: RouteHealth,
    priority: Type.Integer(),
    modes: Type.Array(GenerationMode, {
      description: 'The modes its effective descriptor serves.',
    }),
  },
  { additionalProperties: false, description: 'One route of a model.' },
);
export type ModelRouteSummary = Static<typeof ModelRouteSummary>;

export const ModelSummary = Type.Object(
  {
    id: ModelId,
    display_name: Type.String(),
    family: Type.String({ description: 'The profile family, or `generic`.' }),
    variant: Type.Union([Type.String(), Type.Null()]),
    profile: Type.Union([ModelProfileRef, Type.Null()], {
      description:
        'The profile in use; null when its family is not loaded (a newer build named it), in which case the model cannot be used.',
    }),
    fingerprint: Type.Union([ModelFingerprint, Type.Null()]),
    modes: Type.Array(GenerationMode, {
      description: 'Every mode some route of the model serves.',
    }),
    routes: Type.Array(ModelRouteSummary),
  },
  { additionalProperties: false, description: 'A model and its routes.' },
);
export type ModelSummary = Static<typeof ModelSummary>;

export const ModelListResponse = Type.Object(
  { models: Type.Array(ModelSummary) },
  { additionalProperties: false, description: 'Every model, by display name.' },
);
export type ModelListResponse = Static<typeof ModelListResponse>;

export const ModelRouteDetail = Type.Object(
  {
    ...ModelRouteSummary.properties,
    descriptor: RouteDescriptor,
    descriptor_digest: Type.String({
      description: "The effective descriptor's digest, as `route_snapshot` keeps it.",
    }),
  },
  {
    additionalProperties: false,
    description: 'A route with its effective descriptor (A6): what the form renders.',
  },
);
export type ModelRouteDetail = Static<typeof ModelRouteDetail>;

export const ModelDetail = Type.Object(
  {
    ...ModelSummary.properties,
    routes: Type.Array(ModelRouteDetail),
  },
  { additionalProperties: false, description: 'A model, its profile, and every route in full.' },
);
export type ModelDetail = Static<typeof ModelDetail>;

export const ModelPatchBody = Type.Object(
  {
    display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    family: Type.Optional(
      Type.String({ minLength: 1, description: 'A family from `GET /profiles`, or `generic`.' }),
    ),
    variant: Type.Optional(
      Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
        description: "One of the family's variants; null for the family's default.",
      }),
    ),
  },
  {
    additionalProperties: false,
    minProperties: 1,
    description:
      'What to change. Changing the family without `variant` clears the variant. Jobs already queued keep the profile they were resolved with until they are dispatched, when they are checked again.',
  },
);
export type ModelPatchBody = Static<typeof ModelPatchBody>;

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export const ProfileSummary = Type.Object(
  {
    family: Type.String(),
    name: Type.String(),
    modes: Type.Array(GenerationMode, { description: 'The modes the family supports.' }),
    default_variant: Type.Union([Type.String(), Type.Null()]),
    variants: Type.Array(
      Type.Object(
        { id: Type.String(), name: Type.String(), modes: Type.Array(GenerationMode) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, description: 'A model profile, for the profile picker (A26).' },
);
export type ProfileSummary = Static<typeof ProfileSummary>;

export const ProfileListResponse = Type.Object(
  { profiles: Type.Array(ProfileSummary, { description: '`generic` first, then by name.' }) },
  { additionalProperties: false, description: 'The loaded model profiles.' },
);
export type ProfileListResponse = Static<typeof ProfileListResponse>;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const unauthenticated = errorResponse('`unauthenticated`: password mode and no valid session.');
const ModelParams = Type.Object({ id: ModelId }, { additionalProperties: false });
const modelNotFound = errorResponse('`not-found`: no model has this id.');

export const ListModelsRoute = {
  method: 'GET',
  path: `${API_V1_PREFIX}/models`,
  url: '/models',
  schema: {
    operationId: 'listModels',
    summary: 'Models with their profiles and routes',
    tags: ['models'],
    response: { 200: ModelListResponse, 401: unauthenticated, 403: ForbiddenHostOrOrigin },
  },
} satisfies RouteContract;

export const GetModelRoute = {
  method: 'GET',
  path: `${API_V1_PREFIX}/models/{id}`,
  url: '/models/:id',
  schema: {
    operationId: 'getModel',
    summary: "A model, with each route's effective descriptor",
    tags: ['models'],
    params: ModelParams,
    response: {
      200: ModelDetail,
      401: unauthenticated,
      403: ForbiddenHostOrOrigin,
      404: modelNotFound,
      422: errorResponse('`invalid`: the id is malformed.'),
    },
  },
} satisfies RouteContract;

export const PatchModelRoute = {
  method: 'PATCH',
  path: `${API_V1_PREFIX}/models/{id}`,
  url: '/models/:id',
  schema: {
    operationId: 'patchModel',
    summary: 'Rename a model, or change its profile',
    description:
      'For the proposal card and for a guess that was wrong (A26). The development model cannot be changed.',
    tags: ['models'],
    params: ModelParams,
    body: ModelPatchBody,
    response: {
      200: ModelDetail,
      400: errorResponse('`bad-request`: the body is not valid JSON.'),
      401: unauthenticated,
      403: ForbiddenHostOrOrigin,
      404: modelNotFound,
      409: errorResponse('`conflict`: the model is the in-memory development model.'),
      413: errorResponse("`payload-too-large`: the body is over the daemon's size limit."),
      415: errorResponse('`unsupported-media-type`: the body is not JSON.'),
      422: errorResponse(
        '`invalid`: the body does not match the schema, or names an unknown profile or variant.',
      ),
    },
  },
} satisfies RouteContract;

export const ListProfilesRoute = {
  method: 'GET',
  path: `${API_V1_PREFIX}/profiles`,
  url: '/profiles',
  schema: {
    operationId: 'listProfiles',
    summary: 'The model profiles, for the profile picker',
    tags: ['models'],
    response: { 200: ProfileListResponse, 401: unauthenticated, 403: ForbiddenHostOrOrigin },
  },
} satisfies RouteContract;
