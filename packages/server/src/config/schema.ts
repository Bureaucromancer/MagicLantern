// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `lantern.json`: its schema, its defaults, and the resolved shape the daemon
 * runs on.
 *
 * Every key is optional; the defaults are a working install (loopback, port
 * 7600, the platform's data directory, no password). Layering is defaults <
 * file < environment (the plan has env override the file), done by
 * `loadConfig`, which validates the merged document against
 * {@link ConfigSchema}. Three places must agree and a test holds them
 * together: the schema's `default`s, {@link DEFAULT_CONFIG}, and the commented
 * `lantern.example.json` at the repository root.
 *
 * Unknown keys are not rejected by the schema (a newer build's key, or a typo,
 * should produce a log line rather than a refusal to start); `loadConfig`
 * reports them.
 */

import { type SchemaOptions, type Static, Type } from '@sinclair/typebox';

function logLevel(options: SchemaOptions = {}) {
  return Type.Union(
    [
      Type.Literal('fatal'),
      Type.Literal('error'),
      Type.Literal('warn'),
      Type.Literal('info'),
      Type.Literal('debug'),
      Type.Literal('trace'),
      Type.Literal('silent'),
    ],
    { description: "pino's levels; `silent` turns logging off (tests).", ...options },
  );
}

export const LogLevel = logLevel();
export type LogLevel = Static<typeof LogLevel>;

export const AuthModeSetting = Type.Union(
  [Type.Literal('none'), Type.Literal('password'), Type.Null()],
  {
    default: null,
    description:
      '`none`, `password`, or null: `password` if a password has been set (`lantern set-password`), else `none`.',
  },
);
export type AuthModeSetting = Static<typeof AuthModeSetting>;

const HostName = Type.String({ minLength: 1 });

export const ConfigSchema = Type.Object({
  host: Type.String({
    minLength: 1,
    default: '127.0.0.1',
    description:
      'The bind address. Loopback by default; binding beyond it needs a password or auth.trustNetwork.',
  }),
  port: Type.Integer({
    minimum: 0,
    maximum: 65535,
    default: 7600,
    description: 'The port for the API and the app. 0 picks a free one.',
  }),
  dataDir: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
    default: null,
    description:
      "Where libraries and databases live. Null: the platform's data directory (XDG on Linux, Application Support on macOS, %LOCALAPPDATA% on Windows).",
  }),
  appRoot: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
    default: null,
    description:
      "The built app's directory. Null: the app package's dist beside the server, if built, else API only. A path without index.html is a startup error.",
  }),
  auth: Type.Object(
    {
      mode: AuthModeSetting,
      trustNetwork: Type.Boolean({
        default: false,
        description:
          'Allow a non-loopback bind with auth mode none. Every start then logs a warning.',
      }),
      cookieSecure: Type.Boolean({
        default: false,
        description:
          'Mark the session cookie Secure. Set it when TLS terminates in front of Lantern; never derived from the bind.',
      }),
    },
    { default: {} },
  ),
  allowedHosts: Type.Array(HostName, {
    default: [],
    description:
      'Extra Host names to accept (hostname only, no port), e.g. a reverse proxy or LAN name. Loopback names and the bind address are always accepted.',
  }),
  allowedOrigins: Type.Array(HostName, {
    default: [],
    description:
      'Extra Origins to accept (scheme://host[:port]), e.g. http://localhost:5173 for the Vite dev server.',
  }),
  log: Type.Object({ level: logLevel({ default: 'info' }) }, { default: {} }),
});

/** A whole config document as written in lantern.json, after defaults. */
export type LanternConfig = Static<typeof ConfigSchema>;

/**
 * The defaults, deep-frozen so a merge that forgets `structuredClone` fails
 * loudly instead of rewriting them for the rest of the process.
 */
export const DEFAULT_CONFIG: LanternConfig = deepFreeze({
  host: '127.0.0.1',
  port: 7600,
  dataDir: null,
  appRoot: null,
  auth: { mode: null, trustNetwork: false, cookieSecure: false },
  allowedHosts: [],
  allowedOrigins: [],
  log: { level: 'info' },
});

/** How the config was arrived at, for the startup log lines. */
export interface ConfigProvenance {
  /** The lantern.json path that was read, or would have been. */
  readonly path: string;
  /** Absent is normal: the defaults are a working install. */
  readonly fileFound: boolean;
  /** Keys in the file this build does not know (kept, reported), as dotted paths. */
  readonly unknownKeys: readonly string[];
  /** Environment variables that replaced a value the file set. */
  readonly envOverrodeFile: readonly string[];
  /** Environment variables that set a value the file did not. */
  readonly envApplied: readonly string[];
  /** True when `dataDir` came from the platform default. */
  readonly dataDirDefaulted: boolean;
}

/**
 * The config the daemon runs on: the merged, validated document with
 * `dataDir` resolved to an absolute path and `host` without IPv6 brackets
 * (`[::1]` is `::1`, which is what `listen()` takes). `appRoot` stays as configured (null
 * means auto-detect, which the static-serving module resolves), and
 * `auth.mode` stays as configured (null means "decided by whether a password
 * record exists", which the auth service resolves).
 */
export interface ResolvedConfig extends Omit<LanternConfig, 'dataDir'> {
  readonly dataDir: string;
  readonly provenance: ConfigProvenance;
}

/** Raised for a malformed lantern.json or environment value. A usage error: one sentence, exit 1. */
export class ConfigError extends Error {
  /** Each problem, naming the JSON key or the environment variable at fault. */
  readonly issues: readonly string[];

  constructor(source: string, issues: readonly string[]) {
    super(`${source} is not valid: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
