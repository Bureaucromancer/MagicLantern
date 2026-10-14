// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Where the built app is, if anywhere (config `appRoot`).
 *
 * Null auto-detects the app package's `dist` beside the server, which is where
 * a workspace build puts it; without an index.html there the daemon serves the
 * API alone (development, where Vite serves the app). An explicit path without
 * index.html is a startup error, because @fastify/static given a root that is
 * not a build serves nothing rather than failing.
 *
 * Here rather than in the static-serving module because it reads the disk,
 * which only config, store and CLI code may.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigError } from './schema.js';

/**
 * `<server package>/../app/dist`: the same three levels up from `src/config/`
 * under tsx and from `dist/config/` when built.
 */
export const DETECTED_APP_ROOT = fileURLToPath(new URL('../../../app/dist', import.meta.url));

export type AppRootResolution =
  | { readonly kind: 'served'; readonly root: string; readonly detected: boolean }
  | { readonly kind: 'api-only'; readonly looked: string };

/** Whether a directory holds a built app (its index.html). */
export function hasAppBuild(root: string): boolean {
  return existsSync(join(root, 'index.html'));
}

/**
 * @param configured `appRoot` as resolved by loadConfig (absolute), or null.
 * @param source what to name in the error: the variable or the config file.
 */
export function resolveAppRoot(
  configured: string | null,
  source = 'appRoot',
  detectedRoot = DETECTED_APP_ROOT,
): AppRootResolution {
  if (configured === null) {
    return hasAppBuild(detectedRoot)
      ? { kind: 'served', root: detectedRoot, detected: true }
      : { kind: 'api-only', looked: detectedRoot };
  }
  if (!hasAppBuild(configured)) {
    throw new ConfigError(source, [
      `appRoot ${configured} has no index.html; build the app (pnpm build) or point appRoot at its dist directory`,
    ]);
  }
  return { kind: 'served', root: configured, detected: false };
}
