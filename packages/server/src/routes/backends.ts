// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Backends (A26, A32): the kinds and their settings schemas, autodetect,
 * the registry, adding one, and refreshing one. Views are mapped to the wire
 * field by field, so secrets (and anything else daemon-side) never reach it.
 */

import {
  CreateBackendRoute,
  DetectBackendsRoute,
  ErrorCodes,
  ListBackendKindsRoute,
  ListBackendsRoute,
  RefreshBackendRoute,
  type BackendSummary,
} from '@bureaucromancer/lantern-schema';
import type { FastifyReply } from 'fastify';

import { detectBackends, kindInfo, type BackendView } from '../engine/backends/index.js';
import { sendError, sendInvalid } from '../http/errors.js';
import type { LanternApp } from '../http/types.js';

function timestamp(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export function toBackendSummary(view: BackendView): BackendSummary {
  return {
    id: view.id,
    kind: view.kind,
    role: view.role,
    name: view.name,
    base_url: view.baseUrl,
    source: view.source,
    status: view.status,
    resource_group: view.resourceGroup,
    concurrency: view.concurrency,
    settings: { ...view.settings },
    secrets: [...view.secrets],
    health: view.health,
    last_seen: timestamp(view.lastSeen),
    routes: view.routes.map((route) => ({
      id: route.id,
      model_id: route.modelId,
      model_name: route.modelName,
      adapter_kind: route.adapterKind,
      manager_ref: route.managerRef,
      base_url: route.baseUrl,
      status: route.status,
      health: route.health,
      priority: route.priority,
      descriptor_fetched_at: timestamp(route.descriptorFetchedAt),
    })),
  };
}

function backendNotFound(reply: FastifyReply): FastifyReply {
  return sendError(reply, 404, ErrorCodes.notFound, 'No such backend.');
}

export function registerBackendRoutes(app: LanternApp): void {
  app.route({
    method: ListBackendKindsRoute.method,
    url: ListBackendKindsRoute.url,
    schema: ListBackendKindsRoute.schema,
    // Services are read per request, never at registration.
    handler: (request) => ({
      kinds: request.server.services.backends.kinds.list().map(kindInfo),
    }),
  });

  app.route({
    method: DetectBackendsRoute.method,
    url: DetectBackendsRoute.url,
    schema: DetectBackendsRoute.schema,
    handler: async (request) =>
      await detectBackends(
        request.server.services.backends,
        request.body.url === undefined ? {} : { url: request.body.url },
      ),
  });

  app.route({
    method: ListBackendsRoute.method,
    url: ListBackendsRoute.url,
    schema: ListBackendsRoute.schema,
    handler: (request) => ({
      backends: request.server.services.backends.backendViews().map(toBackendSummary),
    }),
  });

  app.route({
    method: CreateBackendRoute.method,
    url: CreateBackendRoute.url,
    schema: CreateBackendRoute.schema,
    handler: async (request, reply) => {
      const { backends } = request.server.services;
      const outcome = await backends.create(request.body);
      if (!outcome.ok) {
        return outcome.kind === 'invalid'
          ? sendInvalid(reply, outcome.issues, 'body')
          : sendError(reply, 409, ErrorCodes.conflict, outcome.message);
      }
      const view = backends.backendView(outcome.id);
      if (view === undefined)
        throw new Error(`The backend ${outcome.id} vanished as it was added.`);
      return await reply.code(201).send(toBackendSummary(view));
    },
  });

  app.route({
    method: RefreshBackendRoute.method,
    url: RefreshBackendRoute.url,
    schema: RefreshBackendRoute.schema,
    handler: async (request, reply) => {
      const { backends } = request.server.services;
      const outcome = await backends.refreshNow(request.params.id);
      if (outcome === 'missing') return backendNotFound(reply);
      if (outcome === 'tombstoned') {
        return sendError(
          reply,
          409,
          ErrorCodes.conflict,
          'The backend was removed from lantern.json and serves nothing.',
        );
      }
      const view = backends.backendView(request.params.id);
      return view === undefined ? backendNotFound(reply) : toBackendSummary(view);
    },
  });
}
