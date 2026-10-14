// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { describe, expect, it } from 'vitest';

import { parseCliArgs, UsageError } from './args.js';

function refusal(argv: string[]): string {
  try {
    parseCliArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) return error.message;
    throw error;
  }
  throw new Error(`expected ${argv.join(' ')} to be refused`);
}

describe('parseCliArgs', () => {
  it('serves by default', () => {
    expect(parseCliArgs([])).toEqual({ command: 'serve', clear: false });
  });

  it.each(['serve', 'migrate', 'set-password', 'help'] as const)(
    'takes the command %s',
    (command) => {
      expect(parseCliArgs([command]).command).toBe(command);
    },
  );

  it('reads --config and --data in either spelling', () => {
    expect(parseCliArgs(['serve', '--config', 'a.json', '--data=/d'])).toEqual({
      command: 'serve',
      configPath: 'a.json',
      dataDir: '/d',
      clear: false,
    });
    expect(parseCliArgs(['--data', '/d', 'migrate'])).toMatchObject({
      command: 'migrate',
      dataDir: '/d',
    });
  });

  it('takes --clear with set-password', () => {
    expect(parseCliArgs(['set-password', '--clear'])).toMatchObject({
      command: 'set-password',
      clear: true,
    });
  });

  it.each([['--help'], ['-h'], ['serve', '--help'], ['--version', '--help']])(
    'shows help for %j',
    (...argv) => {
      expect(parseCliArgs(argv).command).toBe('help');
    },
  );

  it.each([['--version'], ['-v'], ['migrate', '--version']])(
    'shows the version for %j',
    (...argv) => {
      expect(parseCliArgs(argv).command).toBe('version');
    },
  );

  // pnpm appends arguments to a script that already passes --data; taking
  // either copy silently would point the daemon at the wrong directory.
  it.each([
    [['--data', 'a', '--data', 'b'], '--data was given more than once.'],
    [['--data=a', '--data', 'b'], '--data was given more than once.'],
    [['--config', 'a', 'serve', '--config', 'a'], '--config was given more than once.'],
    [['set-password', '--clear', '--clear'], '--clear was given more than once.'],
  ])('refuses the duplicate in %j', (argv, message) => {
    expect(refusal(argv)).toBe(message);
  });

  it.each([
    [['--data'], '--data needs a value.'],
    [['serve', '--config'], '--config needs a value.'],
    [['--data='], '--data needs a value.'],
  ])('refuses %j, which has no value', (argv, message) => {
    expect(refusal(argv)).toBe(message);
  });

  it('does not swallow the next flag as a value', () => {
    expect(refusal(['--data', '--config', 'x.json'])).toBe('--data needs a value.');
  });

  // A forgotten value would otherwise take the command as a directory and
  // start serve on a new ./migrate instead of migrating.
  it.each([
    [
      ['--data', 'migrate'],
      '--data needs a value: "migrate" is a command. For a directory by that name, write ./migrate.',
    ],
    [
      ['--config', 'set-password'],
      '--config needs a value: "set-password" is a command. For a file by that name, write ./set-password.',
    ],
    [
      ['--data', '/d', '--config', 'serve'],
      '--config needs a value: "serve" is a command. For a file by that name, write ./serve.',
    ],
    [
      ['--data', 'help'],
      '--data needs a value: "help" is a command. For a directory by that name, write ./help.',
    ],
  ])('refuses %j, whose value is a command name', (argv, message) => {
    expect(refusal(argv)).toBe(message);
  });

  it.each([
    [['--data=migrate'], { command: 'serve', dataDir: 'migrate' }],
    [['--data', './migrate'], { command: 'serve', dataDir: './migrate' }],
    [['serve', '--data', 'migrate'], { command: 'serve', dataDir: 'migrate' }],
    [['--data', 'migrate', 'serve'], { command: 'serve', dataDir: 'migrate' }],
    [['--config', 'set-password', 'migrate'], { command: 'migrate', configPath: 'set-password' }],
  ])('takes %j, which says the path is meant', (argv, expected) => {
    expect(parseCliArgs(argv)).toMatchObject(expected);
  });

  it.each([
    [['--port', '1'], 'Unknown option --port. Run `lantern --help` for usage.'],
    [['launch'], 'Unknown command "launch". Run `lantern --help` for usage.'],
    [['serve', 'now'], 'Too many arguments. Run `lantern --help` for usage.'],
    [['serve', '--clear'], '--clear only goes with `lantern set-password`.'],
  ])('refuses %j', (argv, message) => {
    expect(refusal(argv)).toBe(message);
  });
});
