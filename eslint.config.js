// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import headers from 'eslint-plugin-headers';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import {
  BROWSER_PACKAGES,
  bannedPackagesFor,
  boundariesGraph,
  headerRule,
  restrictedImports,
  restrictedUiSyntax,
} from './eslint.rules.js';

const graph = boundariesGraph('packages');

const TEST_FILES = ['**/*.test.ts', '**/*.test.tsx', '**/test-*.ts', '**/test-*.tsx'];

/**
 * Package sources: the package-name ban on top of the resolved-path boundary
 * rule (see `forbiddenPackages` for why there are two layers).
 *
 * @param {'schema' | 'client' | 'react' | 'server' | 'app'} name
 * @param {string[]} files
 */
function packageOverride(name, files) {
  return {
    files,
    rules: {
      'no-restricted-imports': restrictedImports({
        browser: BROWSER_PACKAGES.has(name),
        bannedPackages: bannedPackagesFor(name),
      }),
    },
  };
}

/**
 * The same bans for a package's tests, which may use the filesystem and Node.
 * Restated rather than inherited because the blanket test block replaces the
 * rule's options: without these, every test file would lose its package bans.
 *
 * @param {'schema' | 'client' | 'react' | 'server' | 'app'} name
 */
function packageTestOverride(name) {
  return {
    files: TEST_FILES.map((glob) => `packages/${name}/${glob}`),
    rules: {
      'no-restricted-imports': restrictedImports({
        allowFs: true,
        bannedPackages: bannedPackagesFor(name),
      }),
    },
  };
}

export default defineConfig(
  {
    ignores: [
      '**/dist/',
      '**/dist-types/',
      '**/coverage/',
      '**/node_modules/',
      'data/',
      'test-results/',
      'playwright-report/',
      // Files that exist to violate the rules below. The fixture tests lint
      // them deliberately; `pnpm lint` never does.
      'tools/lint-fixtures/fixtures/',
      // Claude Code's scratch worktrees are whole second checkouts; linting
      // them makes the result depend on whatever branch sits beside the repo.
      '.claude/',
    ],
  },

  // -------------------------------------------------------------------------
  // Everything: the licence header and the filesystem rule.
  // -------------------------------------------------------------------------
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    plugins: { headers },
    rules: {
      ...headerRule,
      'no-restricted-imports': restrictedImports(),
    },
  },

  js.configs.recommended,

  // -------------------------------------------------------------------------
  // Package sources: type-aware linting and the boundary graph.
  // -------------------------------------------------------------------------
  {
    files: ['packages/**/*.{ts,tsx}'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { boundaries },
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
      // An underscore marks a parameter a signature requires but the body does
      // not use (callbacks, stubs awaiting their implementation).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  // Build scripts import from `dist`, so they are in no package tsconfig
  // (that would be circular): linted, but not type-aware.
  {
    files: ['packages/*/scripts/**/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { parserOptions: { projectService: false } },
  },

  // Tests assert things the type system cannot see, and a decoded JSON body is
  // genuinely dynamic. These rules stay on in production code.
  {
    files: TEST_FILES,
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  packageOverride('schema', ['packages/schema/**/*.ts']),
  packageOverride('client', ['packages/client/**/*.ts']),
  packageOverride('react', ['packages/react/**/*.{ts,tsx}']),
  packageOverride('server', ['packages/server/**/*.ts']),
  // Only the app's browser source: vite.config.ts runs in Node.
  packageOverride('app', ['packages/app/src/**/*.{ts,tsx}']),
  {
    files: ['packages/app/*.ts'],
    rules: {
      'no-restricted-imports': restrictedImports({ bannedPackages: bannedPackagesFor('app') }),
    },
  },

  // The server code allowed to touch the filesystem: the store (data
  // directory), config loading and the CLI (stdin, startup checks). Everything
  // else reaches the disk through the store.
  {
    files: [
      'packages/server/src/store/**/*.ts',
      'packages/server/src/config/**/*.ts',
      'packages/server/src/cli/**/*.ts',
      'packages/server/scripts/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': restrictedImports({
        allowFs: true,
        bannedPackages: bannedPackagesFor('server'),
      }),
    },
  },

  // Repository tooling and the end-to-end harness: no request, no user data.
  {
    files: ['tools/**/*.{js,mjs,ts}', 'e2e/**/*.ts', 'playwright.config.ts'],
    rules: { 'no-restricted-imports': restrictedImports({ allowFs: true }) },
  },

  // Tests may use the filesystem directly: a store test plays the user with a
  // file manager. Placed after the package blocks so it wins, which is why the
  // package bans are restated just below.
  {
    files: TEST_FILES,
    rules: { 'no-restricted-imports': restrictedImports({ allowFs: true }) },
  },
  packageTestOverride('schema'),
  packageTestOverride('client'),
  packageTestOverride('react'),
  packageTestOverride('server'),
  packageTestOverride('app'),

  // -------------------------------------------------------------------------
  // Runtime environments.
  // -------------------------------------------------------------------------
  {
    files: ['packages/server/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['packages/app/**/*.{ts,tsx}', 'packages/react/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // UI source: semantic tokens, logical direction, no backend names (rule 3).
  {
    files: ['packages/app/src/**/*.{ts,tsx}', 'packages/react/src/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': restrictedUiSyntax() },
  },

  // TanStack Router's `redirect()` is thrown from `beforeLoad` by design; it is
  // control flow the router catches, not an error. One file wide on purpose.
  {
    files: ['packages/app/src/router.tsx'],
    rules: { '@typescript-eslint/only-throw-error': 'off' },
  },

  // -------------------------------------------------------------------------
  // Config files, tooling and e2e: linted, not type-aware. They are in no
  // package tsconfig; tsconfig.tools.json and e2e/tsconfig.json typecheck them.
  // -------------------------------------------------------------------------
  {
    files: ['*.{js,mjs,ts}', 'tools/**/*.{js,mjs,ts}', 'e2e/**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
  },
);
