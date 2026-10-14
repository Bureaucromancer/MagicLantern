// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Auth at startup (SK7): secrets.json, `LANTERN_PASSWORD`, the effective mode,
 * and the loopback guard, decided before any database is opened.
 *
 * `LANTERN_PASSWORD` (containers, A30) is verified against the stored record
 * first and re-hashed only when it differs: a new salt on every boot would
 * change the record's fingerprint and sign everyone out at every restart.
 */

import type { AuthMode } from '@bureaucromancer/lantern-schema';

import { generateSecret, hashPassword, verifyPassword } from '../auth/password.js';
import { resolveAuthMode } from '../auth/service.js';
import type { ResolvedConfig } from '../config/schema.js';
import { checkExposure } from '../http/security.js';
import {
  readSecrets,
  SecretsError,
  writeSecrets,
  type PasswordRecord,
  type Secrets,
} from '../store/secrets.js';
import { UsageError } from './args.js';
import { passwordTooLong, passwordTooLongMessage } from './password-length.js';

export interface AuthInput {
  readonly config: Pick<ResolvedConfig, 'dataDir' | 'host' | 'auth'>;
  /** `LANTERN_PASSWORD`, with an empty value already treated as unset. */
  readonly envPassword: string | undefined;
}

export interface PreparedAuth {
  readonly secrets: Secrets;
  readonly mode: AuthMode;
  /** The trustNetwork warning, said on every start while it applies. */
  readonly exposureWarning: string | null;
  /** What `LANTERN_PASSWORD` did, if it was set. */
  readonly envPassword: 'stored' | 'unchanged' | null;
}

/** The refusals about `LANTERN_PASSWORD` itself, made before anything is read, hashed or written. */
function checkEnvPassword({ config, envPassword }: AuthInput): void {
  if (envPassword === undefined) return;
  if (config.auth.mode === 'none') {
    throw new UsageError(
      'LANTERN_PASSWORD is set but auth.mode is "none", so the password would protect nothing. ' +
        'Unset one of them (auth.mode null or "password" uses the password).',
    );
  }
  // Stored, it would lock everyone out: sign-in refuses the body before checking it.
  if (passwordTooLong(envPassword))
    throw new UsageError(passwordTooLongMessage('LANTERN_PASSWORD'));
}

/** The refusals, given whether a password will exist; returns the mode and any warning. */
function decide(
  input: AuthInput,
  hasPassword: boolean,
): { mode: AuthMode; exposureWarning: string | null } {
  const { config } = input;
  const mode = resolveAuthMode(config.auth.mode, hasPassword);
  if (mode === 'password' && !hasPassword) {
    throw new UsageError(
      'Auth mode is "password" but no password has been set. Run `lantern set-password` ' +
        '(or set LANTERN_PASSWORD), then start again.',
    );
  }
  const exposure = checkExposure({
    host: config.host,
    mode,
    trustNetwork: config.auth.trustNetwork,
  });
  if (exposure.kind === 'refuse') throw new UsageError(exposure.message);
  return { mode, exposureWarning: exposure.kind === 'warn' ? exposure.message : null };
}

/**
 * The same refusals, read-only and before the data directory is checked or
 * locked, so a refused start touches nothing. Unreadable secrets defer to
 * {@link prepareAuth}, which runs after the writable check and says it better.
 */
export async function checkAuthBeforeStart(input: AuthInput): Promise<void> {
  checkEnvPassword(input);
  let stored: Secrets | null;
  try {
    stored = await readSecrets(input.config.dataDir);
  } catch (error) {
    if (error instanceof SecretsError) return;
    throw error;
  }
  decide(input, stored?.password !== undefined || input.envPassword !== undefined);
}

/** Reads (and when needed writes) secrets.json under the instance lock, and decides the mode. */
export async function prepareAuth(input: AuthInput): Promise<PreparedAuth> {
  checkEnvPassword(input);
  const { config, envPassword } = input;
  const existing = await readSecrets(config.dataDir);
  let record: PasswordRecord | undefined = existing?.password;
  let envOutcome: PreparedAuth['envPassword'] = null;

  if (envPassword !== undefined && config.auth.mode !== 'none') {
    if (record !== undefined && (await verifyPassword(envPassword, record))) {
      envOutcome = 'unchanged';
    } else {
      record = await hashPassword(envPassword);
      envOutcome = 'stored';
    }
  }

  const { mode, exposureWarning } = decide(input, record !== undefined);

  // Written only after every refusal above, so a refused start changes nothing.
  const secrets: Secrets = {
    sessionKey: existing?.sessionKey ?? generateSecret(),
    ...(record === undefined ? {} : { password: record }),
  };
  if (existing === null || envOutcome === 'stored') await writeSecrets(config.dataDir, secrets);

  return { secrets, mode, exposureWarning, envPassword: envOutcome };
}
