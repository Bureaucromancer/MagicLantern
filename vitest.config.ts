// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { availableParallelism } from 'node:os';

import { defineConfig } from 'vitest/config';

/**
 * Spread into every project, because vitest `projects` do not inherit
 * top-level test options: written once at the top it reads like a default and
 * silently leaves every test on vitest's 5 s. A timeout is a hang detector, not
 * a performance budget; 15 s is far above any honest test's wall time.
 */
const TIMEOUTS = { testTimeout: 15_000, hookTimeout: 15_000 };

/**
 * One node project per package for `*.test.ts`, and a jsdom project for
 * `*.test.tsx` where a package has components. Split by extension so no file is
 * claimed twice (vitest runs a file once per matching project), and so a new
 * test file is always claimed by exactly one project: a file matched by none
 * lints and typechecks but never runs.
 *
 * @param name the package directory under packages/
 */
function nodeProject(name: string) {
  return {
    test: {
      name,
      ...TIMEOUTS,
      root: '.',
      include: [`packages/${name}/src/**/*.test.ts`],
      environment: 'node',
    },
  };
}

/**
 * jsdom for component tests. The setup file registers Testing Library's
 * cleanup, which it only does by itself when describe/it are globals, and this
 * repository imports them explicitly.
 *
 * @param name the package directory under packages/
 */
function domProject(name: string) {
  return {
    test: {
      name: `${name}-dom`,
      ...TIMEOUTS,
      root: '.',
      include: [`packages/${name}/src/**/*.test.tsx`],
      environment: 'jsdom',
      setupFiles: [`packages/${name}/src/test-dom-setup.ts`],
    },
  };
}

export default defineConfig({
  test: {
    // At least two workers: a two-core CI runner otherwise gets one, and most
    // of this suite waits on SQLite and the filesystem rather than computing.
    maxWorkers: Math.max(2, availableParallelism() - 1),
    projects: [
      nodeProject('schema'),
      nodeProject('client'),
      nodeProject('react'),
      domProject('react'),
      nodeProject('server'),
      nodeProject('app'),
      domProject('app'),
      // The lint rules, proven against fixtures (tools/lint-fixtures).
      {
        test: {
          name: 'lint-rules',
          ...TIMEOUTS,
          root: '.',
          include: ['tools/lint-fixtures/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'tools/lint-fixtures/fixtures/**'],
          environment: 'node',
        },
      },
      // Repository invariants whose subject is no single package.
      {
        test: {
          name: 'repo',
          ...TIMEOUTS,
          root: '.',
          include: ['tools/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
