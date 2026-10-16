// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `backends` in lantern.json (Phase 5): read as written, with what the
 * schema can hold refused here and the rest (a kind's settings) left to the
 * backend registry at startup.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tempRoot } from '../test-app.js';
import { loadConfig } from './load.js';
import { ConfigError } from './schema.js';

let root: string;
let configPath: string;

beforeEach(async () => {
  root = await tempRoot('lantern-config-backends-');
  configPath = join(root, 'etc', 'lantern.json');
  await mkdir(join(root, 'etc'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function load(backends: unknown) {
  await writeFile(configPath, JSON.stringify({ backends }));
  return loadConfig({ path: configPath, env: {}, platform: 'linux', homedir: root, cwd: root });
}

describe('backends in lantern.json', () => {
  it('are none by default', async () => {
    await writeFile(configPath, '{}');
    expect(
      loadConfig({ path: configPath, env: {}, platform: 'linux', homedir: root, cwd: root })
        .backends,
    ).toEqual([]);
  });

  it('are read as written, settings and all', async () => {
    const backends = [
      {
        id: 'homelab',
        kind: 'lemonade',
        baseUrl: 'http://127.0.0.1:13305',
        secretsFromEnv: { apiKey: 'LEMONADE_API_KEY' },
      },
      {
        id: 'sdxl',
        kind: 'sdcpp',
        baseUrl: 'http://127.0.0.1:1234',
        name: 'Desk SDXL',
        settings: { preview: 'proj' },
        resourceGroup: 'desk-gpu',
        concurrency: 1,
      },
    ];
    const config = await load(backends);
    expect(config.backends).toEqual(backends);
    expect(config.provenance.unknownKeys).toEqual([]);
  });

  it('refuse an id, URL or concurrency the schema cannot take, naming the key', async () => {
    await expect(load([{ id: 'Home Lab', kind: 'sdcpp', baseUrl: 'http://h' }])).rejects.toThrow(
      ConfigError,
    );
    await expect(load([{ id: 'a', kind: 'sdcpp', baseUrl: 'localhost:1234' }])).rejects.toThrow(
      /backends/,
    );
    await expect(
      load([{ id: 'a', kind: 'sdcpp', baseUrl: 'http://h', concurrency: 0 }]),
    ).rejects.toThrow(ConfigError);
    await expect(load({ id: 'a' })).rejects.toThrow(ConfigError);
  });
});
