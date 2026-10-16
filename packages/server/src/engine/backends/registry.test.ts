// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The backend registry against fake backends: config reconciliation, a
 * standalone sd-server (its route, its model, another model on its port, its
 * outage), Lemonade's children (discovered, unloaded, loaded again on another
 * port), adding a backend with a proposal card's choices, changing a model,
 * and what a restart starts from.
 */

import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeSdServer, pinnedCapabilities, withModel } from '../../adapters/sdcpp/test-sdserver.js';
import { FakeLemonade } from '../../managers/lemonade/test-lemonade.js';
import { memoryInstallDb } from '../../store/test-store.js';
import { silentStoreLog } from '../../test-app.js';
import { devBackend, devFixedModel, DEV_MODEL_ID, DEV_ROUTE_ID } from '../catalog/index.js';
import { EventBus, type StampedEvent } from '../jobs/index.js';
import { builtinProfiles } from '../profiles/index.js';
import {
  BackendConfigError,
  BackendRegistry,
  createBackendKinds,
  defaultResourceGroup,
  type BackendRegistryOptions,
  type ConfigBackend,
} from './index.js';

const KLEIN = '/models/flux-2-klein-4b.safetensors';

let db: DatabaseSync;
let events: EventBus;
let published: StampedEvent[];
const registries: BackendRegistry[] = [];
const servers: { close(): Promise<void> }[] = [];

beforeEach(() => {
  db = memoryInstallDb();
  events = new EventBus('boot_test');
  published = [];
  events.subscribe((event) => published.push(event));
});

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.stop();
  for (const server of servers.splice(0)) await server.close();
});

function registry(options: Partial<BackendRegistryOptions> = {}): BackendRegistry {
  const created = new BackendRegistry({
    db,
    profiles: builtinProfiles(),
    events,
    log: silentStoreLog(),
    kinds: createBackendKinds(),
    // Long enough never to fire in a test: refreshes are asked for.
    healthMs: 60_000,
    startupWaitMs: 5000,
    createWaitMs: 5000,
    ...options,
  });
  registries.push(created);
  return created;
}

async function sdServer(
  options: Parameters<typeof FakeSdServer.start>[0] = {},
): Promise<FakeSdServer> {
  const server = await FakeSdServer.start(options);
  servers.push(server);
  return server;
}

async function lemonade(): Promise<FakeLemonade> {
  const fake = await FakeLemonade.start();
  servers.push(fake);
  return fake;
}

function standalone(url: string, extra: Partial<ConfigBackend> = {}): ConfigBackend {
  return { id: 'sdxl', kind: 'sdcpp', baseUrl: url, ...extra };
}

describe('config backends', () => {
  it('are registered, kept on the next start, and tombstoned once dropped', async () => {
    const server = await sdServer();
    await registry().start({ config: [standalone(server.url, { name: 'Homelab SDXL' })] });
    const [view] = registry().backendViews();
    expect(view).toMatchObject({
      id: 'sdxl',
      kind: 'sdcpp',
      name: 'Homelab SDXL',
      source: 'config',
      status: 'active',
      resourceGroup: 'localhost',
    });

    const next = registry();
    await next.start({ config: [] });
    expect(next.backendViews()).toEqual([
      expect.objectContaining({ id: 'sdxl', status: 'tombstoned' }),
    ]);
    // A tombstoned backend serves nothing: its model stays, with no route.
    expect(next.list().map((model) => model.routes)).toEqual([[]]);
    expect(next.all()).toEqual([]);
  });

  it('refuse what cannot be taken, naming the backend', async () => {
    const refuse = async (entry: ConfigBackend, message: RegExp) => {
      await expect(registry().start({ config: [entry] })).rejects.toThrow(message);
    };
    await refuse({ id: 'x', kind: 'comfy', baseUrl: 'http://h' }, /"x" has the kind "comfy"/);
    await refuse(
      { id: 'x', kind: 'sdcpp', baseUrl: 'http://h', settings: { preview: 'often' } },
      /"x" is not valid: preview must be one of/,
    );
    await refuse(
      { id: 'x', kind: 'lemonade', baseUrl: 'http://h', secretsFromEnv: { apiKey: 'NOPE_KEY' } },
      /reads its apiKey from NOPE_KEY, which is not set/,
    );
    await expect(
      registry().start({
        config: [standalone('http://a'), standalone('http://b')],
      }),
    ).rejects.toBeInstanceOf(BackendConfigError);
  });

  it('read secrets from the environment and never write them down', async () => {
    const fake = await lemonade();
    fake.apiKey = 'sesame';
    const started = registry({ env: { LEMONADE_KEY: 'sesame' } });
    await started.start({
      config: [
        {
          id: 'lemon',
          kind: 'lemonade',
          baseUrl: fake.url,
          secretsFromEnv: { apiKey: 'LEMONADE_KEY' },
        },
      ],
    });
    expect(started.backendView('lemon')).toMatchObject({
      secrets: ['apiKey'],
      health: { status: 'ok' },
    });
    expect(db.prepare('select secrets from backends').get()).toEqual({ secrets: null });
  });
});

