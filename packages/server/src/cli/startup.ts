// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The startup steps every command that touches the data directory shares, in
 * the contract's order: resolve config → writable-dir check → instance lock.
 * (`serve` and `migrate` then open the stores; `set-password` writes secrets.)
 */

import { loadConfig } from '../config/load.js';
import { ConfigError, type ResolvedConfig } from '../config/schema.js';
import { StoreError } from '../store/errors.js';
import { DataDirError, ensureWritableDataDir } from '../store/files.js';
import { SecretsError } from '../store/secrets.js';
import type { InstanceLock } from '../store/types.js';
import { UsageError, type CommandContext } from './args.js';

/** lantern.json and the environment, with `--config` and `--data` applied. */
export function loadCommandConfig(context: CommandContext): ResolvedConfig {
  const { args, env, platform, homedir, cwd } = context;
  return loadConfig({
    path: args.configPath,
    dataDir: args.dataDir,
    env,
    platform,
    homedir,
    cwd,
  });
}

/**
 * The lock this process holds. Module-level on purpose: the lock is a SQLite
 * handle, and a handle only a local variable referenced could be collected,
 * which closes it and drops the lock while the daemon still runs.
 */
let heldLock: InstanceLock | null = null;

/**
 * Checks the data directory is writable, then takes the instance lock (one
 * Lantern per data directory). Writable first, because "cannot write here"
 * is the better answer when both apply.
 */
export async function holdDataDir(
  config: Pick<ResolvedConfig, 'dataDir'>,
  context: Pick<CommandContext, 'uid' | 'gid'>,
  acquire: (dataDir: string) => InstanceLock,
): Promise<InstanceLock> {
  await ensureWritableDataDir(config.dataDir, { uid: context.uid, gid: context.gid });
  const lock = acquire(config.dataDir);
  heldLock = lock;
  return {
    release() {
      if (heldLock === lock) heldLock = null;
      lock.release();
    },
  };
}

/**
 * Errors that are the operator's to fix and say so in one sentence: printed
 * without a stack, exit 1. Anything else is a bug and keeps its stack.
 */
export function isUsageError(error: unknown): error is Error {
  return (
    error instanceof UsageError ||
    error instanceof ConfigError ||
    error instanceof DataDirError ||
    error instanceof SecretsError ||
    // The store's actionable refusals: a held lock, a newer database, a failed snapshot.
    error instanceof StoreError
  );
}
