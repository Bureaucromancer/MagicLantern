// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The {@link AuthService} handlers use, built once at startup from the config's
 * `auth` section and secrets.json.
 *
 * Fixed for the life of the process: `lantern set-password` takes the instance
 * lock, so the record cannot change under a running daemon, and the next start
 * reads the new one (whose fingerprint signs every old cookie out).
 */

import type { AuthMode } from '@bureaucromancer/lantern-schema';

import type { AuthModeSetting } from '../config/schema.js';
import type { AuthService, IssuedSession, SessionClaims } from '../services.js';
import type { PasswordRecord, Secrets } from '../store/secrets.js';
import { verifyPassword } from './password.js';
import {
  passwordFingerprint,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  signSession,
  verifySession,
} from './session.js';

/** `auth.mode` as configured, or (null) `password` exactly when a password has been set. */
export function resolveAuthMode(setting: AuthModeSetting, hasPassword: boolean): AuthMode {
  return setting ?? (hasPassword ? 'password' : 'none');
}

/**
 * At most this many password checks run at once; later ones wait their turn.
 * Each scrypt check holds one of libuv's worker threads (four by default) for
 * its whole run, and static files and the stores read the disk on the same
 * threads, so a burst of sign-in attempts from anyone who can reach the port
 * would otherwise stall every file read. Two leave the rest free. It is not a
 * lockout or a rate limit per client (the threat model has neither): a burst
 * just waits, with every attempt still answered and a wrong one still one 401.
 */
export const MAX_CONCURRENT_PASSWORD_CHECKS = 2;

/** Runs tasks at most `limit` at a time, the rest in the order they arrived. */
export function concurrencyLimit(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active < limit) {
      active += 1;
    } else {
      // A finishing task hands its slot straight over, so a newcomer cannot slip in between.
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next === undefined) active -= 1;
      else next();
    }
  };
}

export interface AuthServiceOptions {
  readonly setting: AuthModeSetting;
  readonly secrets: Secrets;
  /** `auth.cookieSecure`: an operator's statement that TLS terminates in front. */
  readonly cookieSecure: boolean;
  /** Epoch milliseconds; a seam for expiry tests. */
  readonly now?: () => number;
  /** The scrypt check; a seam so tests can watch how many run at once. */
  readonly verify?: (password: string, record: PasswordRecord) => Promise<boolean>;
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  const { secrets, cookieSecure } = options;
  const now = options.now ?? Date.now;
  const verify = options.verify ?? verifyPassword;
  const limited = concurrencyLimit(MAX_CONCURRENT_PASSWORD_CHECKS);
  const record = secrets.password;
  const mode = resolveAuthMode(options.setting, record !== undefined);
  if (mode === 'password' && record === undefined) {
    // The serve command refuses this state with a usage error first; reaching
    // here means a caller skipped that check, and an open daemon is the wrong default.
    throw new TypeError('Auth mode is password but no password has been set.');
  }
  const fingerprint = record === undefined ? null : passwordFingerprint(secrets.sessionKey, record);

  return {
    mode: () => mode,

    async verifyPassword(password) {
      if (mode !== 'password' || record === undefined) return false;
      try {
        return await limited(() => verify(password, record));
      } catch {
        // A record whose parameters scrypt refuses: still one answer, never a 500.
        return false;
      }
    },

    issueSession(at = now()): IssuedSession {
      if (fingerprint === null) throw new TypeError('There is no password to issue a session for.');
      const token = signSession(secrets.sessionKey, fingerprint, at);
      return { token, issuedAt: at, expiresAt: at + SESSION_TTL_MS };
    },

    readSession(token, at = now()): SessionClaims | null {
      if (mode !== 'password' || fingerprint === null) return null;
      return verifySession(secrets.sessionKey, fingerprint, token, at);
    },

    cookie: {
      name: SESSION_COOKIE_NAME,
      secure: cookieSecure,
      maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
    },
  };
}
