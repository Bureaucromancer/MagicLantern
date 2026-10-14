// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Everything under `/api/v1`, registered inside the prefixed API plugin and so
 * behind its auth gate. `/healthz` is registered at the root by app.ts.
 *
 * Registration only: no route module reads `app.services` until a request
 * arrives, so the OpenAPI emitter can build the app with stub services.
 */

import { registerOpenApiRoute } from '../http/openapi.js';
import type { LanternApp } from '../http/types.js';
import { registerInfoRoutes } from './info.js';
import { registerLibrariesRoutes } from './libraries.js';
import { registerSessionRoutes } from './session.js';

export function registerApiRoutes(api: LanternApp): void {
  registerSessionRoutes(api);
  registerInfoRoutes(api);
  registerLibrariesRoutes(api);
  registerOpenApiRoute(api);
}
