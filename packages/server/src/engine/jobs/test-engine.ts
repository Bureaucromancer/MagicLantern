// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * A job engine over a real data directory and the mock adapter, for the
 * engine's tests and the job routes' tests. Restartable: `restart()` stops
 * the engine and starts another over the same libraries and the same mock
 * (a daemon restart with the backend still running), or a new mock (the
 * backend restarted too).
 */

import type { GenerationRequest } from '@bureaucromancer/lantern-schema';

import type { MockAdapter, MockSettings } from '../../adapters/mock/index.js';
import { openInstall } from '../../store/install.js';
import { openLibraries } from '../../store/libraries.js';
import { collectingLog, removeDir, tempDir, testBoot } from '../../store/test-store.js';
import type { InstallStore, LibraryRegistry } from '../../store/types.js';
import { createValidator } from '../../validation/ajv.js';
import { devBackend, devModel, DEV_MODEL_ID, InMemoryModelCatalog } from '../catalog/index.js';
import { builtinProfiles } from '../profiles/index.js';
import { createResolver, type SeedSource } from '../resolver/index.js';
import { StaticBindings } from './bindings.js';
import { JobEngine } from './engine.js';
import { EventBus, type StampedEvent } from './events.js';

export interface EngineHarness {
  readonly dataDir: string;
  readonly libraries: LibraryRegistry;
  /** The default library's id. */
  readonly lib: string;
  readonly events: EventBus;
  readonly seen: StampedEvent[];
  engine: JobEngine;
  adapter: MockAdapter;
  readonly catalog: InMemoryModelCatalog;
  /** Stops the engine and starts another; `freshBackend` replaces the mock too. */
  restart(options?: {
    readonly freshBackend?: boolean;
    readonly beforeStart?: () => Promise<void>;
  }): Promise<void>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  readonly mock?: MockSettings;
  readonly drawSeed?: SeedSource;
  readonly blockedRetryMs?: number;
}

export async function engineHarness(options: HarnessOptions = {}): Promise<EngineHarness> {
  const dataDir = await tempDir('engine');
  const install: InstallStore = (
    await openInstall(dataDir, { boot: testBoot(), log: collectingLog() })
  ).store;
  const libraries = (await openLibraries(install, dataDir, { log: collectingLog() })).registry;
  const profiles = builtinProfiles();
  const catalog = new InMemoryModelCatalog([devModel(options.mock?.profile)], profiles);
  const resolver = createResolver({
    ajv: createValidator(),
    profiles,
    ...(options.drawSeed === undefined ? {} : { drawSeed: options.drawSeed }),
  });
  const events = new EventBus('boot_test');
  const seen: StampedEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const settings: MockSettings = { stepMs: 1, ...options.mock };

  const build = (
    adapter: MockAdapter,
    binding: Awaited<ReturnType<typeof devBackend>>['binding'],
  ) =>
    new JobEngine({
      libraries,
      models: catalog,
      resolver,
      bindings: new StaticBindings([binding]),
      events,
      log: collectingLog(),
      pollMs: 2,
      blockedRetryMs: options.blockedRetryMs ?? 40,
    });

  let backend = await devBackend(settings);
  const harness: EngineHarness = {
    dataDir,
    libraries,
    lib: libraries.list()[0]!.id,
    events,
    seen,
    engine: build(backend.adapter, backend.binding),
    adapter: backend.adapter,
    catalog,
    async restart(restartOptions = {}) {
      await harness.engine.stop();
      if (restartOptions.freshBackend === true) backend = await devBackend(settings);
      harness.adapter = backend.adapter;
      harness.engine = build(backend.adapter, backend.binding);
      await restartOptions.beforeStart?.();
      await harness.engine.start();
    },
    async close() {
      await harness.engine.stop();
      libraries.close();
      install.close();
      await removeDir(dataDir);
    },
  };
  await harness.engine.start();
  return harness;
}

/** A small txt2img request: 64 × 64, four steps. */
export function smallRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    schema_version: 1,
    mode: 'txt2img',
    prompt: { positive: 'a lighthouse at dusk' },
    geometry: { width: 64, height: 64 },
    sampling: { seed: 42, steps: 4 },
    ...overrides,
  };
}

export { DEV_MODEL_ID };
