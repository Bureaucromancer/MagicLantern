// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../ids.js';
import { assetPath, thumbnailPath } from './asset-files.js';
import { backupLibraries } from './backup.js';
import { openInstall } from './install.js';
import { openLibraries } from './libraries.js';
import type { Library } from './library-types.js';
import { libraryPaths, libraryPathsAt } from './paths.js';
import { vacuumInto } from './snapshot-worker.js';
import { collectingLog, removeDir, tempDir, testBoot, withDatabase } from './test-store.js';
import { makePng } from './test-images.js';
import type { InstallStore, LibraryRegistry } from './types.js';

let dataDir: string;
let out: string;
let install: InstallStore;
let registry: LibraryRegistry;
let lib: string;
let library: Library;

beforeEach(async () => {
  dataDir = await tempDir('backup-data');
  out = join(await tempDir('backup-out'), 'backups');
  install = (await openInstall(dataDir, { boot: testBoot(), log: collectingLog() })).store;
  registry = (await openLibraries(install, dataDir, { log: collectingLog() })).registry;
  lib = registry.list()[0]!.id;
  library = registry.library(lib)!;
});

afterEach(async () => {
  registry.close();
  install.close();
  await removeDir(dataDir);
  await removeDir(join(out, '..'));
});

describe('backupLibraries', () => {
  it('copies the database and the present assets, while the daemon has them open', async () => {
    const kept = await library.ingestUpload(makePng(8, 8, { seed: 1 }));
    const trashed = await library.ingestUpload(makePng(8, 8, { seed: 2 }));
    await library.deleteAsset(trashed.asset.id);

    const [outcome] = await backupLibraries({ dataDir, out });
    const target = join(out, lib);
    expect(outcome).toEqual({
      ok: true,
      id: lib,
      name: 'Library',
      path: target,
      assets: 1,
      bytes: kept.asset.bytes,
      missing: 0,
    });

    const copy = libraryPathsAt(target);
    expect(await readFile(assetPath(copy, kept.asset.id, 'image/png'))).toEqual(
      await readFile(
        assetPath(libraryPaths(dataDir, `libraries/${lib}`), kept.asset.id, 'image/png'),
      ),
    );
    // Thumbnails are a cache, and are not copied.
    expect(existsSync(thumbnailPath(copy, kept.asset.id))).toBe(false);
    expect(JSON.parse(await readFile(copy.manifest, 'utf8'))).toMatchObject({ id: lib });
    // A whole database, with nothing beside it.
    expect((await readdir(target)).sort()).toEqual(['assets', 'library.db', 'library.json']);
    expect(
      withDatabase(
        copy.db,
        (db) => db.prepare('select id, bytes_state from assets order by bytes_state').all(),
        true,
      ),
    ).toEqual([
      { id: kept.asset.id, bytes_state: 'present' },
      { id: trashed.asset.id, bytes_state: 'trashed' },
    ]);
  });

  it('marks trashed in the copy an asset whose file went while it ran', async () => {
    const { asset } = await library.ingestUpload(makePng(8, 8, { seed: 3 }));
    await rm(assetPath(libraryPaths(dataDir, `libraries/${lib}`), asset.id, 'image/png'));
    const [outcome] = await backupLibraries({ dataDir, out });
    expect(outcome).toMatchObject({ ok: true, assets: 0, missing: 1 });
    expect(
      withDatabase(
        libraryPathsAt(join(out, lib)).db,
        (db) => db.prepare('select bytes_state from assets').get(),
        true,
      ),
    ).toEqual({ bytes_state: 'trashed' });
  });

  it('backs up one library by id, and refuses an unknown one', async () => {
    const second = await registry.create('Second');
    const outcomes = await backupLibraries({ dataDir, out, library: second.id });
    expect(outcomes.map((outcome) => outcome.id)).toEqual([second.id]);
    await expect(backupLibraries({ dataDir, out, library: newId('lib') })).rejects.toThrow(
      /No library has the id/,
    );
  });

  it('never writes over an earlier backup, and leaves nothing half made', async () => {
    await backupLibraries({ dataDir, out });
    const [again] = await backupLibraries({ dataDir, out });
    expect(again).toMatchObject({ ok: false, reason: expect.stringContaining('already exists') });

    const failing = await backupLibraries({
      dataDir,
      out: join(out, 'other'),
      seams: { run: () => Promise.resolve({ ok: false, message: 'disk on fire', errcode: null }) },
    });
    expect(failing).toEqual([
      {
        ok: false,
        id: lib,
        name: 'Library',
        reason: 'Its database could not be copied: disk on fire',
      },
    ]);
    expect(await readdir(join(out, 'other'))).toEqual([]);
  });

  it('reports a library whose database is gone and goes on', async () => {
    const second = await registry.create('Second');
    await rm(libraryPaths(dataDir, `libraries/${second.id}`).db);
    const outcomes = await backupLibraries({
      dataDir,
      out,
      seams: { run: (task) => Promise.resolve(vacuumInto(task)) },
    });
    expect(outcomes.map((outcome) => [outcome.id, outcome.ok])).toEqual([
      [lib, true],
      [second.id, false],
    ]);
  });

  it('refuses a directory that is not a data directory', async () => {
    const empty = await tempDir('backup-empty');
    await writeFile(join(empty, 'readme'), '');
    await expect(backupLibraries({ dataDir: empty, out })).rejects.toThrow(
      /no Lantern data directory/,
    );
    await removeDir(empty);
  });
});
