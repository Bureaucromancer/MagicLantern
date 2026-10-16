// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Backends (A26, A32, L1, L9): what serves generations, and the add flow.
 *
 * A backend is either an adapter kind that serves its own routes (a
 * standalone sd-server is one route: one instance, one model) or a manager
 * kind that discovers routes another adapter serves (Lemonade runs one
 * sd-server child per loaded image model). A route is one backend serving one
 * model; its id outlives the instance, so a model Lemonade unloads and loads
 * again on another port keeps its route.
 *
 * - **Config backends** come from `lantern.json`, are reconciled at every
 *   start and are read-only here; one removed from the file is tombstoned.
 * - **UI backends** are added through `POST /backends`, usually after
 *   `POST /backends/detect` proposed them.
 * - **Development backends** (`LANTERN_DEV=1`) live in memory only.
 *
 * Secrets (an API key) are accepted and stored, never answered: a summary
 * names which are set.
 *
 * Requires a session in password mode.
 */

import { type Static, Type } from '@sinclair/typebox';

import { RouteHealth } from '../resolution/resolution.js';
import { errorResponse, ForbiddenHostOrOrigin } from './errors.js';
import { ModelId, RouteId } from './resolve.js';
import { API_V1_PREFIX, type RouteContract } from './route.js';

const Timestamp = (description: string) => Type.String({ format: 'date-time', description });

/** A backend id: `be_` and a ULID for one added here, or the id `lantern.json` gives it. */
export const BACKEND_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]*$';

export const BackendId = Type.String({
  pattern: BACKEND_ID_PATTERN,
  maxLength: 128,
  description: 'A backend id: `be_` and a ULID, or the stable id `lantern.json` gives it.',
});
export type BackendId = Static<typeof BackendId>;

/** A backend kind: `sdcpp`, `lemonade`. */
export const BackendKindName = Type.String({
  pattern: '^[a-z][a-z0-9_-]*$',
  description: 'A backend kind, e.g. `sdcpp` or `lemonade`.',
});

export const BackendBaseUrl = Type.String({
  pattern: '^https?://[^\\s]+$',
  maxLength: 2048,
  description:
    'Where the backend answers, e.g. `http://127.0.0.1:1234`. May carry a path (a proxy prefix, L1).',
});

/** A model's identity (L4): the file a backend reports, or a manager's id and definition hash. */
export const ModelFingerprint = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal('file'),
        path: Type.String({ description: 'The model file, as the backend names it.' }),
        stem: Type.String({ description: 'Its name without directory or extension.' }),
      },
      { additionalProperties: false, description: 'A file the backend reports.' },
    ),
    Type.Object(
      {
        kind: Type.Literal('manager'),
        manager: Type.String({ description: 'The manager kind.' }),
        model_id: Type.String({ description: "The manager's id for the model." }),
        definition_hash: Type.String({ description: 'A hash over every file the model uses.' }),
      },
      { additionalProperties: false, description: 'A manager that knows every file (orchd).' },
    ),
  ],
  { description: "A model's identity (L4), compared whole when a model reappears (A26)." },
);
export type ModelFingerprint = Static<typeof ModelFingerprint>;

export const BackendSource = Type.Union(
  [Type.Literal('config'), Type.Literal('ui'), Type.Literal('dev')],
  {
    description:
      '`config`: from `lantern.json`, read-only here. `ui`: added through the API. `dev`: the development mock (`LANTERN_DEV=1`), in memory only.',
  },
);
export type BackendSource = Static<typeof BackendSource>;

export const BackendRole = Type.Union([Type.Literal('adapter'), Type.Literal('manager')], {
  description:
    '`adapter`: the backend serves its own routes. `manager`: it discovers routes that an adapter kind serves (L1).',
});
export type BackendRole = Static<typeof BackendRole>;

export const BackendHealthReport = Type.Object(
  {
    status: Type.Union([Type.Literal('ok'), Type.Literal('degraded'), Type.Literal('down')]),
    load_state: Type.Union([Type.Literal('loaded'), Type.Literal('cold'), Type.Literal('unknown')]),
    detail: Type.Optional(Type.String()),
  },
  {
    additionalProperties: false,
    description: "The backend's own reachability and load state, kept apart (L2).",
  },
);
export type BackendHealthReport = Static<typeof BackendHealthReport>;

