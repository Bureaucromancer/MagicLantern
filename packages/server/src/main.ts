#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The `lantern` executable, and the only module that reads `process.env`,
 * `process.argv` and `process.pid`: everything else takes them as arguments,
 * so no test depends on the machine it runs on.
 *
 * Usage, config and data-directory errors become one sentence on stderr and
 * exit 1, never a stack trace; anything else is a bug and keeps its stack.
 */

import { homedir } from 'node:os';

import { parseCliArgs, USAGE, type Command, type CommandContext } from './cli/args.js';
import { runLibraryBackup } from './cli/commands/library-backup.js';
import { runMigrate } from './cli/commands/migrate.js';
import { runServe } from './cli/commands/serve.js';
import { runSetPassword } from './cli/commands/set-password.js';
import { isUsageError } from './cli/startup.js';
import { readServerVersion } from './cli/version.js';

const COMMANDS: Readonly<Record<'serve' | 'migrate' | 'set-password' | 'library-backup', Command>> =
  {
    serve: runServe,
    migrate: runMigrate,
    'set-password': runSetPassword,
    'library-backup': runLibraryBackup,
  };

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.command === 'version') {
    process.stdout.write(`${readServerVersion()}\n`);
    return 0;
  }

  const getuid = process.getuid?.bind(process);
  const getgid = process.getgid?.bind(process);
  const context: CommandContext = {
    args,
    env: process.env,
    pid: process.pid,
    platform: process.platform,
    homedir: homedir(),
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    signals: process,
    ...(getuid === undefined ? {} : { uid: getuid() }),
    ...(getgid === undefined ? {} : { gid: getgid() }),
  };
  return await COMMANDS[args.command](context);
}

try {
  process.exitCode = await main();
} catch (error) {
  process.exitCode = 1;
  if (isUsageError(error)) {
    process.stderr.write(`${error.message}\n`);
  } else {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`Lantern stopped on an unexpected error.\n${detail}\n`);
  }
}

/**
 * Everything is closed by now, so the process ends on its own with the exit
 * code set above (letting stdout drain, which `process.exit` would cut off on a
 * pipe). If a stray handle holds it open, end it anyway: a daemon that said
 * "Stopped" must not linger under a supervisor.
 */
setTimeout(() => {
  process.exit();
}, 5_000).unref();
