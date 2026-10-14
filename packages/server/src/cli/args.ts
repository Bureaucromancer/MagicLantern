// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The command line: `lantern [serve]`, `lantern migrate`,
 * `lantern set-password [--clear]`, `lantern --help`, `lantern --version`,
 * with `--config <path>` and `--data <dir>`.
 *
 * Parsed with node:util `parseArgs` in strict mode. It already refuses a
 * missing value, but silently keeps the last of a duplicated flag, and
 * `pnpm dev` appends arguments to a script that already passes `--data`, so
 * duplicates are counted from the tokens and refused: neither silent answer
 * can be right about which directory somebody meant.
 *
 * It also takes whatever follows a flag as its value unless it starts with
 * `-`, so `lantern --data migrate` (the value forgotten) reads as serve on a
 * new `./migrate`. With no command given, a command's name as a separate
 * value is refused; `--data=migrate`, `./migrate` or naming the command too
 * says the directory is meant.
 */

import { parseArgs } from 'node:util';

export type CommandName = 'serve' | 'migrate' | 'set-password' | 'help' | 'version';

export interface CliArgs {
  readonly command: CommandName;
  /** `--config`. */
  readonly configPath?: string;
  /** `--data`; outranks `dataDir` from the file and `LANTERN_DATA_DIR`. */
  readonly dataDir?: string;
  /** `set-password --clear`: remove the password record. */
  readonly clear: boolean;
}

/** A bad command line or an unusable setting: printed as one sentence, exit 1, no stack. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** The signals serve stops on. `process` in production; an emitter in tests. */
export interface SignalSource {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  /** Sends a signal, for the force quit: serve re-raises a late Ctrl-C with its handlers gone. */
  kill(pid: number, signal: 'SIGINT' | 'SIGTERM'): unknown;
}

/**
 * Everything a command needs from the process, passed in so only main.ts
 * reads `process` and commands can be tested without it.
 */
export interface CommandContext {
  readonly args: CliArgs;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  /** What relative `--config`/`--data` paths are relative to; the process's directory if omitted. */
  readonly cwd?: string;
  /** For the chown hint when the data directory is not writable (absent on Windows). */
  readonly uid?: number;
  readonly gid?: number;
  /** Where serve listens for SIGINT/SIGTERM; it cannot be stopped by signal without one. */
  readonly signals?: SignalSource;
}

/** A command runs to completion (or until signalled) and answers the exit code. */
export type Command = (context: CommandContext) => Promise<number>;

export const USAGE = `Usage: lantern [command] [options]

Commands:
  serve                  Run the daemon (the default).
  migrate                Bring the databases up to this version, then exit.
  set-password           Set the install-wide password, read from stdin.
  set-password --clear   Remove the password.

Options:
  --config <path>        The lantern.json to read (else LANTERN_CONFIG, else the platform default).
  --data <dir>           The data directory (outranks LANTERN_DATA_DIR and dataDir).
  -h, --help             Show this help.
  -v, --version          Show the version.
`;

const COMMANDS: ReadonlySet<string> = new Set(['serve', 'migrate', 'set-password', 'help']);

const OPTIONS = {
  config: { type: 'string' },
  data: { type: 'string' },
  clear: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

/** parseArgs' messages are long and suggest `--` tricks; these say what to fix. */
function describeParseError(error: unknown): string {
  const { code, message } = error as { code?: string; message: string };
  const flag = /'(-[^' ]*)/.exec(message)?.[1];
  switch (code) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
      return `Unknown option ${flag ?? ''}. Run \`lantern --help\` for usage.`;
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
      return flag === undefined ? message : `${flag} needs a value.`;
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL':
      return 'Too many arguments. Run `lantern --help` for usage.';
    default:
      return message;
  }
}

/** Throws {@link UsageError} for anything it cannot parse. */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch (error) {
    throw new UsageError(describeParseError(error));
  }

  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new UsageError(`--${token.name} was given more than once.`);
    seen.add(token.name);
  }

  const { values, positionals } = parsed;
  if (positionals.length === 0) {
    for (const token of parsed.tokens) {
      // `--data=migrate` is written as one word, so it was meant.
      if (
        token.kind === 'option' &&
        (token.name === 'config' || token.name === 'data') &&
        !token.inlineValue &&
        COMMANDS.has(token.value)
      ) {
        const what = token.name === 'data' ? 'directory' : 'file';
        throw new UsageError(
          `--${token.name} needs a value: "${token.value}" is a command. For a ${what} by that name, write ./${token.value}.`,
        );
      }
    }
  }
  if (positionals.length > 1) {
    throw new UsageError('Too many arguments. Run `lantern --help` for usage.');
  }
  const named = positionals[0] ?? 'serve';
  if (!COMMANDS.has(named)) {
    throw new UsageError(`Unknown command "${named}". Run \`lantern --help\` for usage.`);
  }

  for (const flag of ['config', 'data'] as const) {
    if (values[flag] === '') throw new UsageError(`--${flag} needs a value.`);
  }

  let command = named as CommandName;
  if (values.help === true) command = 'help';
  else if (values.version === true) command = 'version';

  if (values.clear === true && command !== 'set-password' && command !== 'help') {
    throw new UsageError('--clear only goes with `lantern set-password`.');
  }

  return {
    command,
    ...(values.config === undefined ? {} : { configPath: values.config }),
    ...(values.data === undefined ? {} : { dataDir: values.data }),
    clear: values.clear === true,
  };
}
