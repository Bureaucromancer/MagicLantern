// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The error envelope every non-2xx JSON answer uses.
 *
 * `error` is the contract (a stable kebab-case code clients branch on);
 * `message` is fallback prose for people. 5xx bodies are always generic
 * (`internal` / "Internal error"): details go to the log, never the wire.
 */

import { type Static, type TObject, Type } from '@sinclair/typebox';

/** The codes the daemon answers with. Newer daemons may add more. */
export const ErrorCodes = {
  /** 422: the request failed schema validation; `issues` names each field. */
  invalid: 'invalid',
  /**
   * 404: no such API route or resource. Also a known path under a method it
   * does not serve: the daemon answers 404 there, never 405.
   */
  notFound: 'not-found',
  /** 415: a state-changing request with a body that is not application/json. */
  unsupportedMediaType: 'unsupported-media-type',
  /** 403: the Host header names no allowed host (DNS-rebinding defence). */
  forbiddenHost: 'forbidden-host',
  /** 403: the Origin header names no allowed origin (cross-site defence). */
  forbiddenOrigin: 'forbidden-origin',
  /** 401: password mode and no valid session. */
  unauthenticated: 'unauthenticated',
  /** 401: sign-in failed, for any reason (one answer, so there is nothing to probe). */
  invalidCredentials: 'invalid-credentials',
  /** 409: sign-in attempted while auth mode is none. */
  authDisabled: 'auth-disabled',
  /** 400: the framework rejected the request (malformed or empty JSON body, and other 4xx it raises). */
  badRequest: 'bad-request',
  /** 403: a request for a path the daemon will not serve (a non-canonical static path). */
  forbidden: 'forbidden',
  /** 413: the body is over the daemon's size limit. */
  payloadTooLarge: 'payload-too-large',
  /** 409: the change would clash with what is there, such as a second library with the same name. */
  conflict: 'conflict',
  /** 409: the library was written by a newer Lantern and is open read-only. */
  libraryReadOnly: 'library-read-only',
  /** 409: the library could not be opened (see its `reason` in the library list). */
  libraryUnavailable: 'library-unavailable',
  /** 410: the asset's bytes were deleted; its record and provenance remain (A23). */
  gone: 'gone',
  /** 503: the daemon is shutting down; try again once it is back. */
  unavailable: 'unavailable',
  /** 500: anything unexpected; the cause is only in the daemon's log. */
  internal: 'internal',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** Kebab-case, so a code reads the same in a log line, a URL and a test. */
export const ERROR_CODE_PATTERN = '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$';

export const ValidationIssue = Type.Object(
  {
    path: Type.String({
      description:
        "The field at fault as a JSON pointer (RFC 6901, e.g. `/password`; `~` and `/` in a key are written `~0` and `~1`); for an unknown field, the pointer to that field; `''` for the whole body.",
    }),
    message: Type.String({ description: 'What is wrong with it, in prose.' }),
    suggested: Type.Optional(
      Type.Unknown({
        description:
          'A value that would be accepted, where there is an obvious one (the nearest in range, a listed value). The daemon never applies it: it never changes a value the client set (A3).',
      }),
    ),
  },
  { description: 'One validation failure.' },
);
export type ValidationIssue = Static<typeof ValidationIssue>;

const errorProperties = {
  error: Type.String({
    pattern: ERROR_CODE_PATTERN,
    description: 'A stable kebab-case code, e.g. `unauthenticated`. Clients branch on this.',
  }),
  message: Type.String({ description: 'Fallback prose for people; never parse it.' }),
  issues: Type.Optional(
    Type.Array(ValidationIssue, { description: 'Present on `invalid` (422) answers.' }),
  ),
};

/**
 * The envelope as a response schema, with a status-specific description
 * (OpenAPI shows one per status, and an undescribed response reads as
 * "Default Response").
 */
export function errorResponse(description: string): TObject<typeof errorProperties> {
  return Type.Object(errorProperties, { description });
}

/**
 * The 403 the daemon's Host and Origin checks answer. They run on every
 * request before anything else (the auth gate included), so every route
 * contract lists it.
 */
export const ForbiddenHostOrOrigin = errorResponse(
  '`forbidden-host`: the Host header names a host the daemon does not answer to (see ' +
    '`allowedHosts`). `forbidden-origin`: the request comes from a web page whose origin is ' +
    'not allowed (see `allowedOrigins`).',
);

/** The envelope itself, for clients and tests. */
export const ErrorBody = errorResponse('An error.');
export type ErrorBody = Static<typeof ErrorBody>;
