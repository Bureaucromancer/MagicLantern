// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `lantern migrate`: resolve config → writable data dir → instance lock →
 * `migrateAll` → print what changed → release the lock. Refuses while a daemon
 * holds the data directory. Exits 1 when any library could not be brought up
 * to date (a newer library opened read-only is not a failure: there is
 * nothing this build could do for it).
 *
 * What changed goes to stdout, one line per database; the store's own log
 * lines go to stderr, so a script can read the summary on its own.
 */

import { hostname } from 'node:os';

import { newId } from '../../ids.js';
import { consoleStoreLog } from '../../logging.js';
import {
  acquireInstanceLock,
  ensureWritableDataDir,
  migrateAll,
  readMachineBootId,
  type BootIdentity,
  type DatabaseMigration,
  type MigrationReport,
} from '../../store/index.js';
import type { CommandContext } from '../args.js';
import { isUsageError, loadCommandConfig } from '../startup.js';

export async function runMigrate(context: CommandContext): Promise<number> {
  const { platform, pid, stdout, stderr } = context;
  try {
    // The same resolution as serve and set-password (cwd for relative flags).
    const config = loadCommandConfig(context);
    await ensureWritableDataDir(config.dataDir, { uid: context.uid, gid: context.gid });
    return await migrateDataDir({
      dataDir: config.dataDir,
      pid,
      platform,
      hostname: hostname(),
      stdout,
      stderr,
    });
  } catch (error) {
    if (isUsageError(error)) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

export interface MigrateDataDirOptions {
  /** Absolute, and already checked writable. */
  readonly dataDir: string;
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  readonly hostname: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

/** The command after config: lock, migrate, report, release. Throws the store's refusals. */
export async function migrateDataDir(options: MigrateDataDirOptions): Promise<number> {
  // lock.ts keeps the handle referenced at module level until release, so
  // the garbage collector cannot let it go mid-run.
  const lock = acquireInstanceLock(options.dataDir);
  try {
    const boot: BootIdentity = {
      machineBootId: await readMachineBootId(options.platform),
      hostname: options.hostname,
      pid: options.pid,
      processId: newId('proc'),
    };
    const report = await migrateAll(options.dataDir, {
      boot,
      log: consoleStoreLog(options.stderr),
    });
    for (const line of describeMigrationReport(report)) options.stdout.write(`${line}\n`);

    const failed = report.libraries.filter((library) => library.status === 'unavailable').length;
    if (failed > 0) {
      options.stderr.write(
        failed === 1
          ? '1 library is unavailable and was not migrated.\n'
          : `${String(failed)} libraries are unavailable and were not migrated.\n`,
      );
      return 1;
    }
    return 0;
  } finally {
    lock.release();
  }
}

/** One line per database, for a person. */
export function describeMigrationReport(report: MigrationReport): string[] {
  const lines = [`lantern.db: ${describeMigration(report.install)}`];
  for (const library of report.libraries) {
    const label = `Library "${library.name}" (${library.id})`;
    if (library.status === 'ok' && library.migration !== null) {
      lines.push(`${label}: ${describeMigration(library.migration)}`);
    } else {
      lines.push(
        `${label}: ${library.status}.${library.reason === undefined ? '' : ` ${library.reason}`}`,
      );
    }
  }
  return lines;
}

function describeMigration({ from, to, snapshot }: DatabaseMigration): string {
  if (from === to) return `up to date at schema ${String(to)}.`;
  if (from === 0) return `created at schema ${String(to)}.`;
  return (
    `migrated from schema ${String(from)} to ${String(to)}` +
    (snapshot === null ? '.' : `; snapshot at ${snapshot}.`)
  );
}
