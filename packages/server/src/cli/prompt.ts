// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Reading a new password from stdin for `lantern set-password`. Never from
 * argv, which leaks into shell history and process listings.
 *
 * - A terminal gets a prompt without echo, asked twice, because a typo in a
 *   password nobody can see locks the owner out.
 * - A pipe (`echo pw | lantern set-password`, a container exec, a script)
 *   gets one plain line, once.
 *
 * No minimum length: whoever can run this against the data directory can
 * already read it, and a break-glass path that argues with them only teaches
 * them to edit files by hand. There is a maximum, sign-in's own: a longer
 * password could be stored but never accepted at sign-in.
 */

import { createInterface } from 'node:readline';

import { passwordTooLong, passwordTooLongMessage } from './password-length.js';

export class SetPasswordAborted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetPasswordAborted';
  }
}

/** The slice of a read stream this needs: a seam for tests. */
export interface PromptInput extends NodeJS.EventEmitter {
  isTTY?: boolean | undefined;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding: (encoding: BufferEncoding) => unknown;
  resume: () => unknown;
  pause: () => unknown;
  /** Lets the process end while the stream is still open (a pipe the writer keeps open). */
  unref?: () => unknown;
}

export interface PromptOutput {
  write: (text: string) => unknown;
}

/**
 * Asks for the new password, confirmed when interactive. Throws
 * {@link SetPasswordAborted} on a mismatch, on Ctrl-C, when stdin closes
 * without a line, or for a password longer than sign-in accepts (at a
 * terminal, before asking for it again).
 */
export async function readNewPassword(input: PromptInput, output: PromptOutput): Promise<string> {
  if (input.isTTY !== true) return refuseTooLong(await readPipedLine(input));
  const first = refuseTooLong(await readMasked(input, output, 'New Lantern password: '));
  const second = await readMasked(input, output, 'Repeat it: ');
  if (first !== second) {
    throw new SetPasswordAborted('The two entries did not match. Nothing was changed.');
  }
  return first;
}

function refuseTooLong(password: string): string {
  if (passwordTooLong(password)) {
    throw new SetPasswordAborted(`${passwordTooLongMessage('That password')} Nothing was changed.`);
  }
  return password;
}

/**
 * One line, no echo. Raw mode so the terminal prints nothing; backspace
 * works; Ctrl-C is honoured by hand (raw mode swallows the signal) and leaves
 * the terminal cooked again.
 */
function readMasked(input: PromptInput, output: PromptOutput, prompt: string): Promise<string> {
  output.write(prompt);
  return new Promise((resolve, reject) => {
    input.setRawMode?.(true);
    input.setEncoding('utf8');
    input.resume();
    let value = '';

    const finish = (outcome: () => void): void => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.setRawMode?.(false);
      input.pause();
      output.write('\n');
      outcome();
    };

    const onEnd = (): void => {
      finish(() => {
        reject(new SetPasswordAborted('No password was given. Nothing was changed.'));
      });
    };

    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') {
          finish(() => {
            resolve(value);
          });
          return;
        }
        if (character === '\u0003' || character === '\u0004') {
          finish(() => {
            reject(new SetPasswordAborted('Cancelled. Nothing was changed.'));
          });
          return;
        }
        // DEL from most terminals, BS from some.
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };

    input.on('data', onData);
    input.once('end', onEnd);
  });
}

/**
 * The first line from a pipe, without its newline. A pipe that closes having
 * delivered no line gave no answer (a redirect from /dev/null, an unset
 * variable, a truncated heredoc) and is refused rather than read as the empty
 * password; `echo "" |` delivers one empty line and means it.
 *
 * Nothing else reads stdin after the line, so it is let go: a writer that
 * keeps the pipe open (`docker exec -i`, a script holding it) would otherwise
 * keep the process alive after its work is done. Pausing alone does not.
 */
function readPipedLine(input: PromptInput): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = createInterface({ input: input as NodeJS.ReadableStream, terminal: false });
    let settled = false;
    reader.once('line', (line) => {
      settled = true;
      reader.close();
      input.pause();
      input.unref?.();
      resolve(line);
    });
    reader.once('close', () => {
      if (!settled) reject(new SetPasswordAborted('No password was given. Nothing was changed.'));
    });
  });
}