export const BackendRouteSummary = Type.Object(
  {
    id: RouteId,
    model_id: ModelId,
    model_name: Type.String({ description: "The model's display name." }),
    adapter_kind: BackendKindName,
    manager_ref: Type.Union([Type.String(), Type.Null()], {
      description:
        "The manager's own name for the model (Lemonade's model name); null without one.",
    }),
    base_url: Type.String({ description: 'Where the adapter reaches the instance.' }),
    status: Type.Union([Type.Literal('active'), Type.Literal('retired')], {
      description:
        '`retired`: the backend no longer serves the model (Lemonade unloaded it, or the instance now runs another). It counts as down until it comes back.',
    }),
    health: RouteHealth,
    priority: Type.Integer({ description: 'Higher is tried first.' }),
    descriptor_fetched_at: Type.Union([Timestamp('When `describe()` last ran.'), Type.Null()]),
  },
  { additionalProperties: false, description: 'One route a backend serves or served.' },
);
export type BackendRouteSummary = Static<typeof BackendRouteSummary>;

export const BackendSummary = Type.Object(
  {
    id: BackendId,
    kind: BackendKindName,
    role: BackendRole,
    name: Type.String({ description: 'A name for people.' }),
    base_url: Type.String(),
    source: BackendSource,
    status: Type.Union([Type.Literal('active'), Type.Literal('tombstoned')], {
      description:
        '`tombstoned`: a config backend since removed from `lantern.json`. Kept so history still names it; it serves nothing.',
    }),
    resource_group: Type.String({
      description:
        'Jobs in one group run one at a time (or `concurrency` at a time): a GPU host (A12).',
    }),
    concurrency: Type.Integer({ minimum: 1 }),
    settings: Type.Record(Type.String(), Type.Unknown(), {
      description: "The kind's settings, as `GET /backend-kinds` describes them.",
    }),
    secrets: Type.Array(Type.String(), {
      description: 'The names of the secrets that are set. Their values are never answered.',
    }),
    health: Type.Union([BackendHealthReport, Type.Null()], {
      description: 'Null until it has been checked.',
    }),
    last_seen: Type.Union([Timestamp('When it last answered.'), Type.Null()]),
    routes: Type.Array(BackendRouteSummary),
  },
  { additionalProperties: false, description: 'A backend and its routes.' },
);
export type BackendSummary = Static<typeof BackendSummary>;

export const BackendListResponse = Type.Object(
  { backends: Type.Array(BackendSummary) },
  { additionalProperties: false, description: 'Every backend, active first, then by name.' },
);
export type BackendListResponse = Static<typeof BackendListResponse>;

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export const BackendKindInfo = Type.Object(
  {
    kind: BackendKindName,
    role: BackendRole,
    name: Type.String({ description: 'A name for people.' }),
    description: Type.String(),
    adapter_kind: Type.Optional(
      Type.String({ description: 'For a manager: the adapter kind that serves its routes.' }),
    ),
    settings_schema: Type.Record(Type.String(), Type.Unknown(), {
      description:
        "JSON Schema for the kind's `settings`, for the add form (A26). The UI renders it without naming the kind (rule 3).",
    }),
    secrets_schema: Type.Record(Type.String(), Type.Unknown(), {
      description: 'JSON Schema for its `secrets`; an object with no properties when it has none.',
    }),
    default_urls: Type.Array(Type.String(), {
      description: 'Where autodetect looks for it on this machine (A32).',
    }),
  },
  { additionalProperties: false, description: 'A backend kind this daemon can add.' },
);
export type BackendKindInfo = Static<typeof BackendKindInfo>;

export const BackendKindListResponse = Type.Object(
  { kinds: Type.Array(BackendKindInfo) },
  { additionalProperties: false, description: 'The backend kinds this daemon knows.' },
);
export type BackendKindListResponse = Static<typeof BackendKindListResponse>;

// ---------------------------------------------------------------------------
// Detect and propose (A26, A32, L9)
// ---------------------------------------------------------------------------

export const FamilyConfidence = Type.Union(
  [Type.Literal('high'), Type.Literal('medium'), Type.Literal('low'), Type.Literal('none')],
  {
    description:
      '`high`: the file names the family outright. `medium`: a likely reading. `low`: a guess. `none`: no idea, so the generic profile.',
  },
);
export type FamilyConfidence = Static<typeof FamilyConfidence>;

