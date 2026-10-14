// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `<data>/secrets.json`, mode 0600, written atomically: the session signing
 * key, created on first use, and the password record when one is set. Never in
 * lantern.json: config is for settings, not credentials.
 *
 * Deleting the file is survivable and its consequence is honest: everyone is
 * signed out and the password is gone (mode null then resolves to `none`).
 */

import { readFile } from 'node:fs/promises';

import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { writeJsonAtomic } from './atomic.js';
import { dataPaths } from './paths.js';

const Hex = Type.String({ pattern: '^(?:[0-9a-f]{2})+$' });
const PositiveInteger = Type.Integer({ minimum: 1 });

/**
 * A scrypt hash with its parameters recorded, so the cost can be raised later
 * without breaking existing records. Salt and hash are hex.
 */
const PasswordRecordSchema = Type.Object({
  alg: Type.Literal('scrypt'),
  N: PositiveInteger,
  r: PositiveInteger,
  p: PositiveInteger,
  keyLen: PositiveInteger,
  salt: Hex,
  hash: Hex,
});

const SecretsSchema = Type.Object({
  sessionKey: Type.String({ minLength: 32 }),
  password: Type.Optional(PasswordRecordSchema),
});

/** Readonly views of the schema types (the schema is the single description of the file). */
export type PasswordRecord = Readonly<Static<typeof PasswordRecordSchema>>;

export interface Secrets {
  /** HMAC-SHA256 key for session cookies. Replacing it signs everyone out. */
  readonly sessionKey: string;
  readonly password?: PasswordRecord;
}

/** secrets.json exists but cannot be used. A usage error naming the file. */
export class SecretsError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(
      `${path} is not usable (${detail}). Fix it or delete it: deleting it signs everyone out ` +
        'and removes the password, which `lantern set-password` can set again.',
    );
    this.name = 'SecretsError';
    this.path = path;
  }
}

/** Reads `secrets.json`, or null when it does not exist yet. */
export async function readSecrets(dataDir: string): Promise<Secrets | null> {
  const path = dataPaths(dataDir).secrets;
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new SecretsError(
      path,
      `cannot be read: ${(error as NodeJS.ErrnoException).code ?? 'error'}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SecretsError(path, 'not valid JSON');
  }
  if (!Value.Check(SecretsSchema, parsed)) {
    const first = Value.Errors(SecretsSchema, parsed).First();
    throw new SecretsError(
      path,
      first === undefined ? 'unexpected shape' : `${first.path || '/'} ${first.message}`,
    );
  }
  // Only the known fields: an extra key in the file is not carried into memory or back out.
  const { sessionKey, password } = parsed;
  return password === undefined ? { sessionKey } : { sessionKey, password };
}

/** Writes `secrets.json` atomically with mode 0600. */
export async function writeSecrets(dataDir: string, secrets: Secrets): Promise<void> {
  const document =
    secrets.password === undefined
      ? { sessionKey: secrets.sessionKey }
      : { sessionKey: secrets.sessionKey, password: secrets.password };
  await writeJsonAtomic(dataPaths(dataDir).secrets, document, { mode: 0o600 });
}
