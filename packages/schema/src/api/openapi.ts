// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `GET /api/v1/openapi.json`: the spec generated from these route schemas.
 * Hidden from the spec itself; requires a session in password mode.
 */

import { API_V1_PREFIX, type RouteContract } from './route.js';

export const GetOpenApiRoute = {
  method: 'GET',
  path: `${API_V1_PREFIX}/openapi.json`,
  url: '/openapi.json',
  schema: { hide: true },
} satisfies RouteContract;