export const FamilyGuess = Type.Object(
  {
    family: Type.String({ description: 'A profile family, or `generic` (backend defaults).' }),
    variant: Type.Optional(Type.String({ description: "One of the family's variants." })),
    confidence: FamilyConfidence,
    reason: Type.String({ description: 'What the guess is based on, for people.' }),
  },
  { additionalProperties: false, description: "A guess at a model's profile, from its name." },
);
export type FamilyGuess = Static<typeof FamilyGuess>;

export const ProposedModel = Type.Object(
  {
    name: Type.String({ description: 'A display name to start from.' }),
    fingerprint: ModelFingerprint,
    manager_ref: Type.Optional(
      Type.String({ description: "The manager's own name for the model." }),
    ),
    existing: Type.Union([ModelId, Type.Null()], {
      description: 'The model this fingerprint already is, when Lantern knows it (A26).',
    }),
    guess: FamilyGuess,
  },
  { additionalProperties: false, description: 'A model a detected backend serves now.' },
);
export type ProposedModel = Static<typeof ProposedModel>;

export const DetectedBackend = Type.Object(
  {
    kind: BackendKindName,
    base_url: Type.String(),
    name: Type.String({ description: 'A name to start from.' }),
    registered: Type.Union([BackendId, Type.Null()], {
      description: 'The backend already registered at this address, if any.',
    }),
    detail: Type.Optional(Type.String({ description: 'What answered, for people.' })),
    models: Type.Array(ProposedModel, {
      description: 'What it serves now. A manager may serve none until a model is loaded.',
    }),
  },
  { additionalProperties: false, description: 'A backend found by a probe: the proposal card.' },
);
export type DetectedBackend = Static<typeof DetectedBackend>;

export const ProbeOutcome = Type.Object(
  {
    kind: BackendKindName,
    url: Type.String({ description: 'The URL probed (by path, L9).' }),
    found: Type.Boolean(),
    detail: Type.Optional(Type.String({ description: 'Why not, when it was not found.' })),
  },
  { additionalProperties: false, description: 'One probe and what came of it.' },
);
export type ProbeOutcome = Static<typeof ProbeOutcome>;

export const DetectBody = Type.Object(
  {
    url: Type.Optional(
      Type.String({
        pattern: '^https?://[^\\s]+$',
        maxLength: 2048,
        description:
          "A URL to test as every kind that can be probed. Absent: each kind's default addresses on this machine.",
      }),
    ),
  },
  { additionalProperties: false, description: 'What to probe.' },
);
export type DetectBody = Static<typeof DetectBody>;

export const DetectResponse = Type.Object(
  {
    candidates: Type.Array(DetectedBackend, { description: 'What answered.' }),
    probes: Type.Array(ProbeOutcome, { description: 'Every probe, found or not.' }),
  },
  { additionalProperties: false, description: 'What autodetect found (A32).' },
);
export type DetectResponse = Static<typeof DetectResponse>;

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export const ConfirmedModel = Type.Object(
  {
    fingerprint: ModelFingerprint,
    display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    family: Type.String({
      minLength: 1,
      description: 'The profile to use: a family from `GET /profiles`, or `generic`.',
    }),
    variant: Type.Optional(Type.String({ minLength: 1 })),
  },
  {
    additionalProperties: false,
    description: "A proposal card's choices for one model, keyed by its fingerprint.",
  },
);
export type ConfirmedModel = Static<typeof ConfirmedModel>;

export const CreateBackendBody = Type.Object(
  {
    kind: BackendKindName,
    base_url: BackendBaseUrl,
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    settings: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "Checked against the kind's `settings_schema`.",
      }),
    ),
    secrets: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: "Checked against the kind's `secrets_schema`. Stored, never answered.",
      }),
    ),
    resource_group: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        description: "Absent: the base URL's host, so backends on one GPU host share a slot (A12).",
      }),
    ),
    concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
    models: Type.Optional(
      Type.Array(ConfirmedModel, {
        description:
          'The proposal card as confirmed. A model the backend serves that is not listed takes the guessed profile.',
      }),
    ),
  },
  { additionalProperties: false, description: 'A backend to add (A26).' },
);
export type CreateBackendBody = Static<typeof CreateBackendBody>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const BackendHealthEvent = Type.Object(
  {
    backend: BackendId,
    health: Type.Union([BackendHealthReport, Type.Null()]),
    routes: Type.Array(
      Type.Object(
        {
          id: RouteId,
          model_id: ModelId,
          status: Type.Union([Type.Literal('active'), Type.Literal('retired')]),
          health: RouteHealth,
        },
        { additionalProperties: false },
      ),
    ),
  },
  {
    additionalProperties: false,
    description:
      "`backend.health`: a backend's health or its routes changed (a model loaded, unloaded or moved).",
  },
);
export type BackendHealthEvent = Static<typeof BackendHealthEvent>;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const unauthenticated = errorResponse('`unauthenticated`: password mode and no valid session.');
const bodyRefusals = {
  400: errorResponse('`bad-request`: the body is not valid JSON.'),
  413: errorResponse("`payload-too-large`: the body is over the daemon's size limit."),
  415: errorResponse('`unsupported-media-type`: the body is not JSON.'),
};
const BackendParams = Type.Object({ id: BackendId }, { additionalProperties: false });

