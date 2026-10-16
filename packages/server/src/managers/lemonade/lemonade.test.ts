// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  childBaseUrl,
  isLemonadeHealth,
  LemonadeManager,
  readLemonadeSettings,
  routesFromHealth,
} from './index.js';
import { FakeLemonade, lemonadeHealth } from './test-lemonade.js';

describe('the health document (SD6)', () => {
  it('yields one route per sd-cpp model, at the child’s port root, never an LLM', () => {
    const routes = routesFromHealth(lemonadeHealth());
    expect(routes.map((route) => [route.ref, route.adapter, route.base_url])).toEqual([
      ['SDXL-Base-1.0', 'sdcpp', 'http://127.0.0.1:8002'],
      ['Flux-2-Klein-4B', 'sdcpp', 'http://127.0.0.1:8003'],
    ]);
  });

  it('takes liveness from Lemonade: ready is up, loading is not yet, leaving is down (L2)', () => {
    const [ready, loading] = routesFromHealth(lemonadeHealth());
    expect(ready?.health).toEqual({ status: 'ok', load_state: 'loaded' });
    expect(loading?.health).toMatchObject({ status: 'degraded', load_state: 'cold' });

    const document = lemonadeHealth();
    const models = document['all_models_loaded'] as Record<string, unknown>[];
    models[1]!['status'] = 'evicting';
    models[2]!['backend_health'] = 'exited';
    const [evicting, exited] = routesFromHealth(document);
    expect(evicting?.health).toMatchObject({ status: 'down' });
    expect(exited?.health).toMatchObject({ status: 'down' });
  });

  it('keeps what Lemonade says of a child, for people', () => {
    const [ready] = routesFromHealth(lemonadeHealth());
    expect(ready?.detail).toMatchObject({
      checkpoint: 'stabilityai/stable-diffusion-xl-base-1.0:sd_xl_base_1.0.safetensors',
      device: 'gpu',
      is_busy: false,
    });
  });

  it('reads an older release without status fields as up', () => {
    const document = lemonadeHealth();
    for (const model of document['all_models_loaded'] as Record<string, unknown>[]) {
      delete model['status'];
      delete model['backend_health'];
      delete model['backend_alive'];
    }
    expect(routesFromHealth(document).every((route) => route.health.status === 'ok')).toBe(true);
  });

  it('ignores what it cannot use', () => {
    expect(routesFromHealth({ all_models_loaded: 'nope' })).toEqual([]);
    expect(
      routesFromHealth({
        all_models_loaded: [
          { model_name: 'a', recipe: 'sd-cpp', backend_url: 'ftp://x' },
          { model_name: '', recipe: 'sd-cpp', backend_url: 'http://127.0.0.1:1/v1' },
          { recipe: 'sd-cpp', backend_url: 'http://127.0.0.1:1/v1' },
        ],
      }),
    ).toEqual([]);
  });

  it('drops /v1 from a child’s address, and only that', () => {
    expect(childBaseUrl('http://127.0.0.1:8001/v1')).toBe('http://127.0.0.1:8001');
    expect(childBaseUrl('http://127.0.0.1:8001/v1/')).toBe('http://127.0.0.1:8001');
    expect(childBaseUrl('http://[::1]:8001/v1')).toBe('http://[::1]:8001');
    expect(childBaseUrl('http://host/prefix/v1')).toBe('http://host/prefix');
    expect(childBaseUrl('not a url')).toBeNull();
  });

  it('is told apart from other servers’ health for autodetect (L9)', () => {
    expect(isLemonadeHealth(lemonadeHealth())).toBe(true);
    expect(isLemonadeHealth({ status: 'ok' })).toBe(false);
    expect(isLemonadeHealth({ status: 'ok', model_loaded: null })).toBe(true);
  });
});

describe('the settings', () => {
  it('apply defaults, and refuse what the kind does not take', () => {
    expect(readLemonadeSettings({})).toEqual({ pollMs: 5000, timeoutMs: 10_000 });
    expect(() => readLemonadeSettings({ pollMs: 10 })).toThrow(/pollMs/);
    expect(() => readLemonadeSettings({ port: 1 })).toThrow(/Unknown Lemonade setting/);
  });
});

describe('the manager', () => {
  let lemonade: FakeLemonade;
  let manager: LemonadeManager;

  beforeEach(async () => {
    lemonade = await FakeLemonade.start();
    manager = new LemonadeManager();
  });

  afterEach(async () => {
    await lemonade.close();
  });

  it('discovers the loaded image models through the health route', async () => {
    lemonade.children = [{ name: 'SDXL-Base-1.0', origin: 'http://127.0.0.1:8002' }];
    await manager.init({ backendId: 'be', baseUrl: lemonade.url, settings: {} });
    const report = await manager.discover();
    expect(report.health).toEqual({ status: 'ok', load_state: 'loaded', detail: 'Lemonade 9.3.3' });
    expect(report.routes.map((route) => route.base_url)).toEqual(['http://127.0.0.1:8002']);
    expect(lemonade.received.at(-1)?.path).toBe('/api/v1/health');
  });

  it('is up and cold with nothing loaded', async () => {
    await manager.init({ backendId: 'be', baseUrl: lemonade.url, settings: {} });
    const report = await manager.discover();
    expect(report.health).toMatchObject({ status: 'ok', load_state: 'cold' });
    expect(report.routes).toEqual([]);
  });

  it('sends the API key as a bearer token, and is down without it', async () => {
    lemonade.apiKey = 'sesame';
    await manager.init({ backendId: 'be', baseUrl: lemonade.url, settings: {} });
    expect((await manager.discover()).health).toMatchObject({
      status: 'down',
      detail: expect.stringMatching(/check the API key/),
    });
    const keyed = new LemonadeManager();
    await keyed.init({
      backendId: 'be',
      baseUrl: lemonade.url,
      settings: {},
      secrets: { apiKey: 'sesame' },
    });
    expect((await keyed.discover()).health.status).toBe('ok');
    expect(lemonade.received.at(-1)?.authorization).toBe('Bearer sesame');
  });

  it('is down, with no routes, when Lemonade does not answer', async () => {
    await manager.init({ backendId: 'be', baseUrl: lemonade.url, settings: { timeoutMs: 1000 } });
    await lemonade.close();
    const report = await manager.discover();
    expect(report.health.status).toBe('down');
    expect(report.routes).toEqual([]);
  });

  it('refuses settings it does not take', async () => {
    await expect(
      manager.init({ backendId: 'be', baseUrl: lemonade.url, settings: { pollMs: 'often' } }),
    ).rejects.toThrow(/pollMs/);
  });
});