describe('a standalone sd-server', () => {
  it('serves one route, for the model it reports, registered with a guessed profile (A26)', async () => {
    const server = await sdServer();
    const started = registry();
    await started.start({ config: [standalone(server.url)] });

    const [model] = started.modelViews();
    expect(model).toMatchObject({
      displayName: 'sd_xl_base_1.0',
      family: 'sdxl',
      profile: { family: 'sdxl', name: 'Stable Diffusion XL 1.0' },
      fingerprint: { kind: 'file', stem: 'sd_xl_base_1.0' },
      fixed: false,
    });
    // The profile takes away what SDXL does not support (A6).
    expect(model?.modes).toEqual(['txt2img', 'img2img']);

    const route = started.backendView('sdxl')?.routes[0];
    expect(route).toMatchObject({
      adapterKind: 'sdcpp',
      managerRef: null,
      baseUrl: server.url,
      status: 'active',
      health: { status: 'ok', load_state: 'loaded' },
    });
    const resolverModel = started.get(model!.id);
    expect(resolverModel?.routes[0]).toMatchObject({
      id: route?.id,
      backend_kind: 'sdcpp',
      fingerprint: { kind: 'file', stem: 'sd_xl_base_1.0' },
    });
    const binding = started.binding(route!.id);
    expect(binding).toMatchObject({
      backendId: 'sdxl',
      backendKind: 'sdcpp',
      baseUrl: server.url,
      resourceGroup: 'localhost',
      concurrency: 1,
    });
    expect(binding).not.toHaveProperty('manager');
  });

  it('retires the route when another model answers on the port, and registers that one', async () => {
    const server = await sdServer();
    const started = registry();
    await started.start({ config: [standalone(server.url)] });
    const before = started.backendView('sdxl')!.routes[0]!;

    server.capabilities = withModel(pinnedCapabilities(), KLEIN);
    expect(await started.refreshNow('sdxl')).toBe('ok');
    const routes = started.backendView('sdxl')!.routes;
    expect(routes).toHaveLength(2);
    expect(routes.find((route) => route.id === before.id)).toMatchObject({
      status: 'retired',
      health: { status: 'down', detail: 'The backend now serves another model.' },
    });
    const klein = started.modelViews().find((view) => view.displayName === 'flux-2-klein-4b');
    expect(klein).toMatchObject({ family: 'flux2-klein', variant: 'distilled-4b' });
    // The old route stays bound, so its queued jobs wait as down, not missing.
    expect(started.binding(before.id)).toBeDefined();
    expect(started.get(before.modelId)?.routes[0]?.health.status).toBe('down');

    // The first model back: its route returns, the other's retires.
    server.capabilities = pinnedCapabilities();
    await started.refreshNow('sdxl');
    expect(
      started.backendView('sdxl')!.routes.find((route) => route.id === before.id)?.status,
    ).toBe('active');
  });

  it('marks the route down, not retired, while the instance is down', async () => {
    const server = await sdServer();
    const started = registry();
    await started.start({ config: [standalone(server.url)] });
    await server.close();
    await started.refreshNow('sdxl');
    const view = started.backendView('sdxl')!;
    expect(view.health).toMatchObject({ status: 'down' });
    expect(view.routes[0]).toMatchObject({ status: 'active', health: { status: 'down' } });
  });

  it('serves what it knew from the last run before the backend answers', async () => {
    const server = await sdServer();
    const first = registry();
    await first.start({ config: [standalone(server.url)] });
    const model = first.modelViews()[0]!;
    await first.stop();
    await server.close();

    const next = registry({ startupWaitMs: 1000 });
    await next.start({ config: [standalone(server.url)] });
    // The cached descriptor, merged: the model resolves, and waits while its backend is down.
    const route = next.get(model.id)?.routes[0];
    expect(route?.descriptor.modes.txt2img).toBeDefined();
    expect(route?.health.status).toBe('down');
  });

  it('publishes backend.health when what a client sees changes, and only then', async () => {
    const server = await sdServer();
    const started = registry();
    await started.start({ config: [standalone(server.url)] });
    const health = () => published.filter((event) => event.type === 'backend.health');
    expect(health()).toHaveLength(1);
    expect(health()[0]?.data).toMatchObject({
      backend: 'sdxl',
      health: { status: 'ok' },
      routes: [{ status: 'active', health: { status: 'ok' } }],
    });
    await started.refreshNow('sdxl');
    expect(health()).toHaveLength(1);
    await server.close();
    await started.refreshNow('sdxl');
    expect(health()).toHaveLength(2);
  });
});

