// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * POST /api/v1/libraries/{lib}/resolve (`ResolveRoute`): the dry run. The
 * body's shape is checked by the route schema (rule 5); the resolver then
 * checks the request against the model's routes. Its issues point into the
 * request, so they are answered under `/request`; an unknown model or route is
 * an issue at `/model` or `/route`. Nothing is stored or queued.
 *
 * The library is looked up so an unknown one is a 404, as every library route
 * will be; the dry run reads nothing else from it.
 */

import {
  ErrorCodes,
  type ResolveResponse,
  ResolveRoute,
  type ValidationIssue,
} from '@bureaucromancer/lantern-schema';

import { inputSizer } from '../engine/jobs/index.js';
import type { ResolveFailure, Resolution } from '../engine/resolver/index.js';
import { sendError, sendInvalid } from '../http/errors.js';
import type { LanternApp } from '../http/types.js';

/** The issues of a refusal, as pointers into the body. */
export function failureIssues(failure: ResolveFailure, model: string): ValidationIssue[] {
  switch (failure.kind) {
    case 'invalid':
      return failure.issues.map((issue) => ({
        ...issue,
        path: `/request${issue.path}`,
      }));
    case 'unknown_route':
      return [{ path: '/route', message: `is not a route of model ${model}` }];
    case 'no_routes':
      return [{ path: '/model', message: `model ${model} has no routes` }];
  }
}

/** A resolution as the API answers it: field by field, so nothing internal reaches the wire. */
export function toResolveResponse(resolution: Resolution): ResolveResponse {
  return {
    effective: resolution.effective,
    field_report: resolution.field_report,
    route: resolution.route,
    warnings: [...resolution.warnings],
    skipped_routes: [...resolution.skipped_routes],
    descriptor_digest: resolution.descriptor_digest,
    provisional: resolution.provisional,
    ...(resolution.blocked_reason === undefined
      ? {}
      : { blocked_reason: resolution.blocked_reason }),
  };
}

export function registerResolveRoutes(app: LanternApp): void {
  app.route({
    method: ResolveRoute.method,
    url: ResolveRoute.url,
    schema: ResolveRoute.schema,
    // Services are read per request, never at registration.
    handler: async (request, reply) => {
      const { libraries, models, resolver } = request.server.services;
      if (libraries.get(request.params.lib) === undefined) {
        return sendError(reply, 404, ErrorCodes.notFound, 'No such library.');
      }
      const { body } = request;
      const model = models.get(body.model);
      if (model === undefined) {
        return sendInvalid(reply, [{ path: '/model', message: 'is not a known model' }], 'body');
      }
      const outcome = resolver.resolve({
        request: body.request,
        model,
        ...(body.route === undefined ? {} : { route: body.route }),
        inputSize: inputSizer(libraries, request.params.lib),
      });
      if (!outcome.ok) return sendInvalid(reply, failureIssues(outcome.failure, model.id), 'body');
      return toResolveResponse(outcome.resolution);
    },
  });
}
