// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The snapshot worker loaded the way production loads it: from the built
 * dist, by plain node, in a process started with a V8 flag. Two mistakes
 * only this can see: a worker file name hard-coded to `.ts` passes every
 * source test and fails every production snapshot (dist holds only `.js`),
 * and a worker that inherits `process.execArgv` is refused by Node when the
 * daemon was started with `--max-old-space-size`.
 *
 * It needs a build, and says so rather than skipping: CI builds before it
 * tests. A build older than the source tests the old code, so rebuild before
 * believing a failure here that snapshot.test.ts does not share.
 */

import { execFile } from 'node:child_process';
import { stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { removeDir, tempDir } from './test-store.js';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'store');

const NO_BUILD =
  'No built snapshot module under packages/server/dist/store. Run `pnpm build` (or `pnpm typecheck`, which emits) first: this test takes a snapshot through the built JavaScript, the only way to know the worker loads outside vitest.';

/** The child's whole program, plain JavaScript since it runs outside every transform. */
const PROBE = `
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dist, root] = process.argv.slice(2);
const { takeSnapshot } = await import(pathToFileURL(join(dist, 'snapshot.js')).href);

const source = join(root, 'library.db');
const writer = new DatabaseSync(source);
writer.exec('pragma journal_mode = wal');
writer.exec('pragma wal_autocheckpoint = 0');
writer.exec('create table item (id text primary key)');
writer.exec("insert into item values ('saved')");
writer.exec('pragma wal_checkpoint(truncate)');
writer.exec("insert into item values ('in the log')");

const backups = join(root, 'backups');
const path = await takeSnapshot({ source, backupsDir: backups, stem: 'library', fromVersion: 1 });
const copy = new DatabaseSync(path, { readOnly: true });
const ids = copy.prepare('select id from item order by id').all().map((row) => row.id);
copy.close();
writer.close();
console.log(JSON.stringify({ execArgv: process.execArgv, ids, files: readdirSync(backups).length }));
`;

const run = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await tempDir('snapshot-dist');
});

afterEach(async () => {
  await removeDir(root);
});

describe('the built snapshot module', () => {
  it('takes a snapshot on its worker, in a daemon started with a V8 flag', async () => {
    try {
      await stat(join(DIST, 'snapshot-worker.js'));
    } catch {
      throw new Error(NO_BUILD);
    }
    const probe = join(root, 'probe.mjs');
    await writeFile(probe, PROBE);

    const flag = '--max-old-space-size=256';
    let stdout: string;
    try {
      ({ stdout } = await run(process.execPath, [flag, probe, DIST, root]));
    } catch (error) {
      // The child's stderr is the useful half: the worker's own error, or Node's refusal of its flags.
      const stderr = (error as { stderr?: unknown }).stderr;
      throw new Error(
        `The built snapshot module failed in a child process. If snapshot.test.ts passes, rebuild first.\n${String(stderr)}`,
        { cause: error },
      );
    }

    const said: unknown = JSON.parse(stdout.trim().split('\n').at(-1) ?? 'null');
    expect(said).toEqual({ execArgv: [flag], ids: ['in the log', 'saved'], files: 1 });
  });
});