describe('Lemonade (SD6)', () => {
  it('finds each loaded image model as a route the sd.cpp adapter serves at the child’s address', async () => {
    const sdxl = await sdServer();
    const klein = await sdServer({ capabilities: withModel(pinnedCapabilities(), KLEIN) });
    const fake = await lemonade();
    fake.children = [
      { name: 'SDXL-Base-1.0', origin: sdxl.origin },
      { name: 'Flux-2-Klein-4B', origin: klein.origin },
    ];
    const started = registry();
    await started.start({ config: [{ id: 'lemon', kind: 'lemonade', baseUrl: fake.url }] });

    const view = started.backendView('lemon')!;
    expect(view).toMatchObject({ role: 'manager', health: { status: 'ok', load_state: 'loaded' } });
    expect(
      view.routes.map((route) => [route.managerRef, route.baseUrl, route.adapterKind]),
    ).toEqual([
      ['SDXL-Base-1.0', sdxl.origin, 'sdcpp'],
      ['Flux-2-Klein-4B', klein.origin, 'sdcpp'],
    ]);
    // Named as Lemonade names them, the profile guessed from every name.
    expect(started.modelViews().map((model) => [model.displayName, model.family])).toEqual([
      ['Flux-2-Klein-4B', 'flux2-klein'],
      ['SDXL-Base-1.0', 'sdxl'],
    ]);
    expect(started.binding(view.routes[0]!.id)).toMatchObject({
      baseUrl: sdxl.origin,
      manager: { kind: 'lemonade', ref: 'SDXL-Base-1.0' },
      resourceGroup: defaultResourceGroup(fake.url),
    });
    // Lemonade's own health route was asked; the children only for what they serve.
    expect(sdxl.received.map((entry) => entry.path)).not.toContain('/');
  });

  it('retires a route when its model unloads, and takes it back on another port', async () => {
    const sdxl = await sdServer();
    const fake = await lemonade();
    fake.children = [{ name: 'SDXL-Base-1.0', origin: sdxl.origin }];
    const started = registry();
    await started.start({ config: [{ id: 'lemon', kind: 'lemonade', baseUrl: fake.url }] });
    const route = started.backendView('lemon')!.routes[0]!;

    fake.children = [];
    await started.refreshNow('lemon');
    expect(started.backendView('lemon')!.routes[0]).toMatchObject({
      id: route.id,
      status: 'retired',
      health: { status: 'down', load_state: 'cold' },
    });

    const moved = await sdServer();
    fake.children = [{ name: 'SDXL-Base-1.0', origin: moved.origin }];
    await started.refreshNow('lemon');
    const back = started.backendView('lemon')!.routes;
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ id: route.id, status: 'active', baseUrl: moved.origin });
    expect(started.binding(route.id)?.baseUrl).toBe(moved.origin);
    // Its capabilities were read again at the new address.
    expect(moved.received.some((entry) => entry.path === '/sdcpp/v1/capabilities')).toBe(true);
  });

  it('keeps seeing the other children when one cannot be described', async () => {
    const broken = await sdServer();
    const sdxl = await sdServer({ capabilities: withModel(pinnedCapabilities(), KLEIN) });
    const fake = await lemonade();
    fake.children = [
      { name: 'Broken', origin: broken.origin },
      { name: 'Flux-2-Klein-4B', origin: sdxl.origin },
    ];
    // Says which model it serves, then fails when asked again for the descriptor.
    const capabilities = withModel(pinnedCapabilities(), '/models/broken.safetensors');
    const path = '/sdcpp/v1/capabilities';
    broken.scripted.push(
      { request: { method: 'GET', path }, response: { status: 200, body: capabilities } },
      { request: { method: 'GET', path }, response: { status: 500, body: { error: 'boom' } } },
    );
    const started = registry();
    await started.start({ config: [{ id: 'lemon', kind: 'lemonade', baseUrl: fake.url }] });
    const routes = started.backendView('lemon')!.routes;
    expect(routes.map((route) => [route.managerRef, route.health.status])).toEqual([
      ['Broken', 'degraded'],
      ['Flux-2-Klein-4B', 'ok'],
    ]);
  });

  it('is down, its routes with it, when Lemonade does not answer', async () => {
    const sdxl = await sdServer();
    const fake = await lemonade();
    fake.children = [{ name: 'SDXL-Base-1.0', origin: sdxl.origin }];
    const started = registry();
    await started.start({ config: [{ id: 'lemon', kind: 'lemonade', baseUrl: fake.url }] });
    await fake.close();
    await started.refreshNow('lemon');
    expect(started.backendView('lemon')).toMatchObject({
      health: { status: 'down' },
      routes: [{ status: 'active', health: { status: 'down' } }],
    });
  });
});

