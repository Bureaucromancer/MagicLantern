// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The server package's importable surface. The daemon is used through its
 * `lantern` executable; this entry exists for tooling that builds the app
 * (the OpenAPI emitter, the lint-fixture resolution check).
 */

export { buildApp, type AppOptions } from './app.js';
export type { LanternApp } from './http/types.js';
export type {
  AppServices,
  AuthService,
  IssuedSession,
  SessionClaims,
  SessionCookieSettings,
} from './services.js';
