// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Filesystem checks the CLI runs before anything opens the data directory.
 *
 * Asked first and answered in one sentence because the alternative was met in
 * practice: a container volume Docker created as root, a daemon running as uid
 * 1000, and an EACCES stack trace out of a `mkdir` with the fix nowhere in it.
 */

import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { DATA_LAYOUT } from './paths.js';

/**
 * The data directory cannot be used. A usage error: one sentence, with a chown
 * hint for EACCES/EPERM (a container volume owned by root while the daemon
 * runs as another user), naming `--data`, `LANTERN_DATA_DIR` and `dataDir`.
 */
export class DataDirError extends Error {
  readonly dataDir: string;

  constructor(dataDir: string, message: string) {
    super(message);
    this.name = 'DataDirError';
    this.dataDir = dataDir;
  }
}

/** Who the process runs as, where the platform says (not on Windows). */
export interface ProcessIdentity {
  readonly uid?: number | undefined;
  readonly gid?: number | undefined;
}

/** The sentence for an unusable data directory: a chown hint for permissions, the settings otherwise. */
export function describeUnusableDataDir(
  error: unknown,
  dataDir: string,
  identity: ProcessIdentity = {},
): string {
  const { code, syscall, path } = (error ?? {}) as NodeJS.ErrnoException;
  const what = `${code ?? 'error'} on ${syscall ?? 'access'} ${path ?? dataDir}`;
  if (code === 'EACCES' || code === 'EPERM') {
    const { uid, gid } = identity;
    const user = uid === undefined ? 'this process' : `uid ${String(uid)}`;
    const owner = uid === undefined ? '<uid>:<gid>' : `${String(uid)}:${String(gid ?? uid)}`;
    return (
      `The data directory ${dataDir} is not writable by ${user} (${what}). ` +
      `If it is a mounted volume, make it writable by that user on the host, e.g. chown -R ${owner} <directory>, then start again.`
    );
  }
  return (
    `The data directory ${dataDir} cannot be created or written (${what}). ` +
    'Check the path given by --data, LANTERN_DATA_DIR or dataDir in lantern.json.'
  );
}

/**
 * The files in the data directory SQLite opens for writing in place, checked
 * one by one because SQLite opens a file it may not write read-only without
 * a word. A read-only `lantern.lock` then takes only a shared lock, so a
 * second daemon "holds" it too; a read-only `lantern.db` fails at its first
 * write, with a stack trace, and leaves `-wal`/`-shm` files beside it that
 * nobody can write either. That is what a non-recursive chown of a volume, or
 * one `sudo lantern migrate`, leaves behind.
 */
const WRITTEN_IN_PLACE = [
  DATA_LAYOUT.lock,
  DATA_LAYOUT.installDb,
  `${DATA_LAYOUT.installDb}-wal`,
  `${DATA_LAYOUT.installDb}-shm`,
] as const;

/**
 * Creates the directory if needed and checks that it, and the files Lantern
 * writes in place inside it, are writable, or throws {@link DataDirError}.
 * `access` opens no descriptor, so it never drops a lock this process holds
 * on `lantern.lock` (closing any fd to that file would).
 */
export async function ensureWritableDataDir(
  dataDir: string,
  identity: ProcessIdentity = {},
): Promise<void> {
  try {
    await mkdir(dataDir, { recursive: true });
    await access(dataDir, constants.W_OK);
    for (const name of WRITTEN_IN_PLACE) await writableIfPresent(join(dataDir, name));
  } catch (error) {
    throw new DataDirError(dataDir, describeUnusableDataDir(error, dataDir, identity));
  }
}

/** Throws the access error for a file that exists and cannot be written; a missing one is fine. */
async function writableIfPresent(path: string): Promise<void> {
  try {
    await access(path, constants.W_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