describe('adding a backend (A26)', () => {
  it('records the proposal card’s choices and serves the backend at once', async () => {
    const server = await sdServer();
    const started = registry();
    await started.start();
    const outcome = await started.create({
      kind: 'sdcpp',
      base_url: `${server.url}/`,
      models: [
        {
          fingerprint: {
            kind: 'file',
            path: (pinnedCapabilities()['model'] as { path: string }).path,
            stem: 'sd_xl_base_1.0',
          },
          display_name: 'My SDXL',
          family: 'generic',
        },
      ],
    });
    expect(outcome).toMatchObject({ ok: true, id: expect.stringMatching(/^be_/) });
    const id = (outcome as { id: string }).id;
    expect(started.backendView(id)).toMatchObject({
      source: 'ui',
      baseUrl: server.url,
      name: `sd-server (stable-diffusion.cpp) at ${server.url}`,
      routes: [{ status: 'active' }],
    });
    // The person's choices, not the guess (which was sdxl).
    expect(started.modelViews()[0]).toMatchObject({ displayName: 'My SDXL', family: 'generic' });
    expect(started.modelViews()[0]?.modes).toEqual(['txt2img', 'img2img', 'inpaint']);

    expect(await started.create({ kind: 'sdcpp', base_url: server.url })).toMatchObject({
      ok: false,
      kind: 'conflict',
    });
  });

  it('refuses an unknown kind, bad settings or secrets, and an unknown profile, saying where', async () => {
    const started = registry();
    await started.start();
    const issues = async (body: Parameters<BackendRegistry['create']>[0]) => {
      const outcome = await started.create(body);
      return outcome.ok ? [] : 'issues' in outcome ? outcome.issues.map((issue) => issue.path) : [];
    };
    expect(await issues({ kind: 'comfy', base_url: 'http://h' })).toEqual(['/kind']);
    expect(await issues({ kind: 'sdcpp', base_url: 'http://h', settings: { x: 1 } })).toEqual([
      '/settings',
    ]);
    expect(await issues({ kind: 'sdcpp', base_url: 'http://h', secrets: { apiKey: 'k' } })).toEqual(
      ['/secrets'],
    );
    expect(
      await issues({
        kind: 'sdcpp',
        base_url: 'http://h',
        models: [{ fingerprint: { kind: 'file', path: '/m', stem: 'm' }, family: 'sd3' }],
      }),
    ).toEqual(['/models/0/family']);
    expect(started.backendViews()).toEqual([]);
  });

  it('keeps a backend that is down when added; its routes come when it answers', async () => {
    const started = registry({ createWaitMs: 2000 });
    await started.start();
    const outcome = await started.create({ kind: 'sdcpp', base_url: 'http://127.0.0.1:9/' });
    expect(outcome.ok).toBe(true);
    const view = started.backendView((outcome as { id: string }).id);
    expect(view).toMatchObject({ health: { status: 'down' }, routes: [] });
  });
});

