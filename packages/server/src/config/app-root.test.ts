// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tempRoot } from '../test-app.js';
import { DETECTED_APP_ROOT, resolveAppRoot } from './app-root.js';
import { ConfigError } from './schema.js';

let root: string;

beforeEach(async () => {
  root = await tempRoot('lantern-app-root-');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveAppRoot', () => {
  it("auto-detects the app package's dist beside the server", () => {
    expect(DETECTED_APP_ROOT.replaceAll('\\', '/')).toMatch(/\/packages\/app\/dist$/);
  });

  it('serves a detected build', async () => {
    await writeFile(join(root, 'index.html'), '<!doctype html>');
    expect(resolveAppRoot(null, 'appRoot', root)).toEqual({
      kind: 'served',
      root,
      detected: true,
    });
  });

  it('serves the API only when nothing is built', () => {
    expect(resolveAppRoot(null, 'appRoot', root)).toEqual({ kind: 'api-only', looked: root });
  });

  it('serves an explicit build', async () => {
    await writeFile(join(root, 'index.html'), '<!doctype html>');
    expect(resolveAppRoot(root)).toEqual({ kind: 'served', root, detected: false });
  });

  it('refuses an explicit path with no build, naming where it was set', () => {
    let error: unknown;
    try {
      resolveAppRoot(root, 'LANTERN_APP_ROOT');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(
      /^LANTERN_APP_ROOT is not valid: appRoot .* has no index\.html/,
    );
  });
});
