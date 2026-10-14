// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `/api/v1/session`: the auth state, sign-in and sign-out. All three are public
 * (they are how a browser gets a session in password mode).
 *
 * The session is a `lantern_session` cookie (HttpOnly, SameSite=Strict); the
 * body never carries a token.
 */

import { type Static, Type } from '@sinclair/typebox';

import { errorResponse, ForbiddenHostOrOrigin } from './errors.js';
import { API_V1_PREFIX, noContent, type RouteContract } from './route.js';

export const AuthMode = Type.Union([Type.Literal('none'), Type.Literal('password')], {
  description:
    '`none`: no sign-in (the default, loopback only unless trusted). `password`: one install-wide password.',
});
export type AuthMode = Static<typeof AuthMode>;

export const SessionResponse = Type.Object(
  {
    mode: AuthMode,
    authenticated: Type.Boolean({
      description:
        'Whether this request may use the API: always true in mode `none`; in mode `password`, whether it carries a valid session.',
    }),
  },
  { description: 'The auth mode and whether this request is signed in.' },
);
export type SessionResponse = Static<typeof SessionResponse>;

/**
 * No `minLength`: a policy enforced at sign-in refuses passwords that are
 * genuinely correct and publishes the policy. The cap only bounds the work one
 * request can ask scrypt to do.
 */
export const LoginBody = Type.Object(
  {
    password: Type.String({ maxLength: 512, description: 'The install-wide password.' }),
  },
  { additionalProperties: false, description: 'Sign in with the install-wide password.' },
);
export type LoginBody = Static<typeof LoginBody>;

const SESSION_PATH = `${API_V1_PREFIX}/session`;

export const GetSessionRoute = {
  method: 'GET',
  path: SESSION_PATH,
  url: '/session',
  schema: {
    operationId: 'getSession',
    summary: 'Report the auth mode and whether this request is signed in',
    tags: ['session'],
    response: { 200: SessionResponse, 403: ForbiddenHostOrOrigin },
  },
} satisfies RouteContract;

export const LoginRoute = {
  method: 'POST',
  path: SESSION_PATH,
  url: '/session',
  schema: {
    operationId: 'login',
    summary: 'Sign in',
    description:
      'Sets the `lantern_session` cookie. Every password that does not sign in answers the same 401, so there is nothing to probe.',
    tags: ['session'],
    body: LoginBody,
    response: {
      204: noContent('Signed in; the session cookie is set.'),
      400: errorResponse('`bad-request`: the body is empty or is not valid JSON.'),
      401: errorResponse('`invalid-credentials`: the password is wrong.'),
      403: ForbiddenHostOrOrigin,
      409: errorResponse(
        '`auth-disabled`: auth mode is `none`, so there is nothing to sign in to.',
      ),
      413: errorResponse("`payload-too-large`: the body is over the daemon's size limit."),
      415: errorResponse('`unsupported-media-type`: the body is not JSON.'),
      422: errorResponse('`invalid`: the body does not match the schema.'),
    },
  },
} satisfies RouteContract;

/**
 * No body schema: Fastify validates an absent body, and sign-out sends none.
 * A body that is sent anyway is still parsed, so the body refusals apply.
 */
export const LogoutRoute = {
  method: 'DELETE',
  path: SESSION_PATH,
  url: '/session',
  schema: {
    operationId: 'logout',
    summary: 'Sign out',
    description: 'Clears the session cookie. Succeeds whether or not a session was present.',
    tags: ['session'],
    response: {
      204: noContent('Signed out; the session cookie is cleared.'),
      400: errorResponse(
        '`bad-request`: a body was sent as JSON but is empty or is not valid JSON. Sign-out needs no body.',
      ),
      403: ForbiddenHostOrOrigin,
      413: errorResponse("`payload-too-large`: the body is over the daemon's size limit."),
      415: errorResponse(
        '`unsupported-media-type`: a body was sent and is not JSON. Sign-out needs no body.',
      ),
    },
  },
} satisfies RouteContract;
