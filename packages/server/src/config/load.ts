// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Reading `lantern.json` and the environment into a {@link ResolvedConfig}.
 *
 * Path: `--config`, else `LANTERN_CONFIG`, else the platform default
 * (store/paths.ts `defaultConfigPath`). A missing file is the defaults.
 * Layering: `structuredClone(DEFAULT_CONFIG)` < file < environment, where the
 * environment is `LANTERN_HOST`, `LANTERN_PORT`, `LANTERN_DATA_DIR`,
 * `LANTERN_APP_ROOT`, `LANTERN_AUTH_MODE`, `LANTERN_TRUST_NETWORK` (1/true),
 * `LANTERN_COOKIE_SECURE`, `LANTERN_ALLOWED_HOSTS` and `LANTERN_ALLOWED_ORIGINS`
 * (comma lists) and `LANTERN_LOG_LEVEL`. An empty value is unset; integers parse
 * only on /^-?\d+$/. `--data` outranks both layers for the data directory.
 *
 * Each layer is validated on its own over the defaults, so an error names
 * where it came from: the JSON key for the file, the variable for the
 * environment ({@link ConfigError}). Relative paths resolve against the
 * directory of the file that set them, or the working directory for a flag or
 * variable.
 *
 * The environment is passed in, never read from `process`: only main.ts does that.
 */

import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';

import type { ErrorObject, ValidateFunction } from 'ajv';

import { createValidator } from '../http/ajv.js';
import { defaultConfigPath, defaultDataDir } from '../store/paths.js';
import {
  ConfigError,
  ConfigSchema,
  DEFAULT_CONFIG,
  type LanternConfig,
  type ResolvedConfig,
} from './schema.js';

export interface LoadConfigOptions {
  /** `--config`, when given; it outranks `LANTERN_CONFIG`. */
  readonly path?: string | undefined;
  /** `--data`, when given; it outranks `LANTERN_DATA_DIR` and the file's `dataDir`. */
  readonly dataDir?: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  /** What a relative flag or variable is relative to. Defaults to the process's directory. */
  readonly cwd?: string | undefined;
}

type ValueKind = 'string' | 'integer' | 'boolean' | 'list';

/** The variables that set config keys, and how each value is read. */
export const CONFIG_ENVIRONMENT = {
  LANTERN_HOST: { key: 'host', kind: 'string' },
  LANTERN_PORT: { key: 'port', kind: 'integer' },
  LANTERN_DATA_DIR: { key: 'dataDir', kind: 'string' },
  LANTERN_APP_ROOT: { key: 'appRoot', kind: 'string' },
  LANTERN_AUTH_MODE: { key: 'auth.mode', kind: 'string' },
  LANTERN_TRUST_NETWORK: { key: 'auth.trustNetwork', kind: 'boolean' },
  LANTERN_COOKIE_SECURE: { key: 'auth.cookieSecure', kind: 'boolean' },
  LANTERN_ALLOWED_HOSTS: { key: 'allowedHosts', kind: 'list' },
  LANTERN_ALLOWED_ORIGINS: { key: 'allowedOrigins', kind: 'list' },
  LANTERN_LOG_LEVEL: { key: 'log.level', kind: 'string' },
} as const satisfies Record<string, { key: string; kind: ValueKind }>;

export type ConfigVariable = keyof typeof CONFIG_ENVIRONMENT;

const VARIABLE_OF_KEY = new Map<string, ConfigVariable>(
  Object.entries(CONFIG_ENVIRONMENT).map(([variable, { key }]) => [
    key,
    variable as ConfigVariable,
  ]),
);

