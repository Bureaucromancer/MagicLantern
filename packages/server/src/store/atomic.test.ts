// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeFileAtomic, writeJsonAtomic } from './atomic.js';

let root: string;

beforeEach(async () => {
  // realpath: some temp dirs are symlinks or 8.3 aliases, and paths compared
  // against what the code resolves must be the long form.
  root = await realpath(await mkdtemp(join(tmpdir(), 'lantern-atomic-')));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('writes the bytes, creating missing parent directories', async () => {
    const path = join(root, 'a', 'b', 'file.txt');
    await writeFileAtomic(path, 'hello');
    expect(await readFile(path, 'utf8')).toBe('hello');
  });

  it('replaces an existing file whole and leaves no temp file behind', async () => {
    const path = join(root, 'file.bin');
    await writeFile(path, 'old contents that are longer');
    await writeFileAtomic(path, new Uint8Array([1, 2, 3]));
    expect([...(await readFile(path))]).toEqual([1, 2, 3]);
    expect(await readdir(root)).toEqual(['file.bin']);
  });

  it('refuses a missing parent when asked not to create it', async () => {
    const path = join(root, 'missing', 'file.txt');
    await expect(writeFileAtomic(path, 'x', { ensureDirectory: false })).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'applies the requested mode regardless of the umask',
    async () => {
      const path = join(root, 'secret.json');
      await writeFileAtomic(path, '{}', { mode: 0o600 });
      expect((await stat(path)).mode & 0o777).toBe(0o600);

      // And keeps it when the file is rewritten with the same mode.
      await writeFileAtomic(path, '{"a":1}', { mode: 0o600 });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    },
  );
});

describe('writeJsonAtomic', () => {
  it('writes two-space JSON with a trailing newline', async () => {
    const path = join(root, 'library.json');
    await writeJsonAtomic(path, { id: 'lib_x', schema: 1 });
    expect(await readFile(path, 'utf8')).toBe('{\n  "id": "lib_x",\n  "schema": 1\n}\n');
  });
});
