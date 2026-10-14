// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import type { ChildProcess } from 'node:child_process';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dataPaths } from '../../store/paths.js';
import {
  aProcessHoldingTheLock,
  killAndWait,
  lockIsFreeElsewhere,
  removeDir,
  tempDir,
  withDatabase,
} from '../../store/test-store.js';
import type { CommandContext } from '../args.js';
import { describeMigrationReport, migrateDataDir, runMigrate } from './migrate.js';

let root: string;
let dataDir: string;
let child: ChildProcess | null = null;

beforeEach(async () => {
  root = await tempDir('migrate-command');
  dataDir = join(root, 'data');
  // migrateDataDir runs after the writable-directory check, which creates it.
  await mkdir(dataDir);
});

afterEach(async () => {
  if (child !== null) await killAndWait(child);
  child = null;
  await removeDir(root);
});

/** A stream that remembers what was written to it. */
function capture(): PassThrough & { text: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  return Object.assign(stream, { text: () => chunks.join('') });
}

function options(stdout = capture(), stderr = capture()) {
  return { dataDir, pid: 4242, platform: process.platform, hostname: 'test-host', stdout, stderr };
}

describe('migrateDataDir', () => {
  it('sets up a new data directory, says so on stdout, and lets the lock go', async () => {
    const stdout = capture();
    expect(await migrateDataDir(options(stdout))).toBe(0);
    expect(stdout.text()).toMatch(
      /^lantern\.db: created at schema 1\.\nLibrary "Library" \(lib_[0-9A-Z]{26}\): created at schema 1\.\n$/,
    );
    expect(lockIsFreeElsewhere(dataPaths(dataDir).lock)).toBe(true);
  });

  it('reports up to date the second time', async () => {
    await migrateDataDir(options());
    const stdout = capture();
    expect(await migrateDataDir(options(stdout))).toBe(0);
    expect(stdout.text()).toMatch(
      /^lantern\.db: up to date at schema 1\.\nLibrary .*: up to date at schema 1\.\n$/,
    );
  });

  it('exits 1 when a library is unavailable, naming it', async () => {
    await migrateDataDir(options());
    withDatabase(dataPaths(dataDir).installDb, (db) => {
      db.prepare("update libraries set path = 'libraries/lib_00000000000000000000000000'").run();
    });
    const stdout = capture();
    const stderr = capture();
    expect(await migrateDataDir(options(stdout, stderr))).toBe(1);
    expect(stdout.text()).toMatch(
      /Library "Library" \(lib_[0-9A-Z]{26}\): unavailable\. Its database .* was not found\./,
    );
    expect(stderr.text()).toContain('1 library is unavailable and was not migrated.');
  });

  it('refuses while another process holds the data directory', async () => {
    await migrateDataDir(options());
    child = await aProcessHoldingTheLock(dataPaths(dataDir).lock);
    await expect(migrateDataDir(options())).rejects.toThrow(/Another Lantern is already using/);
  });
});

describe('describeMigrationReport', () => {
  it('says what happened to each database in a line', () => {
    expect(
      describeMigrationReport({
        install: { from: 1, to: 2, snapshot: '/data/backups/lantern.v1.X.db' },
        libraries: [
          {
            id: 'lib_A',
            name: 'Newer',
            path: 'libraries/lib_A',
            status: 'read-only',
            reason: 'It was written by a newer Lantern.',
            schemaVersion: 3,
            migration: null,
          },
        ],
      }),
    ).toEqual([
      'lantern.db: migrated from schema 1 to 2; snapshot at /data/backups/lantern.v1.X.db.',
      'Library "Newer" (lib_A): read-only. It was written by a newer Lantern.',
    ]);
  });
});

describe('runMigrate', () => {
  function context(
    stdout: PassThrough,
    stderr: PassThrough,
    args: Partial<CommandContext['args']> = {},
  ): CommandContext {
    return {
      args: {
        command: 'migrate',
        clear: false,
        configPath: join(root, 'lantern.json'),
        dataDir,
        ...args,
      },
      env: {},
      pid: 4242,
      platform: process.platform,
      homedir: root,
      stdin: new PassThrough() as unknown as NodeJS.ReadStream,
      stdout,
      stderr,
    };
  }

  it('reads the config, migrates the data directory and exits 0', async () => {
    const stdout = capture();
    expect(await runMigrate(context(stdout, capture()))).toBe(0);
    expect(stdout.text()).toContain('lantern.db: created at schema 1.');
  });

  it('prints a refusal as one sentence and exits 1', async () => {
    await runMigrate(context(capture(), capture()));
    child = await aProcessHoldingTheLock(dataPaths(dataDir).lock);
    const stderr = capture();
    expect(await runMigrate(context(capture(), stderr))).toBe(1);
    expect(stderr.text()).toBe(`Another Lantern is already using the data directory ${dataDir}.\n`);
  });

  // Root ignores permission bits, so the files would be writable after all.
  it
    .skipIf(process.platform === 'win32' || process.getuid?.() === 0)
    .each(['lantern.lock', 'lantern.db'])(
    'prints a %s it cannot write as one sentence with a chown hint, and exits 1',
    async (name) => {
      await runMigrate(context(capture(), capture()));
      const path = join(dataDir, name);
      await chmod(path, 0o444);
      const stderr = capture();
      expect(await runMigrate(context(capture(), stderr))).toBe(1);
      expect(stderr.text()).toContain(`EACCES on access ${path}`);
      expect(stderr.text()).toContain('chown -R');
      expect(stderr.text().trim().split('\n')).toHaveLength(1);
    },
  );

  it('prints a lock file that is not one as one sentence and exits 1', async () => {
    const lockPath = dataPaths(dataDir).lock;
    await writeFile(lockPath, 'hello');
    const stderr = capture();
    expect(await runMigrate(context(capture(), stderr))).toBe(1);
    expect(stderr.text()).toBe(
      `${lockPath} is not a Lantern lock file; remove it and start again.\n`,
    );
  });

  it('prints a config error as one sentence and exits 1', async () => {
    await writeFile(join(root, 'lantern.json'), '{ not json');
    const stderr = capture();
    expect(await runMigrate(context(capture(), stderr))).toBe(1);
    expect(stderr.text()).toMatch(/lantern\.json is not valid/);
    expect(stderr.text().trim().split('\n')).toHaveLength(1);
  });

  it('resolves a relative --data against the command directory, as serve does', async () => {
    const stdout = capture();
    const relative = { ...context(stdout, capture(), { dataDir: 'elsewhere' }), cwd: root };
    expect(await runMigrate(relative)).toBe(0);
    expect(stdout.text()).toContain('lantern.db: created at schema 1.');
    // Created where cwd says, not in the test runner's own directory.
    await expect(stat(dataPaths(join(root, 'elsewhere')).installDb)).resolves.toBeDefined();
  });
});
