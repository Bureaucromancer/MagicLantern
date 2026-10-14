// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { describe, expect, it } from 'vitest';

import { generateSecret, hashPassword } from './password.js';
import {
  concurrencyLimit,
  createAuthService,
  MAX_CONCURRENT_PASSWORD_CHECKS,
  resolveAuthMode,
} from './service.js';

/** A promise and the function that settles it. */
function deferred(): { promise: Promise<unknown>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise((settle) => {
    resolve = () => {
      settle(undefined);
    };
  });
  return { promise, resolve };
}

/** Lets every queued microtask (and the continuations they schedule) run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('resolveAuthMode', () => {
  it.each([
    [null, false, 'none'],
    [null, true, 'password'],
    ['none', true, 'none'],
    ['none', false, 'none'],
    ['password', true, 'password'],
    ['password', false, 'password'],
  ] as const)('setting %s with a password %s is %s', (setting, hasPassword, mode) => {
    expect(resolveAuthMode(setting, hasPassword)).toBe(mode);
  });
});

describe('createAuthService', () => {
  const sessionKey = generateSecret();

  it('refuses password mode with no password, rather than run open', () => {
    expect(() =>
      createAuthService({ setting: 'password', secrets: { sessionKey }, cookieSecure: false }),
    ).toThrow(TypeError);
  });

  it('has no sessions and no password check in mode none', async () => {
    const password = await hashPassword('pw');
    const auth = createAuthService({
      setting: 'none',
      secrets: { sessionKey, password },
      cookieSecure: false,
    });
    expect(auth.mode()).toBe('none');
    expect(await auth.verifyPassword('pw')).toBe(false);
    expect(auth.readSession('anything')).toBeNull();
  });

  it('issues sessions it can read back, until they expire', async () => {
    const auth = createAuthService({
      setting: null,
      secrets: { sessionKey, password: await hashPassword('pw') },
      cookieSecure: true,
      now: () => 1_000,
    });
    expect(auth.mode()).toBe('password');
    expect(await auth.verifyPassword('pw')).toBe(true);
    const session = auth.issueSession();
    expect(session.issuedAt).toBe(1_000);
    expect(auth.readSession(session.token)).toEqual({
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt,
    });
    expect(auth.readSession(session.token, session.expiresAt)).toBeNull();
    expect(auth.cookie).toEqual({
      name: 'lantern_session',
      secure: true,
      maxAgeSeconds: 2_592_000,
    });
  });

  it('answers false rather than throwing for a record scrypt refuses', async () => {
    const record = { ...(await hashPassword('pw')), N: 3 };
    const auth = createAuthService({
      setting: 'password',
      secrets: { sessionKey, password: record },
      cookieSecure: false,
    });
    expect(await auth.verifyPassword('pw')).toBe(false);
  });
});

describe('concurrencyLimit', () => {
  it('runs at most the limit at once, the rest in arrival order', async () => {
    const limited = concurrencyLimit(2);
    const gates = Array.from({ length: 5 }, () => deferred());
    const started: number[] = [];
    let running = 0;
    let most = 0;
    const results = gates.map((gate, index) =>
      limited(async () => {
        started.push(index);
        running += 1;
        most = Math.max(most, running);
        await gate.promise;
        running -= 1;
        return index;
      }),
    );
    await settle();
    expect(started).toEqual([0, 1]);

    gates[1]?.resolve();
    await settle();
    // A task arriving now queues behind those already waiting.
    const late = limited(() => {
      started.push(99);
      return Promise.resolve(99);
    });
    await settle();
    expect(started).toEqual([0, 1, 2]);

    for (const gate of gates) gate.resolve();
    expect(await Promise.all([...results, late])).toEqual([0, 1, 2, 3, 4, 99]);
    expect(started).toEqual([0, 1, 2, 3, 4, 99]);
    expect(most).toBe(2);
  });

  it('frees the slot when a task fails', async () => {
    const limited = concurrencyLimit(1);
    await expect(limited(() => Promise.reject(new Error('no')))).rejects.toThrow('no');
    expect(await limited(() => Promise.resolve('next'))).toBe('next');
  });
});

describe('password checks under a burst', () => {
  // Each scrypt check holds a libuv worker for its whole run; a burst of
  // sign-ins must leave the others to static files and the stores.
  it(`runs at most ${String(MAX_CONCURRENT_PASSWORD_CHECKS)} at once, and answers every one`, async () => {
    const sessionKey = generateSecret();
    let running = 0;
    let most = 0;
    const gates: (() => void)[] = [];
    const auth = createAuthService({
      setting: 'password',
      secrets: { sessionKey, password: await hashPassword('pw') },
      cookieSecure: false,
      verify: async (password) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise<void>((resolve) => gates.push(resolve));
        running -= 1;
        return password === 'pw';
      },
    });
    const attempts = ['a', 'b', 'c', 'd', 'e', 'f', 'pw', 'g'].map((guess) =>
      auth.verifyPassword(guess),
    );
    await settle();
    expect(running).toBe(MAX_CONCURRENT_PASSWORD_CHECKS);
    while (gates.length > 0) {
      for (const open of gates.splice(0)) open();
      await settle();
    }
    expect(await Promise.all(attempts)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(most).toBe(MAX_CONCURRENT_PASSWORD_CHECKS);
  });
});
