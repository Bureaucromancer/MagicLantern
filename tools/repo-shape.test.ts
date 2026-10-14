// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import {
  bannedPackagesFor,
  boundariesGraph,
  forbiddenPackages,
  restrictedUiSyntax,
} from '../eslint.rules.js';

/**
 * Holds the real `eslint.config.js` to the rules the fixture tests prove.
 *
 * The fixtures show each rule object works; nothing there shows the real
 * config applies it to every file it should. In flat config a later block
 * *replaces* an earlier block's options for a rule, so an exemption (tests may
 * use the filesystem, the store may use the filesystem) that forgets to restate
 * a package's bans silently drops them for every file it covers. This reads the
 * config ESLint actually computes for each kind of file.
 */

type Pkg = keyof typeof forbiddenPackages;

const PACKAGES = Object.keys(forbiddenPackages) as Pkg[];
const BROWSER_PACKAGES: readonly Pkg[] = ['schema', 'client', 'react', 'app'];

const eslint = new ESLint({ cwd: process.cwd() });
const graph = boundariesGraph('packages');

interface ImportBans {
  readonly paths: readonly { name: string }[];
  readonly patterns?: readonly { group: readonly string[] }[];
}

async function configFor(file: string): Promise<{
  rules: Record<string, unknown>;
  settings: Record<string, unknown>;
}> {
  const config = (await eslint.calculateConfigForFile(file)) as
    { rules?: Record<string, unknown>; settings?: Record<string, unknown> } | undefined;
  if (config === undefined) throw new Error(`ESLint computes no config for ${file}.`);
  return { rules: config.rules ?? {}, settings: config.settings ?? {} };
}

/** The options of an error-level rule, failing when the rule is off or a warning. */
function errorOptions(rules: Record<string, unknown>, rule: string, file: string): unknown[] {
  const value = rules[rule];
  expect(Array.isArray(value), `${rule} is configured for ${file}`).toBe(true);
  const [severity, ...options] = value as unknown[];
  expect(severity, `${rule} is an error for ${file}`).toBe(2);
  return options;
}

async function importBansFor(file: string): Promise<ImportBans> {
  const { rules } = await configFor(file);
  return errorOptions(rules, 'no-restricted-imports', file)[0] as ImportBans;
}

function bannedNames(bans: ImportBans): string[] {
  return bans.paths.map((path) => path.name);
}

function bannedPatterns(bans: ImportBans): string[] {
  return (bans.patterns ?? []).flatMap((pattern) => pattern.group);
}

/** Every kind of file a package has, as ESLint sees it. */
function filesOf(pkg: Pkg): string[] {
  const root = `packages/${pkg}`;
  const files = [`${root}/src/probe.ts`, `${root}/src/probe.test.ts`, `${root}/src/test-probe.ts`];
  if (pkg === 'react' || pkg === 'app')
    files.push(`${root}/src/probe.tsx`, `${root}/src/probe.test.tsx`);
  if (pkg === 'server') {
    for (const dir of ['store', 'config', 'cli', 'http', 'routes'])
      files.push(`${root}/src/${dir}/probe.ts`);
    files.push(`${root}/scripts/probe.ts`);
  }
  if (pkg === 'app') files.push(`${root}/vite.config.ts`);
  return files;
}

describe('the real lint config', () => {
  describe.each(PACKAGES)('in %s', (pkg) => {
    const files = filesOf(pkg);

    it.each(files)('bans the forbidden packages, deep imports included, in %s', async (file) => {
      const bans = await importBansFor(file);
      for (const banned of bannedPackagesFor(pkg)) {
        expect(bannedNames(bans), file).toContain(banned.name);
        expect(bannedPatterns(bans), file).toContain(`${banned.name}/*`);
      }
    });

    it.each(files)('applies the boundary graph rooted at packages/ to %s', async (file) => {
      const { rules, settings } = await configFor(file);

      expect(errorOptions(rules, 'boundaries/dependencies', file)).toEqual(
        graph.rules['boundaries/dependencies'].slice(1),
      );
      expect(settings['boundaries/elements']).toEqual(graph.settings['boundaries/elements']);
    });
  });

  it.each(BROWSER_PACKAGES)('bans Node built-ins in %s source', async (pkg) => {
    const file = `packages/${pkg}/src/probe.ts`;
    const bans = await importBansFor(file);

    expect(bannedPatterns(bans)).toContain('node:*');
    expect(bannedNames(bans)).toEqual(expect.arrayContaining(['fs', 'path', 'crypto']));
  });

  it.each([
    'packages/server/src/probe.ts',
    'packages/server/src/http/probe.ts',
    'packages/server/src/routes/probe.ts',
  ])('bans the filesystem in %s', async (file) => {
    expect(bannedNames(await importBansFor(file))).toEqual(
      expect.arrayContaining(['node:fs', 'node:fs/promises', 'write-file-atomic']),
    );
  });

  it.each([
    'packages/server/src/store/probe.ts',
    'packages/server/src/config/probe.ts',
    'packages/server/src/cli/probe.ts',
    'packages/server/scripts/probe.ts',
    'packages/server/src/http/probe.test.ts',
  ])('allows the filesystem in %s', async (file) => {
    expect(bannedNames(await importBansFor(file))).not.toContain('node:fs');
  });

  it.each([
    'packages/app/src/probe.ts',
    'packages/app/src/probe.tsx',
    'packages/react/src/probe.ts',
    'packages/react/src/probe.tsx',
  ])('applies the UI rules (tokens, logical direction, no backend names) to %s', async (file) => {
    const { rules } = await configFor(file);

    expect(errorOptions(rules, 'no-restricted-syntax', file)).toEqual(
      restrictedUiSyntax().slice(1),
    );
  });
});
