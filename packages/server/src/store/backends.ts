// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The backend registry's rows in `lantern.db`: backends, models and routes
 * (install schema 2). Rows in, rows out: what they mean is the registry's
 * (engine/backends). JSON columns are parsed on the way out and written as
 * JSON on the way in; a model's fingerprint is written as canonical JSON, so
 * equal identities are equal text and the unique index matches them (A26).
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import { inTransaction } from './db.js';

export type BackendRowSource = 'config' | 'ui';
export type BackendRowStatus = 'active' | 'tombstoned';
export type RouteRowHealth = 'ok' | 'degraded' | 'down';
export type RouteRowLoadState = 'loaded' | 'cold' | 'unknown';

export interface BackendRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, string>> | null;
  readonly resourceGroup: string;
  readonly concurrency: number;
  readonly source: BackendRowSource;
  readonly status: BackendRowStatus;
  /** The last health report, as the registry wrote it. */
  readonly health: unknown;
  /** Epoch milliseconds. */
  readonly lastSeen: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ModelRow {
  readonly id: string;
  readonly displayName: string;
  readonly family: string;
  readonly variant: string | null;
  /** The model's identity (L4), parsed. */
  readonly fingerprint: unknown;
  readonly profileOverrides: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RouteRow {
  readonly id: string;
  readonly modelId: string;
  readonly backendId: string;
  readonly adapterKind: string;
  readonly managerRef: string | null;
  readonly baseUrl: string;
  readonly priority: number;
  readonly cost: number | null;
  readonly health: RouteRowHealth;
  readonly loadState: RouteRowLoadState;
  readonly healthDetail: string | null;
  readonly retiredAt: number | null;
  /** The adapter's `describe()` result for the route, parsed. */
  readonly descriptor: unknown;
  readonly descriptorDigest: string | null;
  readonly descriptorFetchedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A JSON value with object keys sorted, so equal values are equal text. */
export function canonicalText(value: unknown): string {
  const sort = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sort);
    if (typeof node !== 'object' || node === null) return node;
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sort(item)]),
    );
  };
  return JSON.stringify(sort(value));
}

function parse(text: unknown): unknown {
  return typeof text === 'string' ? (JSON.parse(text) as unknown) : null;
}

