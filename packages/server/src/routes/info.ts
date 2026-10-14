// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/** GET /api/v1/info (`GetInfoRoute`): what is answering. Behind the auth gate. */

import { GetInfoRoute } from '@bureaucromancer/lantern-schema';

import type { LanternApp } from '../http/types.js';

export function registerInfoRoutes(api: LanternApp): void {
  api.route({
    method: GetInfoRoute.method,
    url: GetInfoRoute.url,
    schema: GetInfoRoute.schema,
    handler: (request) => ({
      name: 'lantern' as const,
      version: request.server.services.version,
      apiVersion: 'v1' as const,
    }),
  });
}
