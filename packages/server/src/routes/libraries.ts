// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * GET /api/v1/libraries (`ListLibrariesRoute`), mapping the registry's
 * records to summaries. Mapped field by field rather than spread, so the
 * folder path and schema version (daemon-side facts) never reach the wire.
 */

import { ListLibrariesRoute, type LibrarySummary } from '@bureaucromancer/lantern-schema';

import type { LanternApp } from '../http/types.js';
import type { LibraryRecord } from '../store/index.js';

export function toLibrarySummary(record: LibraryRecord): LibrarySummary {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  };
}

export function registerLibrariesRoutes(app: LanternApp): void {
  app.route({
    method: ListLibrariesRoute.method,
    url: ListLibrariesRoute.url,
    schema: ListLibrariesRoute.schema,
    // Services are read per request, never at registration (the OpenAPI
    // emitter registers routes with stub services).
    handler: () => ({ libraries: app.services.libraries.list().map(toLibrarySummary) }),
  });
}