export const ListBackendKindsRoute = {
  method: 'GET',
  path: `${API_V1_PREFIX}/backend-kinds`,
  url: '/backend-kinds',
  schema: {
    operationId: 'listBackendKinds',
    summary: 'Backend kinds and their settings schemas',
    description:
      'The kinds this daemon can add, each with JSON Schema for its settings and secrets, for the add form (A26).',
    tags: ['backends'],
    response: { 200: BackendKindListResponse, 401: unauthenticated, 403: ForbiddenHostOrOrigin },
  },
} satisfies RouteContract;

export const DetectBackendsRoute = {
  method: 'POST',
  path: `${API_V1_PREFIX}/backends/detect`,
  url: '/backends/detect',
  schema: {
    operationId: 'detectBackends',
    summary: 'Look for backends, and propose how to add them',
    description:
      "Runs each kind's probes, by path (L9): an sd-server answers `/sdcpp/v1/capabilities` (port 1234 by default) and Lemonade `/api/v1/health` (13305, or 8000 on older releases). With `url`, tests that address as every kind instead. Each find carries a proposal (A26): the models it serves, with a family guess and its confidence. Nothing is added.",
    tags: ['backends'],
    body: DetectBody,
    response: {
      200: DetectResponse,
      ...bodyRefusals,
      401: unauthenticated,
      403: ForbiddenHostOrOrigin,
      422: errorResponse('`invalid`: the body does not match the schema.'),
    },
  },
} satisfies RouteContract;

export const ListBackendsRoute = {
  method: 'GET',
  path: `${API_V1_PREFIX}/backends`,
  url: '/backends',
  schema: {
    operationId: 'listBackends',
    summary: 'The backend registry',
    tags: ['backends'],
    response: { 200: BackendListResponse, 401: unauthenticated, 403: ForbiddenHostOrOrigin },
  },
} satisfies RouteContract;

export const CreateBackendRoute = {
  method: 'POST',
  path: `${API_V1_PREFIX}/backends`,
  url: '/backends',
  schema: {
    operationId: 'createBackend',
    summary: 'Add a backend',
    description:
      'Registers the backend, records the confirmed models (by fingerprint), then asks it what it serves, waiting a few seconds at most: a backend that is down is still added, and its routes appear when it answers.',
    tags: ['backends'],
    body: CreateBackendBody,
    response: {
      201: BackendSummary,
      ...bodyRefusals,
      401: unauthenticated,
      403: ForbiddenHostOrOrigin,
      409: errorResponse('`conflict`: a backend of this kind is already registered at this URL.'),
      422: errorResponse(
        '`invalid`: the body does not match the schema, the kind is unknown, its settings or secrets do not match its schemas, or a confirmed model names an unknown profile or variant.',
      ),
    },
  },
} satisfies RouteContract;

export const RefreshBackendRoute = {
  method: 'POST',
  path: `${API_V1_PREFIX}/backends/{id}/refresh`,
  url: '/backends/:id/refresh',
  schema: {
    operationId: 'refreshBackend',
    summary: "Ask a backend again what it serves, and re-read its routes' descriptors",
    tags: ['backends'],
    params: BackendParams,
    response: {
      200: BackendSummary,
      ...bodyRefusals,
      401: unauthenticated,
      403: ForbiddenHostOrOrigin,
      404: errorResponse('`not-found`: no backend has this id.'),
      409: errorResponse('`conflict`: the backend is tombstoned.'),
      422: errorResponse('`invalid`: the id is malformed.'),
    },
  },
} satisfies RouteContract;
