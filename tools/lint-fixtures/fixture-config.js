// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The lint config the fixture tests run: the rule objects `eslint.config.js`
 * uses, imported from `eslint.rules.js` rather than restated, rooted at the
 * fixture tree. A rule someone loosens there is loosened here too, and the test
 * asserting it fires goes red; a hand-copied config would keep passing.
 *
 * Not type-aware: none of these rules needs type information, and the fixtures
 * are deliberately in no tsconfig. Which block applies to which path mirrors
 * `eslint.config.js`; tools/repo-shape.test.ts holds the real config to the
 * same bans.
 */

import boundaries from 'eslint-plugin-boundaries';
import headers from 'eslint-plugin-headers';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

import {
  BROWSER_PACKAGES,
  bannedPackagesFor,
  boundariesGraph,
  headerRule,
  restrictedImports,
  restrictedUiSyntax,
} from '../../eslint.rules.js';

/** Relative to the repository root, which is where the tests run ESLint from. */
export const FIXTURE_ROOT = 'tools/lint-fixtures/fixtures';

/** @type {readonly ('schema' | 'client' | 'react' | 'app' | 'server')[]} */
export const PACKAGES = ['schema', 'client', 'react', 'app', 'server'];

/**
 * The config with the boundary graph rooted at `roots`. Parameterised so a test
 * can show what a single root misses.
 *
 * @param {string[]} roots where the boundary graph looks for packages
 */
export function fixtureConfigRootedAt(roots) {
  const graph = boundariesGraph(roots);
  return defineConfig(
    {
      files: [`${FIXTURE_ROOT}/**/*.{ts,tsx}`],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          ecmaFeatures: { jsx: true },
        },
      },
      plugins: { boundaries, headers },
      settings: {
        ...graph.settings,
        'import/resolver': {
          typescript: {
            alwaysTryTypes: true,
            noWarnOnMultipleProjects: true,
            project: ['packages/*/tsconfig.json'],
          },
          node: true,
        },
      },
      rules: {
        ...graph.rules,
        ...headerRule,
        'no-restricted-imports': restrictedImports(),
      },
    },

    ...PACKAGES.map((name) => ({
      files: [`${FIXTURE_ROOT}/packages/${name}/**/*.{ts,tsx}`],
      rules: {
        'no-restricted-imports': restrictedImports({
          browser: BROWSER_PACKAGES.has(name),
          bannedPackages: bannedPackagesFor(name),
        }),
      },
    })),

    // The store may use the filesystem; the rest of the server may not.
    {
      files: [`${FIXTURE_ROOT}/packages/server/src/store/**/*.ts`],
      rules: {
        'no-restricted-imports': restrictedImports({
          allowFs: true,
          bannedPackages: bannedPackagesFor('server'),
        }),
      },
    },

    {
      files: [
        `${FIXTURE_ROOT}/packages/app/src/**/*.{ts,tsx}`,
        `${FIXTURE_ROOT}/packages/react/src/**/*.{ts,tsx}`,
      ],
      rules: { 'no-restricted-syntax': restrictedUiSyntax() },
    },
  );
}

// Both roots: the fixture files themselves, and the real packages that their
// `@bureaucromancer/*` imports resolve to through pnpm's symlinks (into each
// package's built dist). See `boundariesGraph`.
export const fixtureConfig = fixtureConfigRootedAt([`${FIXTURE_ROOT}/packages`, 'packages']);
