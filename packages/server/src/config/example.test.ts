// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `lantern.example.json`, the schema's defaults and DEFAULT_CONFIG are three
 * statements of one fact; these tests hold them together so a new key cannot
 * land in one and not the others.
 */

import { readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import { tempRoot } from '../test-app.js';
import { CONFIG_ENVIRONMENT, loadConfig } from './load.js';
import { ConfigSchema, DEFAULT_CONFIG } from './schema.js';

const EXAMPLE_PATH = fileURLToPath(new URL('../../../../lantern.example.json', import.meta.url));
const EXAMPLE_TEXT = readFileSync(EXAMPLE_PATH, 'utf8');

/** JSON has no comments; the example's are whole lines, which no JSON string can span. */
const EXAMPLE_JSON = EXAMPLE_TEXT.split('\n')
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n');

/** Every dotted leaf path in a plain object. */
function leafKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

/** Every dotted leaf path the schema declares. */
function schemaKeys(schema: unknown, prefix = ''): string[] {
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  if (properties === undefined) return [prefix];
  return Object.entries(properties).flatMap(([key, child]) =>
    schemaKeys(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

describe('lantern.example.json', () => {
  it('is JSON once its comment lines are removed', () => {
    expect(() => JSON.parse(EXAMPLE_JSON) as unknown).not.toThrow();
  });

  it('shows exactly the defaults', () => {
    expect(JSON.parse(EXAMPLE_JSON)).toEqual(DEFAULT_CONFIG);
  });

  it('declares every key the schema has, and no other', () => {
    expect(leafKeys(JSON.parse(EXAMPLE_JSON)).sort()).toEqual(schemaKeys(ConfigSchema).sort());
  });

  it('loads as a config file with nothing unknown', async () => {
    const root = await tempRoot('lantern-example-');
    try {
      const path = join(root, 'lantern.json');
      await writeFile(path, EXAMPLE_JSON);
      const config = loadConfig({ path, env: {}, platform: 'linux', homedir: root, cwd: root });
      expect(config.provenance.fileFound).toBe(true);
      expect(config.provenance.unknownKeys).toEqual([]);
      expect(config.port).toBe(DEFAULT_CONFIG.port);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('names every environment variable the loader reads, and no unknown one', () => {
    const mentioned = new Set(EXAMPLE_TEXT.match(/LANTERN_[A-Z_]+/g) ?? []);
    for (const variable of Object.keys(CONFIG_ENVIRONMENT)) {
      expect(mentioned.has(variable), variable).toBe(true);
    }
    const known = new Set([
      ...Object.keys(CONFIG_ENVIRONMENT),
      'LANTERN_CONFIG',
      'LANTERN_PASSWORD',
    ]);
    for (const variable of mentioned) expect(known.has(variable), variable).toBe(true);
  });
});

describe('the schema defaults', () => {
  it('equal DEFAULT_CONFIG', () => {
    expect(Value.Default(ConfigSchema, {})).toEqual(DEFAULT_CONFIG);
  });
});
