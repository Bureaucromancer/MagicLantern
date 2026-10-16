// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * What route handlers may use, built once at startup and decorated onto the
 * Fastify instance as `app.services`.
 *
 * Route *registration* never touches services, only handlers do, so the OpenAPI
 * emitter can build the app with stubs and no data directory.
 */

import type { AuthMode } from '@bureaucromancer/lantern-schema';

import type { ModelCatalog } from './engine/catalog/index.js';
import type { EventBus, JobEngine } from './engine/jobs/index.js';
import type { Resolver } from './engine/resolver/index.js';
import type { LibraryRegistry } from './store/index.js';

/** The verified contents of a session cookie. */
export interface SessionClaims {
  /** Epoch milliseconds. */
  readonly issuedAt: number;
  /** Epoch milliseconds; 30 days after `issuedAt`. */
  readonly expiresAt: number;
}

/** A freshly signed session, ready to set as the cookie value. */
export interface IssuedSession extends SessionClaims {
  readonly token: string;
}

/** How the session cookie is set and cleared. */
export interface SessionCookieSettings {
  /** `lantern_session`. */
  readonly name: string;
  /** From `auth.cookieSecure`; never derived from the bind. */
  readonly secure: boolean;
  /** Seconds, matching the token's expiry. */
  readonly maxAgeSeconds: number;
}

/**
 * Auth, resolved at startup (SK7). Mode `none` is the default; mode `password`
 * checks one install-wide scrypt record kept in secrets.json.
 *
 * Every failure has one answer: `verifyPassword` is false and `readSession` is
 * null for every kind of bad input, so there is nothing to probe.
 */
export interface AuthService {
  /** The effective mode: `auth.mode` from config, else `password` iff a record exists. */
  mode(): AuthMode;
  /** Constant-time check against the stored record; false in mode none or with no record. */
  verifyPassword(password: string): Promise<boolean>;
  /**
   * Signs a session (HMAC-SHA256) carrying issued-at, expiry and a fingerprint
   * of the current password record, so `lantern set-password` signs everyone out.
   */
  issueSession(now?: number): IssuedSession;
  /** The claims of a valid, unexpired session for the current record, else null. */
  readSession(token: string | undefined, now?: number): SessionClaims | null;
  readonly cookie: SessionCookieSettings;
}

export interface AppServices {
  /** The daemon's version, as reported by `/api/v1/info`. */
  readonly version: string;
  /** This process's random id (`newId('proc')`), also written to the lease row. */
  readonly processId: string;
  readonly auth: AuthService;
  readonly libraries: LibraryRegistry;
  /** Models and their routes. An in-memory seam until Phase 5 gives them tables. */
  readonly models: ModelCatalog;
  /** Resolves requests against the models' routes, for the dry run and submit. */
  readonly resolver: Resolver;
  /** Runs jobs: submit, cancel, rerun, the queue. Started before the daemon listens. */
  readonly engine: JobEngine;
  /** What `GET /api/v1/events` streams. */
  readonly events: EventBus;
}
