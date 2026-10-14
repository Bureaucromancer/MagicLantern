// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { defineConfig, devices } from '@playwright/test';

/**
 * The end-to-end tier: a thin smoke test against the built daemon serving the
 * built app, the way an install runs it (`pnpm test:e2e` builds first). The
 * spec starts the daemon itself, on a free port with a throwaway data
 * directory (e2e/daemon.ts), so there is no `webServer` here.
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results',
  // One daemon per worker; a smoke test gains nothing from parallel browsers.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['github']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    ...devices['Desktop Chrome'],
    // Kept only for a failure: the artifact wanted when CI goes red.
    trace: 'retain-on-failure',
  },
});
