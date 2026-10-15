// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `lantern library backup --out <dir> [--library <id>]` (ST6): copies each
 * library (or the one named) into `<dir>/<library id>/`, from a `VACUUM INTO`
 * snapshot of its database plus the asset files that snapshot holds. Safe
 * while the daemon runs, so it takes no instance lock (store/backup.ts).
 *
 * One line per library on stdout; a library that could not be backed up is
 * a line on stderr and makes the exit code 1, while the rest still go.
 * To restore, stop Lantern and put the folder back as
 * `<data>/libraries/<library id>/`.
 */

import { resolve } from 'node:path';

import { backupLibraries, type BackupOutcome } from '../../store/backup.js';
import type { CommandContext } from '../args.js';
import { isUsageError, loadCommandConfig } from '../startup.js';

export async function runLibraryBackup(context: CommandContext): Promise<number> {
  const { args, stdout, stderr } = context;
  try {
    const config = loadCommandConfig(context);
    if (args.out === undefined) throw new Error('parseCliArgs requires --out for library backup.');
    const outcomes = await backupLibraries({
      dataDir: config.dataDir,
      out: resolve(context.cwd ?? '.', args.out),
      ...(args.library === undefined ? {} : { library: args.library }),
    });
    let failed = 0;
    for (const outcome of outcomes) {
      if (outcome.ok) stdout.write(`${describeBackup(outcome)}\n`);
      else {
        failed += 1;
        stderr.write(`${describeBackup(outcome)}\n`);
      }
    }
    if (outcomes.length === 0) stdout.write('There are no libraries to back up.\n');
    return failed === 0 ? 0 : 1;
  } catch (error) {
    if (isUsageError(error)) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

/** One line for a person. */
export function describeBackup(outcome: BackupOutcome): string {
  const label = `Library "${outcome.name}" (${outcome.id})`;
  if (!outcome.ok) return `${label}: not backed up. ${outcome.reason}`;
  const size = `${(outcome.bytes / (1024 * 1024)).toFixed(1)} MB`;
  const assets = outcome.assets === 1 ? '1 asset' : `${String(outcome.assets)} assets`;
  const missing =
    outcome.missing === 0
      ? ''
      : ` ${String(outcome.missing)} deleted while it ran ${outcome.missing === 1 ? 'is' : 'are'} marked deleted in the copy.`;
  return `${label}: backed up to ${outcome.path} (${assets}, ${size}).${missing}`;
}
