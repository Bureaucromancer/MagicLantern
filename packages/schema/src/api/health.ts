// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/** `GET /healthz`: liveness, outside `/api/v1` and public in every auth mode. */

import { type Static, Type } from '@sinclair/typebox';

import { ForbiddenHostOrOrigin } from './errors.js';
import type { RouteContract } from './route.js';

export const HealthResponse = Type.Object(
  { status: Type.Literal('ok', { description: 'Always `ok` while the daemon answers.' }) },
  { description: 'The daemon is up.' },
);
export type HealthResponse = Static<typeof HealthResponse>;

export const GetHealthRoute = {
  method: 'GET',
  path: '/healthz',
  url: '/healthz',
  schema: {
    operationId: 'getHealth',
    summary: 'Liveness check',
    tags: ['health'],
    response: { 200: HealthResponse, 403: ForbiddenHostOrOrigin },
  },
} satisfies RouteContract;
