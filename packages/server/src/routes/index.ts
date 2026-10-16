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
import { registerAssetRoutes } from './assets.js';
import { registerEventRoutes } from './events.js';
import { registerInfoRoutes } from './info.js';
import { registerJobRoutes } from './jobs.js';
import { registerLibrariesRoutes } from './libraries.js';
import { registerResolveRoutes } from './resolve.js';
import { registerSessionRoutes } from './session.js';

/** What route registration may know of the config: values, never the data directory. */
export interface ApiRouteOptions {
  readonly maxUploadMb: number;
}

export function registerApiRoutes(api: LanternApp, options: ApiRouteOptions): void {
  registerSessionRoutes(api);
  registerInfoRoutes(api);
  registerLibrariesRoutes(api);
  registerAssetRoutes(api, { maxUploadMb: options.maxUploadMb });
  registerResolveRoutes(api);
  registerJobRoutes(api);
  registerEventRoutes(api);
  registerOpenApiRoute(api);
}
