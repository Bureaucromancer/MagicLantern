// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { verifyPassword } from '../../auth/password.js';
import { readSecrets } from '../../store/secrets.js';
import { InstanceLockHeldError } from '../../store/lock.js';
import { setPassword, tempRoot } from '../../test-app.js';
import type { CommandContext } from '../args.js';
import { MAX_PASSWORD_LENGTH } from '../password-length.js';
import { createSetPasswordCommand } from './set-password.js';

let root: string;
let dataDir: string;
let events: string[];

beforeEach(async () => {
  root = await tempRoot('lantern-set-password-');
  dataDir = join(root, 'data');
  events = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const fakeLock = (): { release(): void } => {
  events.push('lock');
  return { release: () => events.push('release') };
};

async function run(
  stdinText: string | null,
  options: { clear?: boolean; env?: Record<string, string>; config?: unknown } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const configPath = join(root, 'lantern.json');
  if (options.config !== undefined) await writeFile(configPath, JSON.stringify(options.config));
  const stdin = new PassThrough();
  if (stdinText === null) stdin.end();
  else stdin.end(stdinText);
  let stdout = '';
  let stderr = '';
  const out = new PassThrough();
  out.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  const err = new PassThrough();
  err.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const context: CommandContext = {
    args: { command: 'set-password', configPath, dataDir, clear: options.clear ?? false },
    env: options.env ?? {},
    pid: 1,
    platform: process.platform,
    homedir: root,
    cwd: root,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: out,
    stderr: err,
  };
  const code = await createSetPasswordCommand(fakeLock)(context);
  await new Promise((resolve) => setImmediate(resolve));
  return { code, stdout, stderr };
}

describe('lantern set-password', () => {
  it('sets the password from a pipe and says what it means', async () => {
    const result = await run('a new password\n');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `Set the Lantern password in ${dataDir}. Existing sessions are signed out. Lantern asks for it from the next start.\n`,
    );
    const secrets = await readSecrets(dataDir);
    expect(await verifyPassword('a new password', secrets!.password!)).toBe(true);
    expect(events).toEqual(['lock', 'release']);
  });

  it('keeps the session key, so only the fingerprint changes', async () => {
    await setPassword(dataDir, 'old');
    const before = await readSecrets(dataDir);
    await run('new\n');
    const after = await readSecrets(dataDir);
    expect(after?.sessionKey).toBe(before?.sessionKey);
    expect(after?.password?.salt).not.toBe(before?.password?.salt);
  });

  it('changes nothing when stdin closes without a line', async () => {
    await setPassword(dataDir, 'old');
    const before = await readSecrets(dataDir);
    const result = await run(null);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('No password was given. Nothing was changed.\n');
    expect(await readSecrets(dataDir)).toEqual(before);
    expect(events).toEqual(['lock', 'release']);
  });

  it('removes the password with --clear', async () => {
    await setPassword(dataDir, 'old');
    const before = await readSecrets(dataDir);
    const result = await run(null, { clear: true });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Removed the Lantern password');
    expect(result.stdout).toContain('auth mode none from the next start');
    expect(await readSecrets(dataDir)).toEqual({ sessionKey: before?.sessionKey });
  });

  it('warns that --clear leaves an explicit password mode unable to start', async () => {
    await setPassword(dataDir, 'old');
    const result = await run(null, { clear: true, config: { auth: { mode: 'password' } } });
    expect(result.stdout).toContain('will not start until a password is set again');
  });

  it('says so when there is nothing to clear', async () => {
    const result = await run(null, { clear: true });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`No password is set in ${dataDir}; nothing changed.\n`);
  });

  it('notes that LANTERN_PASSWORD will replace it on the next serve', async () => {
    const result = await run('pw\n', { env: { LANTERN_PASSWORD: 'other' } });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('LANTERN_PASSWORD is set');
  });

  // --clear must not promise mode none when the next serve stores the variable again.
  describe('--clear with LANTERN_PASSWORD set', () => {
    it('says the next serve stores that password again, not that it runs with none', async () => {
      await setPassword(dataDir, 'old');
      const before = await readSecrets(dataDir);
      const result = await run(null, { clear: true, env: { LANTERN_PASSWORD: 'other' } });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(
        `Removed the Lantern password in ${dataDir}. LANTERN_PASSWORD is set in this environment, so a \`lantern serve\` that sees it stores that password again and asks for it.\n`,
      );
      expect(result.stdout).not.toContain('auth mode none');
      expect(await readSecrets(dataDir)).toEqual({ sessionKey: before?.sessionKey });
    });

    it('says serve will refuse when auth.mode is none', async () => {
      await setPassword(dataDir, 'old');
      const result = await run(null, {
        clear: true,
        env: { LANTERN_PASSWORD: 'other' },
        config: { auth: { mode: 'none' } },
      });
      expect(result.stdout).toContain(
        '`lantern serve` refuses to start until one of them is unset',
      );
      expect(result.stdout).not.toContain('auth mode none from the next start');
    });

    it('notes the variable even when there was nothing to clear', async () => {
      const result = await run(null, { clear: true, env: { LANTERN_PASSWORD: 'other' } });
      expect(result.stdout).toBe(`No password is set in ${dataDir}; nothing changed.\n`);
      expect(result.stderr).toContain('stores that password again');
    });

    it('treats an empty LANTERN_PASSWORD as unset, as serve does', async () => {
      await setPassword(dataDir, 'old');
      const result = await run(null, { clear: true, env: { LANTERN_PASSWORD: '' } });
      expect(result.stdout).toContain('auth mode none from the next start');
      expect(result.stdout).not.toContain('LANTERN_PASSWORD');
    });
  });

  // Sign-in refuses a longer body before it checks the password: stored, it
  // would lock the owner out with a password that is correct.
  describe('the length limit', () => {
    it(`sets a password of ${String(MAX_PASSWORD_LENGTH)} characters`, async () => {
      const password = 'a'.repeat(MAX_PASSWORD_LENGTH);
      const result = await run(`${password}\n`);
      expect(result.code).toBe(0);
      expect(await verifyPassword(password, (await readSecrets(dataDir))!.password!)).toBe(true);
    });

    it('refuses one character more and changes nothing', async () => {
      await setPassword(dataDir, 'old');
      const before = await readSecrets(dataDir);
      const result = await run(`${'a'.repeat(MAX_PASSWORD_LENGTH + 1)}\n`);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        `That password is longer than ${String(MAX_PASSWORD_LENGTH)} characters, which sign-in refuses, so nobody could sign in with it. Choose a shorter one. Nothing was changed.\n`,
      );
      expect(await readSecrets(dataDir)).toEqual(before);
      expect(events).toEqual(['lock', 'release']);
    });
  });

  it('refuses while a daemon holds the data directory, before asking', async () => {
    const stdin = new PassThrough();
    const context: CommandContext = {
      args: { command: 'set-password', configPath: join(root, 'none.json'), dataDir, clear: false },
      env: {},
      pid: 1,
      platform: process.platform,
      homedir: root,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    };
    const command = createSetPasswordCommand((dir) => {
      throw new InstanceLockHeldError(dir);
    });
    await expect(command(context)).rejects.toThrow(InstanceLockHeldError);
    expect(stdin.listenerCount('data')).toBe(0);
    expect(await readSecrets(dataDir)).toBeNull();
  });
});
