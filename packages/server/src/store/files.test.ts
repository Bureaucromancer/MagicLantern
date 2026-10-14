// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tempRoot } from '../test-app.js';
import { DataDirError, describeUnusableDataDir, ensureWritableDataDir } from './files.js';

let root: string;

beforeEach(async () => {
  root = await tempRoot('lantern-files-');
});

afterEach(async () => {
  await chmod(root, 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe('ensureWritableDataDir', () => {
  it('creates a missing directory, parents included', async () => {
    const dataDir = join(root, 'a', 'b', 'data');
    await ensureWritableDataDir(dataDir);
    expect((await stat(dataDir)).isDirectory()).toBe(true);
  });

  it('accepts an existing writable directory', async () => {
    await expect(ensureWritableDataDir(root)).resolves.toBeUndefined();
  });

  it('refuses a path that is a file, naming the settings to check', async () => {
    const path = join(root, 'file');
    await writeFile(path, '');
    const error = await ensureWritableDataDir(join(path, 'data')).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DataDirError);
    expect((error as Error).message).toContain('--data, LANTERN_DATA_DIR or dataDir');
  });

  // Root ignores permission bits, so the check would pass for the wrong reason.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses a directory it cannot write, with a chown hint for the user it runs as',
    async () => {
      const locked = join(root, 'locked');
      await mkdir(locked);
      await chmod(locked, 0o500);
      try {
        const error = await ensureWritableDataDir(locked, { uid: 1000, gid: 1000 }).catch(
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(DataDirError);
        expect((error as DataDirError).dataDir).toBe(locked);
        expect((error as Error).message).toContain('not writable by uid 1000');
        expect((error as Error).message).toContain('chown -R 1000:1000');
      } finally {
        await chmod(locked, 0o700);
      }
    },
  );

  // SQLite opens a file it may not write read-only without a word: a shared
  // lock for any number of daemons, or a stack trace at the first write.
  it
    .skipIf(process.platform === 'win32' || process.getuid?.() === 0)
    .each(['lantern.lock', 'lantern.db', 'lantern.db-wal', 'lantern.db-shm'])(
    'refuses a %s it cannot write in a writable directory, naming it',
    async (name) => {
      const path = join(root, name);
      await writeFile(path, '');
      await chmod(path, 0o444);
      const error = await ensureWritableDataDir(root, { uid: 1000, gid: 1000 }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(DataDirError);
      expect((error as Error).message).toContain(`EACCES on access ${path}`);
      expect((error as Error).message).toContain('chown -R 1000:1000');
    },
  );

  it('is content with the files it checks being absent, or writable', async () => {
    await writeFile(join(root, 'lantern.db'), '');
    await expect(ensureWritableDataDir(root)).resolves.toBeUndefined();
  });
});

describe('describeUnusableDataDir', () => {
  const eacces = Object.assign(new Error('denied'), {
    code: 'EACCES',
    syscall: 'mkdir',
    path: '/data',
  });

  it('gives a chown hint for permission errors', () => {
    expect(describeUnusableDataDir(eacces, '/data', { uid: 1000, gid: 100 })).toBe(
      'The data directory /data is not writable by uid 1000 (EACCES on mkdir /data). ' +
        'If it is a mounted volume, make it writable by that user on the host, e.g. chown -R 1000:100 <directory>, then start again.',
    );
  });

  it('says "this process" where the platform has no uid', () => {
    expect(describeUnusableDataDir(eacces, '/data')).toContain('not writable by this process');
    expect(describeUnusableDataDir(eacces, '/data')).toContain('chown -R <uid>:<gid>');
  });

  it('points at the settings for anything else', () => {
    const error = Object.assign(new Error('nope'), { code: 'ENOTDIR' });
    expect(describeUnusableDataDir(error, '/data')).toContain('ENOTDIR');
    expect(describeUnusableDataDir(error, '/data')).toContain(
      '--data, LANTERN_DATA_DIR or dataDir',
    );
  });
});
