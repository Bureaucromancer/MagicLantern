// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Every file the daemon owns is written through here: temp file, fsync,
 * rename. A crash or a full disk mid-write then leaves the old file or the new
 * one, never a truncated `library.json` or `secrets.json`.
 *
 * The library rather than our own thirty lines, because the fiddly parts are
 * mode and ownership preservation and removing the temp file when a write fails
 * partway: exactly what a hand-rolled version gets right on a laptop and wrong
 * on a NAS. It does not fsync the parent directory; a power cut right after the
 * rename can still lose the rename on some filesystems.
 */

import { mkdir } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname } from 'node:path';

import writeFileAtomicLib from 'write-file-atomic';

/**
 * write-file-atomic does a bare rename, and on Windows a reader holding the
 * destination open (a poll, a virus scanner) makes it fail with EPERM or
 * EACCES. Retried briefly with backoff there; a lock that outlasts a second is
 * a real lock and deserves the error. Elsewhere those codes mean a real
 * permission problem, so they fail at once.
 */
const BUSY_RETRY_MS = platform() === 'win32' ? ([10, 50, 100, 250, 500] as const) : [];

export interface AtomicWriteOptions {
  /** File mode, e.g. 0o600 for secrets. Defaults to the existing file's, else 0o666 less the umask. */
  mode?: number;
  /** Create the parent directory first. Defaults to true. */
  ensureDirectory?: boolean;
}

export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const { mode, ensureDirectory = true } = options;
  if (ensureDirectory) {
    await mkdir(dirname(path), { recursive: true });
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFileAtomicLib(path, data, mode === undefined ? {} : { mode });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const wait = BUSY_RETRY_MS[attempt];
      if ((code !== 'EPERM' && code !== 'EACCES') || wait === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/** JSON with two-space indentation and a trailing newline, so files stay diffable. */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options);
}
