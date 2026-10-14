// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The longest password the CLI may store: the longest one sign-in accepts.
 *
 * Read from the login route's own body schema rather than restated, so the
 * two cannot drift. A longer password could be stored but never typed in
 * again: the route refuses the body (422) before it checks the password, so
 * the owner would be locked out by a password that is correct.
 */

import { LoginBody } from '@bureaucromancer/lantern-schema';

export const MAX_PASSWORD_LENGTH: number =
  LoginBody.properties.password.maxLength ?? Number.POSITIVE_INFINITY;

/** A high surrogate followed by a low one: one character in two UTF-16 units. */
const SURROGATE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

/**
 * Counted as Ajv counts `maxLength` (its default `unicode: true`, ucs2length):
 * a surrogate pair is one character, so 512 emoji are 1024 UTF-16 units and
 * still sign in.
 */
export function passwordTooLong(password: string): boolean {
  const characters = password.length - (password.match(SURROGATE_PAIR)?.length ?? 0);
  return characters > MAX_PASSWORD_LENGTH;
}

/** The refusal, with what to do about it. */
export function passwordTooLongMessage(what: string): string {
  return `${what} is longer than ${String(MAX_PASSWORD_LENGTH)} characters, which sign-in refuses, so nobody could sign in with it. Choose a shorter one.`;
}
