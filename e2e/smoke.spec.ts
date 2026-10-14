// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Phase 1's exit, end to end: `lantern serve` serves the built app, the app
 * calls typed endpoints through lantern-client, and a fresh install lands in
 * its default library.
 */

import { expect, test as base } from '@playwright/test';

import { DAEMON_FIXTURE_TIMEOUT_MS, startDaemon, type Daemon } from './daemon.js';

const test = base.extend<{ daemonOutputOnFailure: undefined }, { daemon: Daemon }>({
  daemon: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern.
    async ({}, use) => {
      const daemon = await startDaemon();
      try {
        await use(daemon);
      } finally {
        await daemon.stop();
      }
    },
    // Its own timeout: a slow start is not the test's time, and running out of
    // the test's would hide the harness's error and the daemon's output.
    { scope: 'worker', timeout: DAEMON_FIXTURE_TIMEOUT_MS },
  ],
  baseURL: async ({ daemon }, use) => {
    await use(daemon.url);
  },
  // The daemon's log is the first thing wanted when a run goes red.
  daemonOutputOnFailure: [
    async ({ daemon }, use, testInfo) => {
      await use(undefined);
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('daemon output', {
          body: daemon.output(),
          contentType: 'text/plain',
        });
      }
    },
    { auto: true },
  ],
});

test('a fresh install opens its default library at /', async ({ page, request }) => {
  const infoResponse = await request.get('/api/v1/info');
  expect(infoResponse.ok()).toBe(true);
  const info = (await infoResponse.json()) as { version: string };

  await page.goto('/');

  await expect(page).toHaveURL(/\/l\/lib_[0-9A-HJKMNP-TV-Z]{26}\/generate$/);
  await expect(page.getByRole('banner').getByText('Library', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Generate — coming in the prototype' }),
  ).toBeVisible();
  await expect(page.getByRole('contentinfo')).toContainText(info.version);
});
