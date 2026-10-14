// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { verifyPassword } from '../auth/password.js';
import type { AuthModeSetting } from '../config/schema.js';
import { readSecrets } from '../store/secrets.js';
import { setPassword, tempRoot } from '../test-app.js';
import { UsageError } from './args.js';
import { checkAuthBeforeStart, prepareAuth } from './auth-setup.js';
import { MAX_PASSWORD_LENGTH } from './password-length.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await tempRoot('lantern-auth-setup-');
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function input(
  options: {
    host?: string;
    mode?: AuthModeSetting;
    trustNetwork?: boolean;
    envPassword?: string;
  } = {},
) {
  return {
    config: {
      dataDir,
      host: options.host ?? '127.0.0.1',
      auth: {
        mode: options.mode ?? null,
        trustNetwork: options.trustNetwork ?? false,
        cookieSecure: false,
      },
    },
    envPassword: options.envPassword,
  };
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
  const error = await run().then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(UsageError);
  return (error as Error).message;
}

describe('prepareAuth', () => {
  it('creates a session key on first start, and keeps it after', async () => {
    const first = await prepareAuth(input());
    expect(first.mode).toBe('none');
    expect(first.secrets.sessionKey).toHaveLength(43);
    expect(await readSecrets(dataDir)).toEqual({ sessionKey: first.secrets.sessionKey });
    expect((await prepareAuth(input())).secrets.sessionKey).toBe(first.secrets.sessionKey);
  });

  it('is password mode once a password is set', async () => {
    await setPassword(dataDir, 'pw');
    const prepared = await prepareAuth(input());
    expect(prepared.mode).toBe('password');
    expect(prepared.envPassword).toBeNull();
  });

  it('refuses password mode with no password, pointing at set-password', async () => {
    const message = await refusal(() => prepareAuth(input({ mode: 'password' })));
    expect(message).toContain('lantern set-password');
  });

  describe('LANTERN_PASSWORD', () => {
    it('stores the password the first time', async () => {
      const prepared = await prepareAuth(input({ envPassword: 'from env' }));
      expect(prepared.envPassword).toBe('stored');
      expect(prepared.mode).toBe('password');
      const stored = await readSecrets(dataDir);
      expect(stored).toEqual(prepared.secrets);
      expect(await verifyPassword('from env', stored!.password!)).toBe(true);
    });

    it('leaves a matching record alone, so a restart does not sign everyone out', async () => {
      await prepareAuth(input({ envPassword: 'from env' }));
      const before = await readSecrets(dataDir);
      const again = await prepareAuth(input({ envPassword: 'from env' }));
      expect(again.envPassword).toBe('unchanged');
      expect(await readSecrets(dataDir)).toEqual(before);
    });

    it('replaces a record that differs, keeping the session key', async () => {
      await setPassword(dataDir, 'old');
      const before = await readSecrets(dataDir);
      const prepared = await prepareAuth(input({ envPassword: 'new' }));
      expect(prepared.envPassword).toBe('stored');
      const after = await readSecrets(dataDir);
      expect(after?.sessionKey).toBe(before?.sessionKey);
      expect(await verifyPassword('new', after!.password!)).toBe(true);
    });

    it('refuses to protect nothing when auth.mode is none', async () => {
      const message = await refusal(() => prepareAuth(input({ mode: 'none', envPassword: 'pw' })));
      expect(message).toContain('LANTERN_PASSWORD');
      expect(await readSecrets(dataDir)).toBeNull();
    });

    // Stored, a longer one would lock everyone out: sign-in refuses the body
    // before it checks the password, and a container stores it on every boot.
    it(`stores one of ${String(MAX_PASSWORD_LENGTH)} characters`, async () => {
      const envPassword = '\u{1F512}'.repeat(MAX_PASSWORD_LENGTH);
      const prepared = await prepareAuth(input({ envPassword }));
      expect(prepared.envPassword).toBe('stored');
      expect(await verifyPassword(envPassword, (await readSecrets(dataDir))!.password!)).toBe(true);
    });

    it('refuses one character longer, and writes nothing', async () => {
      await setPassword(dataDir, 'old');
      const before = await readSecrets(dataDir);
      const message = await refusal(() =>
        prepareAuth(input({ envPassword: 'a'.repeat(MAX_PASSWORD_LENGTH + 1) })),
      );
      expect(message).toBe(
        `LANTERN_PASSWORD is longer than ${String(MAX_PASSWORD_LENGTH)} characters, which sign-in refuses, so nobody could sign in with it. Choose a shorter one.`,
      );
      expect(await readSecrets(dataDir)).toEqual(before);
    });
  });

  describe('the loopback guard', () => {
    it.each(['0.0.0.0', '::', '192.168.1.20'])(
      'refuses %s with no password, and writes nothing',
      async (host) => {
        const message = await refusal(() => prepareAuth(input({ host })));
        expect(message).toContain(`Refusing to listen on ${host}`);
        expect(await readdir(dataDir)).toEqual([]);
      },
    );

    it('allows it with a password', async () => {
      await setPassword(dataDir, 'pw');
      const prepared = await prepareAuth(input({ host: '0.0.0.0' }));
      expect(prepared.exposureWarning).toBeNull();
    });

    it('allows it with LANTERN_PASSWORD (the container case)', async () => {
      const prepared = await prepareAuth(input({ host: '0.0.0.0', envPassword: 'pw' }));
      expect(prepared.mode).toBe('password');
    });

    it('allows it with trustNetwork, and says so', async () => {
      const prepared = await prepareAuth(input({ host: '0.0.0.0', trustNetwork: true }));
      expect(prepared.exposureWarning).toContain('auth.trustNetwork is set');
    });

    it('refuses an explicit mode none even when a password exists', async () => {
      await setPassword(dataDir, 'pw');
      await refusal(() => prepareAuth(input({ host: '0.0.0.0', mode: 'none' })));
    });
  });
});

describe('checkAuthBeforeStart', () => {
  it('refuses the same starts, before the data directory exists', async () => {
    await rm(dataDir, { recursive: true });
    const message = await refusal(() => checkAuthBeforeStart(input({ host: '0.0.0.0' })));
    expect(message).toContain('Refusing to listen on 0.0.0.0');
    await refusal(() => checkAuthBeforeStart(input({ mode: 'password' })));
    await expect(readdir(dataDir)).rejects.toThrow();
  });

  it('refuses a LANTERN_PASSWORD longer than sign-in takes, before the data directory exists', async () => {
    await rm(dataDir, { recursive: true });
    const message = await refusal(() =>
      checkAuthBeforeStart(input({ envPassword: 'a'.repeat(MAX_PASSWORD_LENGTH + 1) })),
    );
    expect(message).toContain('LANTERN_PASSWORD is longer than');
    await expect(readdir(dataDir)).rejects.toThrow();
  });

  it('counts LANTERN_PASSWORD as a password without hashing or writing', async () => {
    await expect(
      checkAuthBeforeStart(input({ host: '0.0.0.0', envPassword: 'pw' })),
    ).resolves.toBeUndefined();
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('defers unreadable secrets to the full check', async () => {
    await writeFile(join(dataDir, 'secrets.json'), 'not json');
    await expect(checkAuthBeforeStart(input())).resolves.toBeUndefined();
  });
});
