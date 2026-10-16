// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Models and profiles: the models with their profiles and routes, one model
 * with each route's effective descriptor (what the form renders), changing a
 * model's name or profile (A26), and the profiles for the picker.
 */

import {
  ErrorCodes,
  GetModelRoute,
  ListModelsRoute,
  ListProfilesRoute,
  PatchModelRoute,
  type ModelDetail,
  type ModelSummary,
  type ProfileSummary,
} from '@bureaucromancer/lantern-schema';

import { GENERIC_FAMILY, type ModelView } from '../engine/backends/index.js';
import type { ProfileRegistry } from '../engine/profiles/index.js';
import { sendError, sendInvalid } from '../http/errors.js';
import type { LanternApp } from '../http/types.js';

function profileRef(view: ModelView): ModelSummary['profile'] {
  if (view.profile === null) return null;
  return {
    family: view.profile.family,
    name: view.profile.name,
    ...(view.profile.variant === undefined ? {} : { variant: view.profile.variant }),
  };
}

function routeSummary(route: ModelView['routes'][number]): ModelSummary['routes'][number] {
  return {
    id: route.id,
    backend_id: route.backendId,
    backend_name: route.backendName,
    adapter_kind: route.adapterKind,
    status: route.status,
    health: route.health,
    priority: route.priority,
    modes: [...route.modes],
  };
}

export function toModelSummary(view: ModelView): ModelSummary {
  return {
    id: view.id,
    display_name: view.displayName,
    family: view.family,
    variant: view.variant,
    profile: profileRef(view),
    fingerprint: view.fingerprint,
    modes: [...view.modes],
    routes: view.routes.map(routeSummary),
  };
}

export function toModelDetail(view: ModelView): ModelDetail {
  return {
    ...toModelSummary(view),
    routes: view.routes.map((route) => ({
      ...routeSummary(route),
      descriptor: route.descriptor,
      descriptor_digest: route.descriptorDigest,
    })),
  };
}

/** Every loaded profile: generic first, then by name. */
export function profileSummaries(profiles: ProfileRegistry): ProfileSummary[] {
  return profiles
    .families()
    .map((profile) => ({
      family: profile.family,
      name: profile.name,
      modes: profiles.modes(profile.family),
      default_variant: profile.default_variant ?? null,
      variants: (profile.variants ?? []).map((variant) => ({
        id: variant.id,
        name: variant.name,
        modes: profiles.modes(profile.family, variant.id),
      })),
    }))
    .sort(
      (a, b) =>
        Number(b.family === GENERIC_FAMILY) - Number(a.family === GENERIC_FAMILY) ||
        a.name.localeCompare(b.name),
    );
}

export function registerModelRoutes(app: LanternApp): void {
  app.route({
    method: ListModelsRoute.method,
    url: ListModelsRoute.url,
    schema: ListModelsRoute.schema,
    // Services are read per request, never at registration.
    handler: (request) => ({
      models: request.server.services.backends.modelViews().map(toModelSummary),
    }),
  });

  app.route({
    method: GetModelRoute.method,
    url: GetModelRoute.url,
    schema: GetModelRoute.schema,
    handler: async (request, reply) => {
      const view = request.server.services.backends.modelView(request.params.id);
      if (view === undefined)
        return await sendError(reply, 404, ErrorCodes.notFound, 'No such model.');
      return toModelDetail(view);
    },
  });

  app.route({
    method: PatchModelRoute.method,
    url: PatchModelRoute.url,
    schema: PatchModelRoute.schema,
    handler: async (request, reply) => {
      const { backends } = request.server.services;
      const outcome = backends.updateModel(request.params.id, request.body);
      if (!outcome.ok) {
        switch (outcome.kind) {
          case 'missing':
            return await sendError(reply, 404, ErrorCodes.notFound, 'No such model.');
          case 'fixed':
            return await sendError(
              reply,
              409,
              ErrorCodes.conflict,
              'The development model lives in memory and cannot be changed.',
            );
          case 'invalid':
            return await sendInvalid(reply, outcome.issues, 'body');
        }
      }
      const view = backends.modelView(request.params.id);
      if (view === undefined)
        return await sendError(reply, 404, ErrorCodes.notFound, 'No such model.');
      return toModelDetail(view);
    },
  });

  app.route({
    method: ListProfilesRoute.method,
    url: ListProfilesRoute.url,
    schema: ListProfilesRoute.schema,
    handler: (request) => ({
      profiles: profileSummaries(request.server.services.backends.profiles),
    }),
  });
}
