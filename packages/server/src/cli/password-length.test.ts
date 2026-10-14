// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The CLI's limit must be exactly the one sign-in enforces, counted the same
 * way: checked against the login body schema through the daemon's own Ajv,
 * so a change to either side, or to how Ajv counts, fails here.
 */

import { LoginBody } from '@bureaucromancer/lantern-schema';
import { describe, expect, it } from 'vitest';

import { createValidator } from '../http/ajv.js';
import { MAX_PASSWORD_LENGTH, passwordTooLong } from './password-length.js';

const signInAccepts = createValidator().compile(LoginBody);

describe('the password length limit', () => {
  it('is sign-in’s', () => {
    expect(MAX_PASSWORD_LENGTH).toBe(512);
  });

  it.each([
    ['ASCII at the limit', 'a'.repeat(MAX_PASSWORD_LENGTH)],
    ['ASCII over it', 'a'.repeat(MAX_PASSWORD_LENGTH + 1)],
    ['astral characters at the limit', '\u{1F512}'.repeat(MAX_PASSWORD_LENGTH)],
    ['astral characters over it', '\u{1F512}'.repeat(MAX_PASSWORD_LENGTH + 1)],
    ['the empty password', ''],
  ])('agrees with sign-in on %s', (_label, password) => {
    expect(passwordTooLong(password)).toBe(!signInAccepts({ password }));
  });
});
