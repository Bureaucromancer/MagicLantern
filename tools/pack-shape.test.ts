// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * What a packed tarball carries. StoryEngine consumes schema, client and react
 * as packed tarballs until 3.0 (plan, D4), and the daemon ships as one, so the
 * tarball is the product rather than the checkout.
 *
 * Every `.js.map` and `.d.ts.map` in `dist` names its source by a path relative
 * to itself (`../src/client.ts`). A map whose source is not in the tarball
 * sends go-to-definition and `node --enable-source-maps` stack traces to a file
 * that does not exist. This reads the file list `pnpm pack` itself computes (a
 * dry run, so nothing is written) and the maps from disk, which are the bytes
 * it would pack. It needs a build, like every test that reads `dist`.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface Manifest {
  readonly name: string;
  readonly files?: readonly string[];
}

interface SourceMap {
  readonly sourceRoot?: string;
  readonly sources: readonly string[];
  readonly sourcesContent?: readonly (string | null)[];
}

/** Every workspace package that declares `files`, which is what marks it as one that gets packed. */
function packedPackages(): { dir: string; name: string }[] {
  return readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(ROOT, 'packages', entry.name);
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
      return { dir, name: manifest.name, files: manifest.files };
    })
    .filter((pkg) => pkg.files !== undefined)
    .map(({ dir, name }) => ({ dir, name }));
}

/** The paths `pnpm pack` would put in the tarball, relative to the package root. */
function packList(dir: string): string[] {
  const output = execFileSync('pnpm', ['pack', '--dry-run', '--json'], {
    cwd: dir,
    encoding: 'utf8',
  });
  const start = output.indexOf('{');
  if (start === -1) throw new Error(`pnpm pack printed no JSON in ${dir}:\n${output}`);
  return (JSON.parse(output.slice(start)) as { files: { path: string }[] }).files.map(
    (file) => file.path,
  );
}

const PACKAGES = packedPackages();

describe('packed tarballs', () => {
  it('include the libraries StoryEngine consumes', () => {
    expect(PACKAGES.map((pkg) => pkg.name)).toEqual(
      expect.arrayContaining([
        '@bureaucromancer/lantern-schema',
        '@bureaucromancer/lantern-client',
        '@bureaucromancer/lantern-react',
      ]),
    );
  });

  describe.each(PACKAGES)('$name', ({ dir }) => {
    // One pack per package, shared by the cases below; the server's is the slow one.
    let cached: string[] | undefined;
    const files = (): string[] => (cached ??= packList(dir));

    it('ships a source map for its built code (an unbuilt tree has none: run `pnpm build`)', () => {
      expect(files().filter((path) => path.endsWith('.map')).length).toBeGreaterThan(0);
    }, 30_000);

    it('ships every source its maps name, so the maps resolve', () => {
      const packed = new Set(files());
      const unresolved: string[] = [];

      for (const mapPath of files().filter((path) => path.endsWith('.map'))) {
        const map = JSON.parse(readFileSync(join(dir, mapPath), 'utf8')) as SourceMap;
        map.sources.forEach((source, index) => {
          if (typeof map.sourcesContent?.[index] === 'string') return;
          const target = posix.normalize(
            posix.join(posix.dirname(mapPath), map.sourceRoot ?? '', source),
          );
          if (!packed.has(target)) unresolved.push(`${mapPath} -> ${target}`);
        });
      }

      expect(unresolved).toEqual([]);
    }, 30_000);

    it('ships no tests, test-only helpers or build info', () => {
      const stray = files().filter((path) => {
        const base = posix.basename(path);
        return base.startsWith('test-') || base.includes('.test.') || base.endsWith('.tsbuildinfo');
      });

      expect(stray).toEqual([]);
    }, 30_000);
  });
});
