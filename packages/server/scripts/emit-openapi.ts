// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Writes packages/server/openapi.json from the built app (`../dist`), so the
 * committed spec describes what ships. `generateOpenApiJson` builds the app
 * with stub services and no data directory, without listening, and renders the
 * spec deterministically.
 *
 * Run by `pnpm --filter @bureaucromancer/lantern-server emit-openapi` after
 * `tsc -b` (Node strips the types; the imports are plain JS in dist). The root
 * `openapi:check` re-emits and fails when the committed file differs.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const builtApp = new URL('../dist/app.js', import.meta.url);
const builtOpenApi = new URL('../dist/http/openapi.js', import.meta.url);
const output = new URL('../openapi.json', import.meta.url);

async function main(): Promise<number> {
  // Checked up front: a missing dist otherwise surfaces as ERR_MODULE_NOT_FOUND
  // naming a file, which reads like a bug rather than a build step skipped.
  for (const file of [builtApp, builtOpenApi]) {
    if (!existsSync(file)) {
      console.error(
        `${fileURLToPath(file)} does not exist. Build first (\`pnpm build\`, or \`tsc -b\` ` +
          'at the repository root): the spec is emitted from the built server.',
      );
      return 1;
    }
  }

  const [{ buildApp }, { generateOpenApiJson }] = await Promise.all([
    import('../dist/app.js'),
    import('../dist/http/openapi.js'),
  ]);
  const text = await generateOpenApiJson(buildApp);
  const path = fileURLToPath(output);
  const previous = existsSync(output) ? readFileSync(output, 'utf8') : null;

  if (previous === text) {
    console.log(`${path} is current.`);
  } else {
    writeFileSync(output, text);
    console.log(`Wrote ${path}.`);
  }
  return 0;
}

process.exitCode = await main();
