// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The README is the first thing a developer runs commands from, so what it
 * says to run has to work in a fresh checkout: every command in its shell
 * blocks, the alternatives in their comments included, and every check CI
 * holds a change to. Read as text, like ci-shape.test.ts.
 */

function repoText(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

interface Manifest {
  readonly scripts?: Record<string, string>;
  readonly bin?: Record<string, string>;
}

const README = repoText('README.md');
const rootScripts = Object.keys((JSON.parse(repoText('package.json')) as Manifest).scripts ?? {});

/** The rows of the README's command table, as raw lines. */
function commandRows(): string[] {
  const rows = README.split('\n').filter((line) => /^\| `pnpm /.test(line));
  if (rows.length === 0)
    throw new Error('README.md has no command table; has it been restructured?');
  return rows;
}

/** Every `pnpm <script>` step in CI. */
function ciScripts(): string[] {
  const scripts = repoText('.github/workflows/ci.yml')
    .split('\n')
    .map((line) => /^\s*(?:-\s+)?run:\s*pnpm ([\w:-]+)\s*$/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined && name !== 'install');
  if (scripts.length === 0)
    throw new Error('ci.yml runs no pnpm scripts; has it been restructured?');
  return scripts;
}

/** Each command the README's `sh` blocks give, with any `# or: <command>` alternative. */
function shellCommands(): string[] {
  const blocks = [...README.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((match) => match[1] ?? '');
  if (blocks.length === 0) throw new Error('README.md has no sh blocks; has it been restructured?');

  return blocks.flatMap((block) =>
    block.split('\n').flatMap((line) => {
      const hash = line.indexOf('#');
      const code = (hash === -1 ? line : line.slice(0, hash)).trim();
      const alternative = hash === -1 ? undefined : /^#\s*or:\s*(.+)$/.exec(line.slice(hash));
      return [code, alternative?.[1]?.trim() ?? ''].filter((command) => command !== '');
    }),
  );
}

/** The built entry points a checkout can run with `node`, relative to the root. */
function workspaceBins(): string[] {
  return ['schema', 'client', 'react', 'server', 'app'].flatMap((pkg) => {
    const manifest = JSON.parse(repoText(`packages/${pkg}/package.json`)) as Manifest;
    return Object.values(manifest.bin ?? {}).map((target) =>
      posix.join('packages', pkg, posix.normalize(target)),
    );
  });
}

describe('the README', () => {
  it('documents every script CI runs in its command table', () => {
    const table = commandRows().join('\n');
    for (const script of ciScripts()) expect(table, script).toContain(`\`pnpm ${script}\``);
  });

  it('says `pnpm test` needs a build first, since packages resolve each other through dist', () => {
    const row = commandRows().find((line) => line.startsWith('| `pnpm test` |'));

    expect(row, 'the `pnpm test` row').toBeDefined();
    expect(row).toMatch(/`pnpm build`/);
  });

  it('gives only commands that run in a checkout', () => {
    const bins = workspaceBins();
    expect(bins, 'the daemon has a bin').toContain('packages/server/dist/main.js');

    for (const command of shellCommands()) {
      const pnpm = /^pnpm (\S+)/.exec(command);
      const node = /^node (\S+)/.exec(command);
      if (pnpm !== null) {
        expect(['install', ...rootScripts], command).toContain(pnpm[1]);
      } else if (node !== null) {
        expect(bins, command).toContain(node[1]);
      } else {
        // A bare `lantern` is on PATH only where the package is installed;
        // the root depends on no workspace package, so a checkout links none.
        expect.fail(`\`${command}\` is neither a root pnpm script nor a built bin`);
      }
    }
  });
});
