// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { MAX_PASSWORD_LENGTH } from './password-length.js';
import { readNewPassword, SetPasswordAborted } from './prompt.js';

const silent = { write: () => undefined };

function terminal(): PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  raw: boolean[];
} {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    raw: boolean[];
  };
  input.isTTY = true;
  input.raw = [];
  input.setRawMode = (mode) => {
    input.raw.push(mode);
  };
  return input;
}

describe('readNewPassword from a pipe', () => {
  it('reads one line', async () => {
    const input = new PassThrough();
    const pending = readNewPassword(input, silent);
    input.end('piped password\nsecond line\n');
    expect(await pending).toBe('piped password');
  });

  it('accepts a last line with no newline', async () => {
    const input = new PassThrough();
    const pending = readNewPassword(input, silent);
    input.end('piped password');
    expect(await pending).toBe('piped password');
  });

  it('has no minimum length, because the console is the authority', async () => {
    const input = new PassThrough();
    const pending = readNewPassword(input, silent);
    input.end('x\n');
    expect(await pending).toBe('x');
  });

  // Sign-in refuses a longer body before it checks the password, so a longer
  // one stored here would lock the owner out with a password that is correct.
  it(`takes ${String(MAX_PASSWORD_LENGTH)} characters, sign-in's maximum`, async () => {
    const input = new PassThrough();
    const pending = readNewPassword(input, silent);
    input.end(`${'a'.repeat(MAX_PASSWORD_LENGTH)}\n`);
    expect(await pending).toHaveLength(MAX_PASSWORD_LENGTH);
  });

  it('refuses one character more, saying nothing changed', async () => {
    const input = new PassThrough();
    const pending = readNewPassword(input, silent);
    input.end(`${'a'.repeat(MAX_PASSWORD_LENGTH + 1)}\n`);
    await expect(pending).rejects.toThrow(SetPasswordAborted);
    await expect(pending).rejects.toThrow(
      `That password is longer than ${String(MAX_PASSWORD_LENGTH)} characters`,
    );
    await expect(pending).rejects.toThrow('Nothing was changed.');
  });

  it('counts characters as sign-in does, not UTF-16 units', async () => {
    const input = new PassThrough();
    const pending = readNewPassword(input, silent);
    // Each is two UTF-16 units: 1024 units, 512 characters.
    const password = '\u{1F512}'.repeat(MAX_PASSWORD_LENGTH);
    input.end(`${password}\n`);
    expect(await pending).toBe(password);
  });

  // The writer may hold the pipe open (`docker exec -i`); a referenced stdin
  // would then keep the process alive after its work is done.
  it('lets go of stdin once the line is read', async () => {
    const input = new PassThrough() as PassThrough & { unref: () => void };
    let unrefs = 0;
    input.unref = () => {
      unrefs += 1;
    };
    const pending = readNewPassword(input, silent);
    input.write('pw\n');
    expect(await pending).toBe('pw');
    expect(unrefs).toBe(1);
  });

  it('takes an empty line as an empty password', async () => {
    const input = new PassThrough();
    const pending = readNewPassword(input, silent);
    input.end('\n');
    expect(await pending).toBe('');
  });

  it('refuses a pipe that closes without a line', async () => {
    // A redirect from /dev/null or an unset variable said nothing; reading
    // that as the empty password would silently open the install.
    const input = new PassThrough();
    const pending = readNewPassword(input, silent);
    input.end();
    await expect(pending).rejects.toThrow(SetPasswordAborted);
    await expect(pending).rejects.toThrow('No password was given');
  });
});

describe('readNewPassword at a terminal', () => {
  it('asks twice without echo, and honours backspace', async () => {
    const input = terminal();
    const written: string[] = [];
    const pending = readNewPassword(input, { write: (text: string) => written.push(text) });

    const BACKSPACE = String.fromCharCode(127);
    input.write(`the new pasX${BACKSPACE}sword\r`);
    input.write('the new password\r');

    expect(await pending).toBe('the new password');
    expect(written.join('')).toBe('New Lantern password: \nRepeat it: \n');
    // Raw mode on for each prompt and off again after it.
    expect(input.raw).toEqual([true, false, true, false]);
  });

  it('refuses a password longer than sign-in takes before asking for it again', async () => {
    const input = terminal();
    const written: string[] = [];
    const pending = readNewPassword(input, { write: (text: string) => written.push(text) });
    input.write(`${'a'.repeat(MAX_PASSWORD_LENGTH + 1)}\r`);
    await expect(pending).rejects.toThrow(SetPasswordAborted);
    expect(written.join('')).not.toContain('Repeat it');
    expect(input.raw.at(-1)).toBe(false);
  });

  it('refuses two different entries', async () => {
    const input = terminal();
    const pending = readNewPassword(input, silent);
    input.write('one long password\r');
    input.write('another long password\r');
    await expect(pending).rejects.toThrow('did not match');
  });

  it('cancels on Ctrl-C and leaves the terminal cooked', async () => {
    const input = terminal();
    const pending = readNewPassword(input, silent);
    input.write(`half a pass${String.fromCharCode(3)}`);
    await expect(pending).rejects.toThrow('Cancelled');
    expect(input.raw.at(-1)).toBe(false);
  });

  it('refuses when the terminal closes mid-entry', async () => {
    const input = terminal();
    const pending = readNewPassword(input, silent);
    input.end('half');
    await expect(pending).rejects.toThrow(SetPasswordAborted);
  });
});
