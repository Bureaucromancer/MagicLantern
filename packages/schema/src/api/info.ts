// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/** `GET /api/v1/info`: what is answering. Requires a session in password mode. */

import { type Static, Type } from '@sinclair/typebox';

import { errorResponse, ForbiddenHostOrOrigin } from './errors.js';
import { API_V1_PREFIX, type RouteContract } from './route.js';

export const InfoResponse = Type.Object(
  {
    name: Type.Literal('lantern', { description: 'Always `lantern`.' }),
    version: Type.String({ description: "The daemon's version." }),
    apiVersion: Type.Literal('v1', { description: 'The API version this daemon serves.' }),
  },
  { description: 'The daemon and API version.' },
);
export type InfoResponse = Static<typeof InfoResponse>;

export const GetInfoRoute = {
  method: 'GET',
  path: `${API_V1_PREFIX}/info`,
  url: '/info',
  schema: {
    operationId: 'getInfo',
    summary: 'Daemon and API version',
    tags: ['info'],
    response: {
      200: InfoResponse,
      401: errorResponse('`unauthenticated`: password mode and no valid session.'),
      403: ForbiddenHostOrOrigin,
    },
  },
} satisfies RouteContract;