describe('changing a model', () => {
  it('takes a new name or profile, clearing the variant when the family changes', async () => {
    const server = await sdServer({ capabilities: withModel(pinnedCapabilities(), KLEIN) });
    const started = registry();
    await started.start({ config: [standalone(server.url)] });
    const model = started.modelViews()[0]!;
    expect(model).toMatchObject({ family: 'flux2-klein', variant: 'distilled-4b' });

    expect(started.updateModel(model.id, { variant: 'base-4b' })).toEqual({ ok: true });
    expect(started.modelView(model.id)).toMatchObject({ variant: 'base-4b' });
    expect(started.updateModel(model.id, { family: 'generic', display_name: 'Klein' })).toEqual({
      ok: true,
    });
    expect(started.modelView(model.id)).toMatchObject({
      family: 'generic',
      variant: null,
      displayName: 'Klein',
      modes: ['txt2img', 'img2img', 'inpaint'],
    });
    expect(started.updateModel(model.id, { family: 'sd3' })).toMatchObject({
      ok: false,
      kind: 'invalid',
      issues: [{ path: '/family' }],
    });
    expect(started.updateModel(model.id, { family: 'sdxl', variant: 'base-4b' })).toMatchObject({
      ok: false,
      issues: [{ path: '/variant' }],
    });
    expect(started.updateModel('mdl_nope', { family: 'sdxl' })).toEqual({
      ok: false,
      kind: 'missing',
    });
  });
});

describe('the development model', () => {
  it('is served from memory beside the database’s, and cannot be changed', async () => {
    const { binding } = await devBackend({ stepMs: 1 });
    const started = registry({ fixed: [devFixedModel(binding)] });
    await started.start();
    expect(started.get(DEV_MODEL_ID)?.routes.map((route) => route.id)).toEqual([DEV_ROUTE_ID]);
    expect(started.binding(DEV_ROUTE_ID)).toBe(binding);
    expect(started.backendViews()).toEqual([
      expect.objectContaining({
        id: 'be_dev_mock',
        source: 'dev',
        health: { status: 'ok', load_state: 'loaded' },
      }),
    ]);
    expect(started.modelView(DEV_MODEL_ID)).toMatchObject({
      fixed: true,
      displayName: 'Development SDXL (mock)',
    });
    expect(started.updateModel(DEV_MODEL_ID, { family: 'generic' })).toEqual({
      ok: false,
      kind: 'fixed',
    });
    expect(db.prepare('select count(*) as n from backends').get()).toEqual({ n: 0 });
  });
});
