// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The `lantern_session` cookie: a signed, stateless token (no session table).
 *
 * `base64url(JSON payload) "." base64url(HMAC-SHA256)`, where the payload
 * carries a version, issued-at, expiry and a fingerprint of the password
 * record it was issued against. `lantern set-password` writes a new record
 * (new salt, new hash), so every existing cookie stops verifying: the fix for
 * the stateless-cookie gap StoryEngine documents ("a password change does not
 * end them") without a revocation list.
 *
 * Every failure is null. A bad signature, a mangled body, an expired session
 * and a stale fingerprint all get the same answer, so there is nothing to probe.
 */

import { createHmac } from 'node:crypto';

import type { SessionClaims } from '../services.js';
import type { PasswordRecord } from '../store/secrets.js';
import { secretsMatch } from './password.js';

export const SESSION_COOKIE_NAME = 'lantern_session';

/** Thirty days: a household tablet is not a sign-in prompt every morning. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const TOKEN_VERSION = 1;

/** Distinct HMAC inputs per use, so a signature can never double as a fingerprint. */
const SIGN_CONTEXT = 'lantern-session-v1\0';
const FINGERPRINT_CONTEXT = 'lantern-password-record-v1\0';

function hmac(key: string, context: string, value: string): string {
  return createHmac('sha256', key).update(context).update(value).digest('base64url');
}

/** Identifies one password record under one session key, without revealing the hash. */
export function passwordFingerprint(sessionKey: string, record: PasswordRecord): string {
  const { alg, N, r, p, keyLen, salt, hash } = record;
  return hmac(sessionKey, FINGERPRINT_CONTEXT, [alg, N, r, p, keyLen, salt, hash].join(':'));
}

interface Payload {
  readonly v: number;
  readonly iat: number;
  readonly exp: number;
  readonly pw: string;
}

/** Signs a payload as a token. Exported so tests can sign shapes {@link signSession} never would. */
export function signPayload(sessionKey: string, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${hmac(sessionKey, SIGN_CONTEXT, body)}`;
}

export function signSession(sessionKey: string, fingerprint: string, now: number): string {
  const payload: Payload = {
    v: TOKEN_VERSION,
    iat: now,
    exp: now + SESSION_TTL_MS,
    pw: fingerprint,
  };
  return signPayload(sessionKey, payload);
}

function isPayload(value: unknown): value is Payload {
  if (typeof value !== 'object' || value === null) return false;
  const { v, iat, exp, pw } = value as Record<string, unknown>;
  return (
    v === TOKEN_VERSION &&
    typeof iat === 'number' &&
    Number.isFinite(iat) &&
    typeof exp === 'number' &&
    Number.isFinite(exp) &&
    typeof pw === 'string'
  );
}

/** The claims of a token signed with this key for this fingerprint and not yet expired, else null. */
export function verifySession(
  sessionKey: string,
  fingerprint: string,
  token: string | undefined,
  now: number,
): SessionClaims | null {
  if (token === undefined || token === '') return null;
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;
  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!secretsMatch(signature, hmac(sessionKey, SIGN_CONTEXT, body))) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!isPayload(payload)) return null;
  if (payload.exp <= now || payload.iat > payload.exp) return null;
  if (!secretsMatch(payload.pw, fingerprint)) return null;
  return { issuedAt: payload.iat, expiresAt: payload.exp };
}
