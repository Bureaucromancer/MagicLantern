// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/** The daemon's version, from the server package's package.json. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Two levels up from `src/cli/` under tsx and from `dist/cli/` when built. */
const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));

let cached: string | null = null;

export function readServerVersion(): string {
  if (cached !== null) return cached;
  const parsed: unknown = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  const version =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)['version']
      : undefined;
  if (typeof version !== 'string') throw new Error(`${PACKAGE_JSON} has no version.`);
  cached = version;
  return version;
}