function json(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function backendOf(row: Record<string, SQLInputValue>): BackendRow {
  return {
    id: text(row['id']),
    kind: text(row['kind']),
    name: text(row['name']),
    baseUrl: text(row['base_url']),
    settings: (parse(row['settings']) ?? {}) as Record<string, unknown>,
    secrets: parse(row['secrets']) as Record<string, string> | null,
    resourceGroup: text(row['resource_group']),
    concurrency: Number(row['concurrency']),
    source: text(row['source']) as BackendRowSource,
    status: text(row['status']) as BackendRowStatus,
    health: parse(row['health']),
    lastSeen: nullableNumber(row['last_seen']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  };
}

function modelOf(row: Record<string, SQLInputValue>): ModelRow {
  return {
    id: text(row['id']),
    displayName: text(row['display_name']),
    family: text(row['family']),
    variant: nullableText(row['variant']),
    fingerprint: parse(row['fingerprint']),
    profileOverrides: parse(row['profile_overrides']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  };
}

function routeOf(row: Record<string, SQLInputValue>): RouteRow {
  return {
    id: text(row['id']),
    modelId: text(row['model_id']),
    backendId: text(row['backend_id']),
    adapterKind: text(row['adapter_kind']),
    managerRef: nullableText(row['manager_ref']),
    baseUrl: text(row['base_url']),
    priority: Number(row['priority']),
    cost: nullableNumber(row['cost']),
    health: text(row['health']) as RouteRowHealth,
    loadState: text(row['load_state']) as RouteRowLoadState,
    healthDetail: nullableText(row['health_detail']),
    retiredAt: nullableNumber(row['retired_at']),
    descriptor: parse(row['descriptor']),
    descriptorDigest: nullableText(row['descriptor_digest']),
    descriptorFetchedAt: nullableNumber(row['descriptor_fetched_at']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  };
}

/** Column names by row field, and which columns hold JSON. */
const BACKEND_COLUMNS: Readonly<Record<keyof BackendRow, string>> = {
  id: 'id',
  kind: 'kind',
  name: 'name',
  baseUrl: 'base_url',
  settings: 'settings',
  secrets: 'secrets',
  resourceGroup: 'resource_group',
  concurrency: 'concurrency',
  source: 'source',
  status: 'status',
  health: 'health',
  lastSeen: 'last_seen',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};
const MODEL_COLUMNS: Readonly<Record<keyof ModelRow, string>> = {
  id: 'id',
  displayName: 'display_name',
  family: 'family',
  variant: 'variant',
  fingerprint: 'fingerprint',
  profileOverrides: 'profile_overrides',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};
const ROUTE_COLUMNS: Readonly<Record<keyof RouteRow, string>> = {
  id: 'id',
  modelId: 'model_id',
  backendId: 'backend_id',
  adapterKind: 'adapter_kind',
  managerRef: 'manager_ref',
  baseUrl: 'base_url',
  priority: 'priority',
  cost: 'cost',
  health: 'health',
  loadState: 'load_state',
  healthDetail: 'health_detail',
  retiredAt: 'retired_at',
  descriptor: 'descriptor',
  descriptorDigest: 'descriptor_digest',
  descriptorFetchedAt: 'descriptor_fetched_at',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};
/** The columns of each table that hold JSON (a route's `health` is a word, a backend's a report). */
const JSON_COLUMNS: Readonly<Record<string, ReadonlySet<string>>> = {
  backends: new Set(['settings', 'secrets', 'health']),
  models: new Set(['profile_overrides']),
  routes: new Set(['descriptor', 'probe_results', 'overrides']),
};

function encode(table: string, column: string, value: unknown): SQLInputValue {
  if (column === 'fingerprint') return canonicalText(value);
  if (column === 'settings') return JSON.stringify(value ?? {});
  if (JSON_COLUMNS[table]?.has(column) === true) return json(value);
  if (value === undefined) return null;
  return value as SQLInputValue;
}

/** The registry's rows, over the install database's connection. */
export class BackendStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Runs `mutate` in one transaction. */
  transaction<T>(mutate: () => T extends PromiseLike<unknown> ? never : T): T {
    return inTransaction(this.#db, mutate);
  }

  private insert<T extends object>(
    table: string,
    columns: Readonly<Record<keyof T, string>>,
    row: T,
  ): void {
    const entries = (Object.keys(columns) as (keyof T)[]).map(
      (field) => [columns[field], encode(table, columns[field], row[field])] as const,
    );
    this.#db
      .prepare(
        `insert into ${table} (${entries.map(([column]) => column).join(', ')}) values (${entries.map(() => '?').join(', ')})`,
      )
      .run(...entries.map(([, value]) => value));
  }

  private update<T extends object>(
    table: string,
    columns: Readonly<Record<keyof T, string>>,
    id: string,
    patch: Partial<T>,
  ): void {
    const entries = (Object.keys(patch) as (keyof T)[])
      .filter((field) => field !== 'id' && patch[field] !== undefined)
      .map((field) => [columns[field], encode(table, columns[field], patch[field])] as const);
    if (entries.length === 0) return;
    this.#db
      .prepare(
        `update ${table} set ${entries.map(([column]) => `${column} = ?`).join(', ')} where id = ?`,
      )
      .run(...entries.map(([, value]) => value), id);
  }

  backends(): BackendRow[] {
    return this.#db.prepare('select * from backends order by created_at, id').all().map(backendOf);
  }

  backend(id: string): BackendRow | undefined {
    const row = this.#db.prepare('select * from backends where id = ?').get(id);
    return row === undefined ? undefined : backendOf(row);
  }

  insertBackend(row: BackendRow): void {
    this.insert('backends', BACKEND_COLUMNS, row);
  }

  /** Changes the given fields; `null` clears a nullable one. */
  updateBackend(id: string, patch: Partial<BackendRow>): void {
    this.update('backends', BACKEND_COLUMNS, id, patch);
  }

  models(): ModelRow[] {
    return this.#db.prepare('select * from models order by created_at, id').all().map(modelOf);
  }

  model(id: string): ModelRow | undefined {
    const row = this.#db.prepare('select * from models where id = ?').get(id);
    return row === undefined ? undefined : modelOf(row);
  }

  /** The model with this identity (A26), compared as canonical JSON. */
  modelByFingerprint(fingerprint: unknown): ModelRow | undefined {
    const row = this.#db
      .prepare('select * from models where fingerprint = ?')
      .get(canonicalText(fingerprint));
    return row === undefined ? undefined : modelOf(row);
  }

  insertModel(row: ModelRow): void {
    this.insert('models', MODEL_COLUMNS, row);
  }

  updateModel(id: string, patch: Partial<ModelRow>): void {
    this.update('models', MODEL_COLUMNS, id, patch);
  }

  routes(): RouteRow[] {
    return this.#db.prepare('select * from routes order by created_at, id').all().map(routeOf);
  }

  route(id: string): RouteRow | undefined {
    const row = this.#db.prepare('select * from routes where id = ?').get(id);
    return row === undefined ? undefined : routeOf(row);
  }

  insertRoute(row: RouteRow): void {
    this.insert('routes', ROUTE_COLUMNS, row);
  }

  updateRoute(id: string, patch: Partial<RouteRow>): void {
    this.update('routes', ROUTE_COLUMNS, id, patch);
  }
}
