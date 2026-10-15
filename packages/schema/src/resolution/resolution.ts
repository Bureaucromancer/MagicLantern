// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * What the resolver says about a request (plan, "Resolver" and "Provenance"):
 * the field report, warnings, the route it chose and the routes it passed
 * over. Stored with a job (`job_payloads.field_report`) and returned by the
 * dry run (`POST /api/v1/libraries/{lib}/resolve`) and, later, by submit.
 *
 * Route health follows the adapter interface's `HealthReport` (L2): whether a
 * route is reachable and whether its model is loaded are kept apart, because
 * a cold route under a manager such as orchd is healthy and loads on demand.
 */

import { type Static, Type } from '@sinclair/typebox';

import { ValidationIssue } from '../api/errors.js';
import { CapabilityState } from '../descriptor/descriptor.js';

// ---------------------------------------------------------------------------
// Field report
// ---------------------------------------------------------------------------

export const FieldSource = Type.Union(
  [
    Type.Literal('request'),
    Type.Literal('preset'),
    Type.Literal('model'),
    Type.Literal('profile'),
    Type.Literal('descriptor'),
    Type.Literal('drawn'),
    Type.Literal('builtin'),
  ],
  {
    description:
      "Where the value came from, by precedence (A3): `request`, then `preset`, `model` (the model's overrides), `profile`, `descriptor` (the route's default). `drawn`: a seed Lantern drew for `\"random\"`. `builtin`: Lantern's own fallback where nothing else gives one (`count` is 1).",
  },
);
export type FieldSource = Static<typeof FieldSource>;
export const FIELD_SOURCES: readonly FieldSource[] = [
  'request',
  'preset',
  'model',
  'profile',
  'descriptor',
  'drawn',
  'builtin',
];

export const FieldReportEntry = Type.Object(
  {
    field: Type.String({
      description:
        'The field path in the request grammar (`sampling.steps`, `inputs.ref.weight`, `extensions.comfy`), for looking the field up in a descriptor.',
    }),
    state: CapabilityState,
    source: FieldSource,
    requested: Type.Optional(
      Type.Unknown({ description: 'The value the request gave, when it gave one.' }),
    ),
    used: Type.Optional(
      Type.Unknown({
        description: 'The value in `effective`. Absent when the route ignores the field.',
      }),
    ),
    reason: Type.Optional(
      Type.String({ description: 'Why the field is emulated or ignored, for people.' }),
    ),
  },
  {
    additionalProperties: false,
    description: 'What became of one value (rule 4: no silent drops).',
  },
);
export type FieldReportEntry = Static<typeof FieldReportEntry>;

export const FieldReport = Type.Record(Type.String(), FieldReportEntry, {
  description:
    'One entry per leaf of `effective`, keyed by its JSON pointer (`/sampling/steps`, `/inputs/1/weight`, `/extensions/comfy`).',
});
export type FieldReport = Static<typeof FieldReport>;

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

export const ResolutionWarning = Type.Object(
  {
    code: Type.String({
      pattern: '^[a-z][a-z0-9_]*$',
      description: 'A stable code clients can key on, e.g. `negative_prompt_ignored`.',
    }),
    message: Type.String({ description: 'The advice, for people.' }),
    source: Type.Union([Type.Literal('profile'), Type.Literal('resolver')], {
      description:
        "`profile`: one of the model profile's warnings. `resolver`: the resolver's own.",
    }),
    paths: Type.Optional(
      Type.Array(Type.String(), { description: 'The field paths the warning is about.' }),
    ),
  },
  { additionalProperties: false, description: 'Advice about the resolved request.' },
);
export type ResolutionWarning = Static<typeof ResolutionWarning>;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const RouteHealthStatus = Type.Union(
  [Type.Literal('ok'), Type.Literal('degraded'), Type.Literal('down')],
  { description: 'Whether the route is reachable. Only `down` makes it unhealthy.' },
);
export type RouteHealthStatus = Static<typeof RouteHealthStatus>;

export const LoadState = Type.Union(
  [Type.Literal('loaded'), Type.Literal('cold'), Type.Literal('unknown')],
  {
    description:
      'Whether the model is loaded. Not health (L2): a cold route under a manager loads on demand.',
  },
);
export type LoadState = Static<typeof LoadState>;

export const RouteHealth = Type.Object(
  {
    status: RouteHealthStatus,
    load_state: LoadState,
    detail: Type.Optional(Type.String({ description: 'More about the status, for people.' })),
  },
  { additionalProperties: false, description: "A route's health and load state (L2)." },
);
export type RouteHealth = Static<typeof RouteHealth>;

export const ResolvedRoute = Type.Object(
  {
    id: Type.String({ description: 'The route id.' }),
    backend_kind: Type.String({ description: 'The backend kind, e.g. `sdcpp`.' }),
    priority: Type.Number({ description: 'Higher is tried first.' }),
    health: RouteHealth,
  },
  { additionalProperties: false, description: 'The route a request resolved to.' },
);
export type ResolvedRoute = Static<typeof ResolvedRoute>;

export const SkipReason = Type.Union(
  [Type.Literal('down'), Type.Literal('mode_unsupported'), Type.Literal('invalid')],
  {
    description:
      '`down`: unreachable (a cold route is not skipped). `mode_unsupported`: the route does not serve the mode. `invalid`: the request does not validate on the route; `issues` says why.',
  },
);
export type SkipReason = Static<typeof SkipReason>;

export const SkippedRoute = Type.Object(
  {
    route: Type.String({ description: 'The route id.' }),
    reason: SkipReason,
    issues: Type.Optional(
      Type.Array(ValidationIssue, {
        description: 'Present on `invalid`: pointers into the request.',
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      'A route the resolver passed over before the one it chose. Routes ranked below the chosen one are not tried, so they are not listed.',
  },
);
export type SkippedRoute = Static<typeof SkippedRoute>;

export const BlockedReason = Type.Object(
  {
    code: Type.String({
      pattern: '^[a-z][a-z0-9_]*$',
      description:
        '`routes_down`, `route_missing`, `identity_changed` or `request_invalid`; later `backend_rejected` (L6).',
    }),
    detail: Type.Optional(Type.String()),
  },
  {
    additionalProperties: false,
    description: 'Why a job could not be dispatched now; it stays queued (A12, L6).',
  },
);
export type BlockedReason = Static<typeof BlockedReason>;
