// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateSecret, hashPassword } from '../auth/password.js';
import { tempRoot } from '../test-app.js';
import { readSecrets, SecretsError, writeSecrets, type Secrets } from './secrets.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await tempRoot('lantern-secrets-');
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const file = (): string => join(dataDir, 'secrets.json');

describe('secrets.json', () => {
  it('reads as null before it exists', async () => {
    expect(await readSecrets(dataDir)).toBeNull();
  });

  it('round-trips the session key and password record', async () => {
    const secrets: Secrets = { sessionKey: generateSecret(), password: await hashPassword('pw') };
    await writeSecrets(dataDir, secrets);
    expect(await readSecrets(dataDir)).toEqual(secrets);

    await writeSecrets(dataDir, { sessionKey: secrets.sessionKey });
    expect(await readSecrets(dataDir)).toEqual({ sessionKey: secrets.sessionKey });
  });

  it.skipIf(process.platform === 'win32')('is readable by its owner only', async () => {
    await writeSecrets(dataDir, { sessionKey: generateSecret() });
    expect((await stat(file())).mode & 0o777).toBe(0o600);
  });

  it('is diffable JSON', async () => {
    await writeSecrets(dataDir, { sessionKey: 'k'.repeat(43) });
    expect(await readFile(file(), 'utf8')).toBe(`{\n  "sessionKey": "${'k'.repeat(43)}"\n}\n`);
  });

  it('drops keys it does not know rather than carrying them around', async () => {
    await writeFile(file(), JSON.stringify({ sessionKey: 'k'.repeat(43), note: 'hi' }));
    expect(await readSecrets(dataDir)).toEqual({ sessionKey: 'k'.repeat(43) });
  });

  it.each([
    ['not JSON', '{"sessionKey":', /not valid JSON/],
    ['a short key', JSON.stringify({ sessionKey: 'short' }), /sessionKey/],
    [
      'a record with another algorithm',
      JSON.stringify({
        sessionKey: 'k'.repeat(43),
        password: { alg: 'md5', N: 1, r: 1, p: 1, keyLen: 1, salt: 'aa', hash: 'bb' },
      }),
      /password/,
    ],
    [
      'a record with a non-hex hash',
      JSON.stringify({
        sessionKey: 'k'.repeat(43),
        password: { alg: 'scrypt', N: 16, r: 1, p: 1, keyLen: 1, salt: 'aa', hash: 'xyz' },
      }),
      /password\/hash/,
    ],
  ])('refuses %s, naming the file and the fix', async (_label, content, detail) => {
    await writeFile(file(), content);
    const error = await readSecrets(dataDir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SecretsError);
    expect((error as Error).message).toContain(file());
    expect((error as Error).message).toMatch(detail);
    expect((error as Error).message).toContain('lantern set-password');
  });
});