/** An empty variable is unset: compose forwards an unset host variable as ''. */
function envValue(env: LoadConfigOptions['env'], name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Converted only when unambiguous, so `LANTERN_PORT=x` stays a string and the
 * schema refuses it as "must be integer" rather than as NaN.
 */
function parseValue(raw: string, kind: ValueKind): unknown {
  switch (kind) {
    case 'integer':
      return /^-?\d+$/.test(raw) ? Number.parseInt(raw, 10) : raw;
    case 'boolean':
      if (/^(?:1|true)$/i.test(raw)) return true;
      if (/^(?:0|false)$/i.test(raw)) return false;
      return raw;
    case 'list':
      return raw
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
    case 'string':
      return raw;
  }
}

type Document = Record<string, unknown>;

function isPlainObject(value: unknown): value is Document {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setPath(document: Document, key: string, value: unknown): void {
  const parts = key.split('.');
  const leaf = parts.pop() ?? key;
  let node = document;
  for (const part of parts) {
    const child = node[part];
    node = isPlainObject(child) ? child : (node[part] = {});
  }
  node[leaf] = value;
}

function hasPath(document: Document, key: string): boolean {
  let node: unknown = document;
  for (const part of key.split('.')) {
    if (!isPlainObject(node) || !Object.hasOwn(node, part)) return false;
    node = node[part];
  }
  return true;
}

/** The sparse document the environment describes, by variable. */
function environmentDocument(env: LoadConfigOptions['env']): {
  document: Document;
  variables: ConfigVariable[];
} {
  const document: Document = {};
  const variables: ConfigVariable[] = [];
  for (const [variable, { key, kind }] of Object.entries(CONFIG_ENVIRONMENT)) {
    const raw = envValue(env, variable);
    if (raw === undefined) continue;
    setPath(document, key, parseValue(raw, kind));
    variables.push(variable as ConfigVariable);
  }
  return { document, variables };
}

/** Deep merge with `over` on top. Arrays and scalars replace whole; objects merge. */
function mergeUnder(under: unknown, over: unknown): unknown {
  if (!isPlainObject(under) || !isPlainObject(over)) return over === undefined ? under : over;
  const result: Document = { ...under };
  for (const [key, value] of Object.entries(over)) {
    result[key] = Object.hasOwn(result, key) ? mergeUnder(result[key], value) : value;
  }
  return result;
}

let validator: ValidateFunction | null = null;

function validateConfig(document: unknown): readonly ErrorObject[] {
  validator ??= createValidator().compile(ConfigSchema);
  return validator(document) ? [] : (validator.errors ?? []);
}

/** The schema node at a JSON pointer into a config document. */
function schemaAt(pointer: string): Record<string, unknown> | undefined {
  let node: unknown = ConfigSchema;
  for (const segment of pointer.split('/').slice(1)) {
    if (!isPlainObject(node)) return undefined;
    const properties = node['properties'];
    node =
      isPlainObject(properties) && Object.hasOwn(properties, segment)
        ? properties[segment]
        : node['items'];
  }
  return isPlainObject(node) ? node : undefined;
}

function describeMember(member: unknown): string {
  if (!isPlainObject(member)) return 'a value';
  if (Object.hasOwn(member, 'const')) return JSON.stringify(member['const']);
  switch (member['type']) {
    case 'null':
      return 'null';
    case 'string':
      return 'a string';
    case 'integer':
      return 'an integer';
    case 'boolean':
      return 'true or false';
    default:
      return 'a value';
  }
}

function oneOfList(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1] ?? ''}`;
}

/** Which layer an error is about: its wording differs, because a variable cannot be null. */
type Layer = 'file' | 'environment';

/**
 * What a union accepts, in words. A variable cannot say null (an empty one is
 * unset), so the environment is offered only what it can say, and told that
 * leaving it unset is how to get what null would mean.
 */
function allowedValues(members: unknown, layer: Layer, pointer: string): string {
  if (!Array.isArray(members)) return 'valid';
  if (layer === 'file') return oneOfList(members.map(describeMember));
  const sayable = members.filter((member) => !(isPlainObject(member) && member['type'] === 'null'));
  const allowed = oneOfList(sayable.map(describeMember));
  return sayable.length === members.length
    ? allowed
    : `${allowed} (unset it to leave ${keyOfPointer(pointer)} to the config file or the default)`;
}

/**
 * Ajv's errors as sentences naming the key or variable. A failed union reports
 * one error per branch plus the union; those collapse into "must be one of …".
 */
function describeIssues(
  errors: readonly ErrorObject[],
  nameOf: (pointer: string) => string,
  layer: Layer = 'file',
): string[] {
  const unions = new Set(errors.filter((e) => e.keyword === 'anyOf').map((e) => e.instancePath));
  const issues = new Set<string>();
  for (const error of errors) {
    const { instancePath } = error;
    if (error.keyword === 'anyOf') {
      const allowed = allowedValues(schemaAt(instancePath)?.['anyOf'], layer, instancePath);
      issues.add(`${nameOf(instancePath)} must be ${allowed}`);
    } else if (!unions.has(instancePath)) {
      issues.add(`${nameOf(instancePath)} ${error.message ?? 'is invalid'}`);
    }
  }
  return [...issues];
}

/** `/auth/mode` → `auth.mode`; `/allowedHosts/1` → `allowedHosts[1]`. */
function keyOfPointer(pointer: string): string {
  if (pointer === '') return 'the document';
  let key = '';
  for (const segment of pointer.split('/').slice(1)) {
    if (/^\d+$/.test(segment)) key += `[${segment}]`;
    else key = key === '' ? segment : `${key}.${segment}`;
  }
  return key;
}

/** `/allowedHosts/1` → `LANTERN_ALLOWED_HOSTS`, the name that was typed. */
function variableOfPointer(pointer: string): string {
  const key = pointer
    .split('/')
    .slice(1)
    .filter((segment) => !/^\d+$/.test(segment))
    .join('.');
  return VARIABLE_OF_KEY.get(key) ?? keyOfPointer(pointer);
}

const HOST_NAME = /^[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?\.?$/i;

/**
 * Why a bind address or allowed host is not a bare host name, or null. Brackets
 * are accepted around an IPv6 address only (`[::1]`, as in a URL); around
 * anything else they are a typo that no lookup would resolve.
 */
function hostIssue(value: string): string | null {
  const bracketed = /^\[(.*)\]$/.exec(value);
  if (bracketed !== null) {
    return isIP(bracketed[1] ?? '') === 6
      ? null
      : 'must be a host name; only an IPv6 address goes in brackets';
  }
  if (isIP(value) !== 0) return null;
  if (value.includes('://') || value.includes('/')) {
    return 'must be a host name, without a scheme or path';
  }
  if (value.includes(':')) return 'must be a host name without a port';
  return HOST_NAME.test(value) ? null : 'must be a host name';
}

/**
 * `[::1]` → `::1`. Brackets belong in URLs; `listen()` looks a bracketed
 * address up as a name and fails, so the bind address is kept bare and URLs
 * add the brackets back.
 */
function unbracketed(host: string): string {
  const inner = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return isIP(inner) === 6 ? inner : host;
}

/** The normalized origin (`scheme://host[:port]`), or null if the value is not just an origin. */
export function parseOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const bare =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    // `http://host?` parses with an empty search; the stray character is still a typo.
    !/[?#]/.test(value);
  return bare ? url.origin : null;
}

/** Checks the schema cannot express: bare host names and bare origins. */
function semanticIssues(config: LanternConfig, nameOf: (pointer: string) => string): string[] {
  const issues: string[] = [];
  const hostProblem = hostIssue(config.host);
  if (hostProblem !== null) issues.push(`${nameOf('/host')} ${hostProblem}`);
  config.allowedHosts.forEach((host, index) => {
    const problem = hostIssue(host);
    if (problem !== null) issues.push(`${nameOf(`/allowedHosts/${String(index)}`)} ${problem}`);
  });
  config.allowedOrigins.forEach((origin, index) => {
    if (parseOrigin(origin) === null) {
      issues.push(
        `${nameOf(`/allowedOrigins/${String(index)}`)} must be an origin like http://host:port (no path)`,
      );
    }
  });
  return issues;
}

/** One layer over the defaults, validated; throws a ConfigError naming that layer's keys. */
function checkLayer(
  source: string,
  layer: Document,
  nameOf: (pointer: string) => string,
  kind: Layer,
): void {
  const merged = mergeUnder(structuredClone(DEFAULT_CONFIG), layer);
  const errors = validateConfig(merged);
  if (errors.length > 0) throw new ConfigError(source, describeIssues(errors, nameOf, kind));
  const issues = semanticIssues(merged as LanternConfig, nameOf);
  if (issues.length > 0) throw new ConfigError(source, issues);
}

/** Dotted paths of keys in the file this build does not know. Kept, and reported. */
function unknownKeys(document: Document, schema: unknown = ConfigSchema, prefix = ''): string[] {
  const properties = isPlainObject(schema) ? schema['properties'] : undefined;
  if (!isPlainObject(properties)) return [];
  return Object.entries(document).flatMap(([key, value]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (!Object.hasOwn(properties, key)) return [path];
    return isPlainObject(value) ? unknownKeys(value, properties[key], path) : [];
  });
}

function readConfigFile(path: string): Document | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new ConfigError(path, [`it cannot be read (${code ?? 'error'})`]);
  }
  // Windows PowerShell 5 (`Set-Content -Encoding UTF8`) and some editors start
  // the file with a byte-order mark, which JSON.parse refuses as an invisible
  // token. Only a leading one: anywhere else it is still not JSON.
  const json = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new ConfigError(path, [`it is not JSON (${(error as Error).message})`]);
  }
  if (!isPlainObject(parsed)) throw new ConfigError(path, ['the top level must be an object']);
  return parsed;
}

