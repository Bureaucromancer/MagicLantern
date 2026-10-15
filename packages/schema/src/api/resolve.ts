// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `POST /api/v1/libraries/{lib}/resolve`: the dry run (plan, "Resolver"). The
 * same code resolves a submit; nothing is queued or stored here. Requires a
 * session in password mode.
 *
 * The answer is provisional (A12): the route's health and the model's
 * identity are checked again at dispatch. The wire request joins the answer
 * when adapters arrive (Phase 5).
 */

import { type Static, Type } from '@sinclair/typebox';

import { GenerationRequest } from '../request/generation-request.js';
import {
  BlockedReason,
  FieldReport,
  ResolutionWarning,
  ResolvedRoute,
  SkippedRoute,
} from '../resolution/resolution.js';
import { errorResponse, ForbiddenHostOrOrigin } from './errors.js';
import { LibraryId } from './libraries.js';
import { API_V1_PREFIX, type RouteContract } from './route.js';

/** A model or route id: printable, no spaces or slashes. */
const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]*$';

function id(description: string) {
  return Type.String({ pattern: ID_PATTERN, maxLength: 128, description });
}

export const ModelId = id('A model id.');
export type ModelId = Static<typeof ModelId>;

export const RouteId = id('A route id: one backend serving one model.');
export type RouteId = Static<typeof RouteId>;

export const LibraryParams = Type.Object(
  { lib: LibraryId },
  { additionalProperties: false, description: 'The library.' },
);
export type LibraryParams = Static<typeof LibraryParams>;

export const ResolveBody = Type.Object(
  {
    request: GenerationRequest,
    model: ModelId,
    route: Type.Optional(
      id(
        "The route to use. Absent: the model's highest-priority healthy route on which the request validates.",
      ),
    ),
  },
  {
    additionalProperties: false,
    description: 'A canonical request, the model to run it on, and optionally the route.',
  },
);
export type ResolveBody = Static<typeof ResolveBody>;

export const ResolveResponse = Type.Object(
  {
    effective: Type.Object(GenerationRequest.properties, {
      additionalProperties: false,
      description:
        'The request as it would run: a valid `GenerationRequest` with every value that affects pixels written out, defaults and the concrete seed included. Submitting it reproduces the job.',
    }),
    field_report: FieldReport,
    route: ResolvedRoute,
    warnings: Type.Array(ResolutionWarning),
    skipped_routes: Type.Array(SkippedRoute),
    descriptor_digest: Type.String({
      description: "The digest of the route's effective descriptor, as `route_snapshot` keeps it.",
    }),
    provisional: Type.Boolean({
      description:
        "Always true here: the route's health and the model's identity are checked again at dispatch (A12).",
    }),
    blocked_reason: Type.Optional(BlockedReason),
  },
  { additionalProperties: false, description: 'What the request resolves to.' },
);
export type ResolveResponse = Static<typeof ResolveResponse>;

export const ResolveRoute = {
  method: 'POST',
  path: `${API_V1_PREFIX}/libraries/{lib}/resolve`,
  url: '/libraries/:lib/resolve',
  schema: {
    operationId: 'resolveRequest',
    summary: 'Resolve a generation request without running it',
    description:
      'The dry run: validates the request against the model\'s routes, chooses a route, fills every default by precedence (request > preset > model overrides > profile > route default), draws a seed for `"random"`, and reports what became of each field. A value the request sets is never changed: one the route can\'t take is a 422 whose issue may carry a `suggested` value.',
    tags: ['generation'],
    params: LibraryParams,
    body: ResolveBody,
    response: {
      200: ResolveResponse,
      400: errorResponse('`bad-request`: the body is empty or is not valid JSON.'),
      401: errorResponse('`unauthenticated`: password mode and no valid session.'),
      403: ForbiddenHostOrOrigin,
      404: errorResponse('`not-found`: no library has this id.'),
      413: errorResponse("`payload-too-large`: the body is over the daemon's size limit."),
      415: errorResponse('`unsupported-media-type`: the body is not JSON.'),
      422: errorResponse(
        '`invalid`: the body does not match the schema, the library id is malformed, the model or route is unknown, or the request does not validate on any of its routes. Each issue names the field (`/request/sampling/steps`) and may carry a `suggested` value.',
      ),
    },
  },
} satisfies RouteContract;

/**
 * A contract path with its `{name}` parameters filled in, each value
 * percent-encoded as one path segment.
 *
 * @param path a contract path, e.g. `/api/v1/libraries/{lib}/resolve`
 * @param params a value for every parameter
 * @throws Error when a parameter has no value
 */
export function fillPath(path: string, params: Readonly<Record<string, string>>): string {
  return path.replaceAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`No value for the path parameter \`${name}\`.`);
    return encodeURIComponent(value);
  });
}
