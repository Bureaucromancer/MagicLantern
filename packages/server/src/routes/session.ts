// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * GET, POST and DELETE /api/v1/session (`GetSessionRoute`, `LoginRoute`,
 * `LogoutRoute`): public, since they are how a browser gets a session.
 *
 * Sign-in answers one 401 for every failure and measures nothing about the
 * password it is given (no minimum at sign-in: that refuses correct passwords
 * and publishes the policy). Each failure is logged as a warning with the
 * client's address; the password checks themselves are limited in number at
 * once by the auth service. The cookie is HttpOnly, SameSite=Strict, Path=/,
 * and Secure only when `auth.cookieSecure` says TLS is in front: a Secure
 * cookie over plain HTTP is dropped and sign-in would appear to do nothing.
 */

import {
  ErrorCodes,
  GetSessionRoute,
  LoginRoute,
  LogoutRoute,
} from '@bureaucromancer/lantern-schema';
import type { FastifyReply } from 'fastify';

import { sendError } from '../http/errors.js';
import type { LanternApp } from '../http/types.js';
import type { AuthService } from '../services.js';

function cookieOptions(auth: AuthService) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: auth.cookie.secure,
  } as const;
}

function clearSessionCookie(reply: FastifyReply, auth: AuthService): void {
  void reply.clearCookie(auth.cookie.name, cookieOptions(auth));
}

export function registerSessionRoutes(api: LanternApp): void {
  api.route({
    method: GetSessionRoute.method,
    url: GetSessionRoute.url,
    schema: GetSessionRoute.schema,
    handler: (request) => {
      const { auth } = request.server.services;
      const mode = auth.mode();
      const authenticated =
        mode === 'none' || auth.readSession(request.cookies[auth.cookie.name]) !== null;
      return { mode, authenticated };
    },
  });

  api.route({
    method: LoginRoute.method,
    url: LoginRoute.url,
    schema: LoginRoute.schema,
    handler: async (request, reply) => {
      const { auth } = request.server.services;
      if (auth.mode() === 'none') {
        return sendError(
          reply,
          409,
          ErrorCodes.authDisabled,
          'Auth mode is none, so there is nothing to sign in to.',
        );
      }
      if (!(await auth.verifyPassword(request.body.password))) {
        // For the person reading the log, or fail2ban: who, never what was tried.
        request.log.warn(
          { event: 'auth.sign-in-failed', ip: request.ip },
          `Refused a sign-in from ${request.ip} with a wrong password`,
        );
        return sendError(reply, 401, ErrorCodes.invalidCredentials, 'That password is not right.');
      }
      const session = auth.issueSession();
      void reply.setCookie(auth.cookie.name, session.token, {
        ...cookieOptions(auth),
        maxAge: auth.cookie.maxAgeSeconds,
      });
      return reply.code(204).send(null);
    },
  });

  api.route({
    method: LogoutRoute.method,
    url: LogoutRoute.url,
    schema: LogoutRoute.schema,
    handler: async (request, reply) => {
      clearSessionCookie(reply, request.server.services.auth);
      return reply.code(204).send(null);
    },
  });
}
