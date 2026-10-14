// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `lantern set-password [--clear]`: reads the new password from stdin, never
 * argv (at a terminal, a prompt without echo; from a pipe, one line; a pipe
 * that closes without a line is refused, not taken as empty), writes the
 * scrypt record to secrets.json, and prints a sentence. Rotates nothing else:
 * the record's fingerprint in every cookie signs existing sessions out. Takes
 * the instance lock, so it refuses while a daemon runs.
 *
 * The console is the authority here: whoever can run this against the data
 * directory can already read it, so there is no old password to confirm. The
 * one limit is sign-in's own maximum length (cli/password-length.ts).
 *
 * The sentence says what the next `lantern serve` will do, and with
 * `LANTERN_PASSWORD` in the environment that is decided by the variable, not
 * by the record this command just wrote or removed.
 */

import { generateSecret, hashPassword } from '../../auth/password.js';
import type { ResolvedConfig } from '../../config/schema.js';
import { acquireInstanceLock } from '../../store/lock.js';
import { readSecrets, writeSecrets } from '../../store/secrets.js';
import type { InstanceLock } from '../../store/types.js';
import type { Command, CommandContext } from '../args.js';
import { readNewPassword, SetPasswordAborted } from '../prompt.js';
import { holdDataDir, loadCommandConfig } from '../startup.js';

/** What the configured mode means for the record just written or removed. */
function modeNote(config: ResolvedConfig, passwordSet: boolean): string {
  const configured = config.auth.mode;
  if (passwordSet) {
    return configured === 'none'
      ? 'auth.mode is "none" in the config, so Lantern will not ask for it until that changes.'
      : 'Lantern asks for it from the next start.';
  }
  return configured === 'password'
    ? 'auth.mode is "password" in the config, so Lantern will not start until a password is set again.'
    : 'Lantern runs with auth mode none from the next start (loopback only, unless auth.trustNetwork is set).';
}

/** What `LANTERN_PASSWORD` in this environment does at the next start, overriding {@link modeNote}. */
function envNote(config: ResolvedConfig, passwordSet: boolean): string {
  if (config.auth.mode === 'none') {
    return 'LANTERN_PASSWORD is set in this environment and auth.mode is "none", so `lantern serve` refuses to start until one of them is unset.';
  }
  return passwordSet
    ? 'LANTERN_PASSWORD is set in this environment; a `lantern serve` that sees it replaces this password with it.'
    : 'LANTERN_PASSWORD is set in this environment, so a `lantern serve` that sees it stores that password again and asks for it.';
}

export function createSetPasswordCommand(
  acquire: (dataDir: string) => InstanceLock = acquireInstanceLock,
): Command {
  return async (context: CommandContext): Promise<number> => {
    const { stdout, stderr } = context;
    const config = loadCommandConfig(context);
    const lock = await holdDataDir(config, context, acquire);
    try {
      const existing = await readSecrets(config.dataDir);
      // An empty value is unset, as serve reads it.
      const fromEnv = (context.env['LANTERN_PASSWORD'] ?? '') !== '';

      if (context.args.clear) {
        if (existing?.password === undefined) {
          stdout.write(`No password is set in ${config.dataDir}; nothing changed.\n`);
          if (fromEnv) stderr.write(`Note: ${envNote(config, false)}\n`);
          return 0;
        }
        await writeSecrets(config.dataDir, { sessionKey: existing.sessionKey });
        stdout.write(
          `Removed the Lantern password in ${config.dataDir}. ${
            fromEnv ? envNote(config, false) : modeNote(config, false)
          }\n`,
        );
        return 0;
      }

      let password: string;
      try {
        password = await readNewPassword(context.stdin, stderr);
      } catch (error) {
        if (!(error instanceof SetPasswordAborted)) throw error;
        stderr.write(`${error.message}\n`);
        return 1;
      }

      await writeSecrets(config.dataDir, {
        sessionKey: existing?.sessionKey ?? generateSecret(),
        password: await hashPassword(password),
      });
      stdout.write(
        `Set the Lantern password in ${config.dataDir}. Existing sessions are signed out. ${modeNote(config, true)}\n`,
      );
      if (fromEnv) stderr.write(`Note: ${envNote(config, true)}\n`);
      return 0;
    } finally {
      lock.release();
    }
  };
}

export const runSetPassword: Command = createSetPasswordCommand();