export function loadConfig(options: LoadConfigOptions): ResolvedConfig {
  const { env, platform, homedir } = options;
  const resolveHere = (path: string): string =>
    options.cwd === undefined ? resolve(path) : resolve(options.cwd, path);

  const configPath = resolveHere(
    options.path ??
      envValue(env, 'LANTERN_CONFIG') ??
      defaultConfigPath({ env, platform, homedir }),
  );

  const fileDocument = readConfigFile(configPath);
  const file = fileDocument ?? {};
  checkLayer(configPath, file, keyOfPointer, 'file');

  const environment = environmentDocument(env);
  checkLayer('the environment', environment.document, variableOfPointer, 'environment');

  const merged = mergeUnder(
    mergeUnder(structuredClone(DEFAULT_CONFIG), file),
    environment.document,
  ) as LanternConfig;
  const errors = validateConfig(merged);
  if (errors.length > 0) throw new ConfigError(configPath, describeIssues(errors, keyOfPointer));

  // A path from the file is relative to the file; from a flag or variable, to the working directory.
  const resolvePath = (key: 'dataDir' | 'appRoot', variable: ConfigVariable): string | null => {
    const fromEnv = envValue(env, variable);
    if (fromEnv !== undefined) return resolveHere(fromEnv);
    const fromFile = file[key];
    return typeof fromFile === 'string' ? resolve(dirname(configPath), fromFile) : null;
  };
  const configuredDataDir =
    options.dataDir === undefined
      ? resolvePath('dataDir', 'LANTERN_DATA_DIR')
      : resolveHere(options.dataDir);
  const dataDir = configuredDataDir ?? defaultDataDir({ env, platform, homedir });

  // Only the variables that decided something: with `--data`, LANTERN_DATA_DIR
  // did nothing, and the log must not say it overrode (or set) the directory.
  const effective = environment.variables.filter(
    (variable) => variable !== 'LANTERN_DATA_DIR' || options.dataDir === undefined,
  );
  const overrode = effective.filter((variable) => hasPath(file, CONFIG_ENVIRONMENT[variable].key));

  return {
    ...merged,
    host: unbracketed(merged.host),
    dataDir,
    appRoot: resolvePath('appRoot', 'LANTERN_APP_ROOT'),
    allowedHosts: merged.allowedHosts.map((host) => host.toLowerCase()),
    allowedOrigins: merged.allowedOrigins.map((origin) => parseOrigin(origin) ?? origin),
    provenance: {
      path: configPath,
      fileFound: fileDocument !== null,
      unknownKeys: unknownKeys(file),
      envOverrodeFile: overrode,
      envApplied: effective.filter((variable) => !overrode.includes(variable)),
      dataDirDefaulted: configuredDataDir === null,
    },
  };
}
