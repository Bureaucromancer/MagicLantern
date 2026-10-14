// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/** Helpers for the store's tests: real temp directories, a collecting log, a boot identity. */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { BootIdentity, StoreLog } from './types.js';

/**
 * A fresh directory, by its real path: some temp dirs are symlinks (macOS
 * /var → /private/var) or 8.3 aliases, and paths compared against what the
 * code resolves must be the long form.
 */
export async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), `lantern-${prefix}-`)));
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export interface LogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

/** A {@link StoreLog} that keeps what it was told. */
export function collectingLog(): StoreLog & { readonly lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at =
    (level: LogLine['level']) =>
    (message: string, fields: Record<string, unknown> = {}): void => {
      lines.push({ level, message, fields });
    };
  return { lines, info: at('info'), warn: at('warn'), error: at('error') };
}

export function testBoot(overrides: Partial<BootIdentity> = {}): BootIdentity {
  return {
    machineBootId: '00000000-0000-4000-8000-000000000001',
    hostname: 'test-host',
    pid: 4242,
    processId: 'proc_01JTESTPROCESS0000000000000',
    ...overrides,
  };
}

/** Runs `fn` against a database file and closes it, for setting up or inspecting state. */
export function withDatabase<T>(path: string, fn: (db: DatabaseSync) => T, readOnly = false): T {
  const db = new DatabaseSync(path, { readOnly });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** `PRAGMA user_version` of a file, read without writing. */
export function userVersionOf(path: string): number {
  return withDatabase(
    path,
    (db) => Number(db.prepare('pragma user_version').get()?.['user_version']),
    true,
  );
}

/** The script a child process runs to take the instance lock the way lock.ts does. */
const HOLD_LOCK_SCRIPT = [
  "const { DatabaseSync } = require('node:sqlite');",
  'const db = new DatabaseSync(process.argv[1]);',
  "db.exec('pragma locking_mode = exclusive');",
  "db.exec('begin exclusive');",
].join('\n');

/** A process that takes the lock and exits without letting it go. */
export function aProcessThatHeldTheLockAndDied(lockPath: string): void {
  execFileSync(process.execPath, ['-e', `${HOLD_LOCK_SCRIPT}\nprocess.exit(0);`, lockPath], {
    stdio: 'ignore',
  });
}

/** A process that takes the lock and holds it until killed; resolves once it holds it. */
export async function aProcessHoldingTheLock(lockPath: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['-e', `${HOLD_LOCK_SCRIPT}\nconsole.log('held');\nsetInterval(() => {}, 1000);`, lockPath],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      reject(new Error(`The lock-holding child exited early (${String(code)}).`));
    });
    child.stdout.once('data', () => {
      resolve();
    });
  });
  return child;
}

/** Kills a child and waits for it to be gone, so the kernel has released its locks. */
export async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
    child.kill('SIGKILL');
  });
}

/**
 * Asks a separate process whether it could take the lock now. Another process
 * is the only honest probe: a second open in this process is refused whatever
 * the state of the lock this process holds.
 */
export function lockIsFreeElsewhere(lockPath: string): boolean {
  const script = [
    "const { DatabaseSync } = require('node:sqlite');",
    'const db = new DatabaseSync(process.argv[1]);',
    "db.exec('pragma locking_mode = exclusive');",
    "try { db.exec('begin exclusive'); console.log('free'); } catch { console.log('held'); }",
  ].join('\n');
  const said = execFileSync(process.execPath, ['-e', script, lockPath], { encoding: 'utf8' });
  return said.trim() === 'free';
}
