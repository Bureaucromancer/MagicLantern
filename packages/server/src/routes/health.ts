// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * GET /healthz (lantern-schema `GetHealthRoute`), outside the API prefix and
 * public in every auth mode: a container healthcheck has no cookie. It still
 * passes the Host and Origin checks like every other request.
 */

import { GetHealthRoute } from '@bureaucromancer/lantern-schema';

import type { LanternApp } from '../http/types.js';

export function registerHealthRoutes(app: LanternApp): void {
  app.route({
    method: GetHealthRoute.method,
    url: GetHealthRoute.url,
    schema: GetHealthRoute.schema,
    handler: () => ({ status: 'ok' as const }),
  });
}
