// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The lease row in `lantern.db`: who holds the data directory (pid, a random
 * per-process id, the machine boot id, hostname) and when they last said so.
 *
 * The OS lock on `lantern.lock` is the authority (lock.ts); the row is what
 * a refusal can say about the holder, and the only signal that crosses hosts
 * where that lock does not (NFS/SMB, some Docker Desktop bind mounts). So a
 * row from the same boot of the same kernel is always stale (we hold the
 * lock), while a row from another boot is respected while its heartbeat is
 * fresh. Except a row from an earlier boot of this host: nothing that boot
 * ran is still running, so it is stale when its heartbeat predates this boot
 * (a crash, then a reboot inside the stale window) or is further in the
 * future than the stale window (a clock that ran ahead before the crash).
 * A live daemon on another machine with the same hostname over a network
 * filesystem heartbeats after our boot, unless we booted within the last
 * heartbeat or two. Heartbeats compare clocks across hosts, so a badly skewed
 * clock can misjudge freshness; the OS lock still covers every same-machine
 * case.
 */

import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { sameMachineBoot } from './boot.js';
import { closeDatabase, numberColumn, openDatabase, tableExists, textColumn } from './db.js';
import { dataPaths } from './paths.js';
import type { BootIdentity } from './types.js';

/** How often serve refreshes `heartbeat_at`. */
export const LEASE_HEARTBEAT_MS = 15_000;

/** A heartbeat older than this (four missed beats) belongs to a process that is gone. */
export const LEASE_STALE_AFTER_MS = 4 * LEASE_HEARTBEAT_MS;

export interface LeaseRow {
  readonly pid: number;
  readonly processId: string;
  readonly machineBootId: string;
  readonly hostname: string;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  /** Epoch milliseconds. */
  readonly heartbeatAt: number;
}

/** The lease row, or null when there is none (a clean shutdown deletes it). */
export function readLease(db: DatabaseSync): LeaseRow | null {
  const row = db
    .prepare(
      'select pid, process_id, machine_boot_id, hostname, started_at, heartbeat_at from lease where id = 1',
    )
    .get();
  if (row === undefined) return null;
  return {
    pid: numberColumn(row, 'pid'),
    processId: textColumn(row, 'process_id'),
    machineBootId: textColumn(row, 'machine_boot_id'),
    hostname: textColumn(row, 'hostname'),
    startedAt: numberColumn(row, 'started_at'),
    heartbeatAt: numberColumn(row, 'heartbeat_at'),
  };
}

export function isLeaseFresh(lease: LeaseRow, now: number): boolean {
  return now - lease.heartbeatAt < LEASE_STALE_AFTER_MS;
}

/**
 * Whether an existing row stops `boot` from taking the lease: only a fresh
 * heartbeat from another boot, whose holder our OS lock may not have seen,
 * and never one from an earlier boot of this host. `bootedAt` is when this
 * machine booted, in epoch milliseconds.
 */
export function leaseHeldElsewhere(
  lease: LeaseRow,
  boot: BootIdentity,
  now: number,
  bootedAt: number,
): boolean {
  if (sameMachineBoot(lease.machineBootId, boot.machineBootId)) return false;
  if (lease.hostname === boot.hostname && fromAnEarlierBoot(lease, now, bootedAt)) return false;
  return isLeaseFresh(lease, now);
}

/** A heartbeat from before this boot, or too far ahead to come from this clock. */
function fromAnEarlierBoot(lease: LeaseRow, now: number, bootedAt: number): boolean {
  return lease.heartbeatAt < bootedAt || lease.heartbeatAt > now + LEASE_STALE_AFTER_MS;
}

/** "pid 4242 on nas, last heartbeat 3 s ago": the holder, for a refusal or a log line. */
export function describeLease(lease: LeaseRow, now: number): string {
  const ageSeconds = Math.round((now - lease.heartbeatAt) / 1000);
  const when =
    ageSeconds < 0 ? `${String(-ageSeconds)} s in the future` : `${String(ageSeconds)} s ago`;
  return `pid ${String(lease.pid)} on ${lease.hostname}, last heartbeat ${when}`;
}

/** Writes this process's row over whatever was there. Call inside a transaction. */
export function writeLease(db: DatabaseSync, boot: BootIdentity, now: number): void {
  db.prepare(
    `insert into lease (id, pid, process_id, machine_boot_id, hostname, started_at, heartbeat_at)
     values (1, ?, ?, ?, ?, ?, ?)
     on conflict (id) do update set
       pid = excluded.pid,
       process_id = excluded.process_id,
       machine_boot_id = excluded.machine_boot_id,
       hostname = excluded.hostname,
       started_at = excluded.started_at,
       heartbeat_at = excluded.heartbeat_at`,
  ).run(boot.pid, boot.processId, boot.machineBootId, boot.hostname, now, now);
}

/** Refreshes our heartbeat; false when the row is no longer ours. */
export function touchLease(db: DatabaseSync, processId: string, now: number): boolean {
  const result = db
    .prepare('update lease set heartbeat_at = ? where id = 1 and process_id = ?')
    .run(now, processId);
  return Number(result.changes) > 0;
}

/** Removes our row on a clean shutdown, and only ours. */
export function releaseLease(db: DatabaseSync, processId: string): void {
  db.prepare('delete from lease where id = 1 and process_id = ?').run(processId);
}

/**
 * The live holder of a data directory, read without writing, for the message
 * when its lock is refused; undefined when there is no fresh row to name (the
 * holder may be a command that writes none, such as set-password). Opens
 * lantern.db, never the lock file: closing any fd to that drops our own lock.
 */
export function describeLeaseHolder(dataDir: string, now: number): string | undefined {
  const { installDb } = dataPaths(dataDir);
  if (!existsSync(installDb)) return undefined;
  let db: DatabaseSync | null = null;
  try {
    db = openDatabase(installDb, { readOnly: true });
    if (!tableExists(db, 'lease')) return undefined;
    const lease = readLease(db);
    return lease !== null && isLeaseFresh(lease, now) ? describeLease(lease, now) : undefined;
  } catch {
    // Only decoration for a refusal that stands on its own.
    return undefined;
  } finally {
    if (db !== null) closeDatabase(db);
  }
}
