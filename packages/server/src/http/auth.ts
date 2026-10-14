// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The session gate for the API plugin (`/api/v1`): in password mode, deny by
 * default unless the matched route (`request.routeOptions.url`, never the raw
 * URL) is public under the request's method (the session routes) or the
 * request carries a valid `lantern_session` cookie. One 401 `unauthenticated`
 * answer for every failure. Static app files and `/healthz` are outside the
 * plugin and never gated: the shell must load without a session, since a
 * SameSite=Strict cookie is absent on a navigation from another site.
 *
 * Being a hook on the plugin, it runs for every route registered in it however
 * the URL was spelled (`/%61pi/v1/info` is matched, and gated, as
 * `/api/v1/info`); an unmatched URL reaches no handler at all.
 */

// Brings in @fastify/cookie's `request.cookies`.
import type {} from '@fastify/cookie';
import {
  ErrorCodes,
  GetSessionRoute,
  LoginRoute,
  LogoutRoute,
} from '@bureaucromancer/lantern-schema';
import type { FastifyRequest } from 'fastify';

import { sendError } from './errors.js';
import type { LanternApp } from './types.js';

/** `METHOD /pattern`, how the gate names a route. */
export function routeKey(method: string, pattern: string): string {
  return `${method.toUpperCase()} ${pattern}`;
}

/**
 * Routes reachable without a session, how a browser gets one, by method as
 * well as pattern: another method added on the session path (changing the
 * password, say) is gated unless it is listed here too.
 */
export const PUBLIC_API_ROUTES: ReadonlySet<string> = new Set(
  [GetSessionRoute, LoginRoute, LogoutRoute].map((route) => routeKey(route.method, route.path)),
);

/** Whether the matched route is public. HEAD is the GET route's own (Fastify adds one per GET). */
export function isPublicApiRoute(
  request: Pick<FastifyRequest, 'method' | 'routeOptions'>,
): boolean {
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  return PUBLIC_API_ROUTES.has(routeKey(method, request.routeOptions.url ?? ''));
}

export function registerAuthGate(api: LanternApp): void {
  api.addHook('onRequest', async (request, reply) => {
    const { auth } = request.server.services;
    if (auth.mode() === 'none') return undefined;
    if (isPublicApiRoute(request)) return undefined;
    if (auth.readSession(request.cookies[auth.cookie.name]) !== null) return undefined;
    return sendError(reply, 401, ErrorCodes.unauthenticated, 'Sign in first.');
  });
}
