// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * What a refused request becomes on the client side. Code branches on `code`
 * (the envelope's `error`), never on `message`, which is prose and may change.
 */

import type { ValidationIssue } from '@bureaucromancer/lantern-schema';

/** Used when an answer carries no envelope (a proxy's HTML error page, say). */
export const UNKNOWN_ERROR_CODE = 'unknown';

/** Used when a successful answer is not the JSON the contract promises. */
export const INVALID_RESPONSE_CODE = 'invalid-response';

export class LanternApiError extends Error {
  /** The HTTP status. */
  readonly status: number;
  /** The envelope's `error` code, e.g. `unauthenticated`; see the constants above for the rest. */
  readonly code: string;
  /**
   * Present on `invalid` (422) answers: one entry per field at fault.
   * `declare`d so the field is absent rather than `undefined` when there are
   * none: class-field semantics would otherwise define it on every instance.
   */
  declare readonly issues?: readonly ValidationIssue[];

  constructor(status: number, code: string, message: string, issues?: readonly ValidationIssue[]) {
    super(message);
    this.name = 'LanternApiError';
    this.status = status;
    this.code = code;
    if (issues !== undefined) this.issues = issues;
  }
}

/** The error code of a failure, or null when it is not an API refusal (a network error, an abort). */
export function errorCode(failure: unknown): string | null {
  return failure instanceof LanternApiError ? failure.code : null;
}

function isIssue(value: unknown): value is ValidationIssue {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['path'] === 'string' && typeof candidate['message'] === 'string';
}

/**
 * Builds the error for a non-2xx answer from whatever body arrived. Tolerant
 * by design: every field is checked, because a malformed `issues` would
 * otherwise reach a screen as `[object Object]`.
 */
export function refusalFrom(status: number, payload: unknown): LanternApiError {
  const body =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  const code = typeof body['error'] === 'string' ? body['error'] : UNKNOWN_ERROR_CODE;
  const message =
    typeof body['message'] === 'string'
      ? body['message']
      : `The Lantern daemon answered with status ${String(status)}.`;
  const rawIssues = body['issues'];
  const issues =
    Array.isArray(rawIssues) && rawIssues.every(isIssue)
      ? rawIssues.map(({ path, message: text, suggested }) => ({
          path,
          message: text,
          ...(suggested === undefined ? {} : { suggested }),
        }))
      : undefined;
  return new LanternApiError(status, code, message, issues);
}
