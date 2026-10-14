// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createUlidGenerator } from '../ids.js';
import { inTransaction } from './db.js';
import { StoreError } from './errors.js';
import { InstallSchemaTooNewError, openInstall, openInstallStore } from './install.js';
import { LEASE_STALE_AFTER_MS, readLease, writeLease } from './lease.js';
import { InstanceLockHeldError } from './lock.js';
import { INSTALL_STEPS } from './migrations.js';
import { dataPaths } from './paths.js';
import { DatabaseNotWritableError } from './upgrade.js';
import {
  collectingLog,
  removeDir,
  tempDir,
  testBoot,
  userVersionOf,
  withDatabase,
} from './test-store.js';

const OTHER_BOOT = '00000000-0000-4000-8000-0000000000ff';

let dataDir: string;
let installDb: string;

beforeEach(async () => {
  dataDir = await tempDir('install');
  installDb = dataPaths(dataDir).installDb;
});

afterEach(async () => {
  await removeDir(dataDir);
});

/** An install database left by an earlier run, with `lease` written as if by another process. */
async function leftBehind(
  lease: Parameters<typeof testBoot>[0],
  heartbeatAt: number,
): Promise<void> {
  const { store } = await openInstall(dataDir, { boot: testBoot(), log: collectingLog() });
  store.close();
  withDatabase(installDb, (db) => {
    inTransaction(db, () => {
      writeLease(db, testBoot(lease), heartbeatAt);
    });
  });
}

function leaseNow() {
  return withDatabase(installDb, (db) => readLease(db), true);
}

describe('openInstallStore', () => {
  it('creates lantern.db at the current schema and writes this process’s lease', async () => {
    const boot = testBoot();
    const before = Date.now();
    const { store, migration } = await openInstall(dataDir, { boot, log: collectingLog() });
    try {
      expect(migration).toEqual({ from: 0, to: INSTALL_STEPS.length, snapshot: null });
      expect(store.schemaVersion).toBe(INSTALL_STEPS.length);
      expect(store.db.prepare('pragma journal_mode').get()?.['journal_mode']).toBe('wal');

      const lease = readLease(store.db);
      expect(lease).toMatchObject({
        pid: boot.pid,
        processId: boot.processId,
        machineBootId: boot.machineBootId,
        hostname: boot.hostname,
      });
      expect(lease?.startedAt).toBeGreaterThanOrEqual(before);
      expect(lease?.heartbeatAt).toBe(lease?.startedAt);
    } finally {
      store.close();
    }
    // Nothing to snapshot on a new file.
    expect(existsSync(dataPaths(dataDir).backups)).toBe(false);
  });

  it('reopens without migrating, and a clean close leaves no lease to take over', async () => {
    (await openInstallStore(dataDir, { boot: testBoot(), log: collectingLog() })).close();
    expect(leaseNow()).toBeNull();

    const log = collectingLog();
    const { store, migration } = await openInstall(dataDir, { boot: testBoot(), log });
    store.close();
    expect(migration).toEqual({ from: 1, to: 1, snapshot: null });
    expect(log.lines).toEqual([]);
  });

  it('closes idempotently, and a heartbeat after close does nothing', async () => {
    const store = await openInstallStore(dataDir, { boot: testBoot(), log: collectingLog() });
    store.close();
    expect(() => {
      store.close();
      store.heartbeat();
    }).not.toThrow();
  });

  it('refreshes the heartbeat', async () => {
    const store = await openInstallStore(dataDir, { boot: testBoot(), log: collectingLog() });
    try {
      store.db.prepare('update lease set heartbeat_at = 0').run();
      store.heartbeat();
      expect(readLease(store.db)?.heartbeatAt).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it('says once, loudly, when another process has taken its lease, and leaves that row alone', async () => {
    const log = collectingLog();
    const store = await openInstallStore(dataDir, { boot: testBoot(), log });
    try {
      store.db.prepare("update lease set process_id = 'proc_someone_else', pid = 7").run();
      store.heartbeat();
      store.heartbeat();
      const errors = log.lines.filter((line) => line.level === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.fields['holder']).toMatch(/^pid 7 on test-host/);
      store.close();
      expect(leaseNow()?.processId).toBe('proc_someone_else');
    } finally {
      store.close();
    }
  });

  describe('a lease row left behind', () => {
    it('is taken over when it is stale', async () => {
      await leftBehind({ pid: 1111, processId: 'proc_old' }, Date.now() - LEASE_STALE_AFTER_MS - 1);
      const log = collectingLog();
      const store = await openInstallStore(dataDir, { boot: testBoot(), log });
      try {
        expect(readLease(store.db)?.processId).toBe(testBoot().processId);
        expect(log.lines).toContainEqual(
          expect.objectContaining({
            level: 'warn',
            fields: expect.objectContaining({ previousPid: 1111 }),
          }),
        );
      } finally {
        store.close();
      }
    });

    it('is taken over when fresh but from this boot: the OS lock we hold says its writer is gone', async () => {
      await leftBehind({ pid: 2222, processId: 'proc_crashed' }, Date.now());
      const store = await openInstallStore(dataDir, { boot: testBoot(), log: collectingLog() });
      try {
        expect(readLease(store.db)?.pid).toBe(testBoot().pid);
      } finally {
        store.close();
      }
    });

    it('is respected when fresh and from another boot, where the OS lock may not reach', async () => {
      await leftBehind(
        { pid: 3333, processId: 'proc_nas', machineBootId: OTHER_BOOT, hostname: 'nas' },
        Date.now(),
      );
      const attempt = openInstallStore(dataDir, { boot: testBoot(), log: collectingLog() });
      await expect(attempt).rejects.toThrow(InstanceLockHeldError);
      await expect(attempt).rejects.toThrow(/pid 3333 on nas, last heartbeat \d+ s ago/);
      expect(leaseNow()?.processId).toBe('proc_nas');
    });

    describe('from an earlier boot of this host', () => {
      // A crash, then a reboot inside the stale window: this machine booted 30 s ago.
      const now = Date.now();
      const options = { now: () => now, bootedAt: now - 30_000 };
      const earlierBoot = { pid: 500, processId: 'proc_before_reboot', machineBootId: OTHER_BOOT };

      it('is taken over when its heartbeat predates this boot, fresh or not', async () => {
        await leftBehind(earlierBoot, options.bootedAt - 1000);
        const log = collectingLog();
        const { store } = await openInstall(dataDir, { boot: testBoot(), log }, options);
        try {
          expect(readLease(store.db)?.processId).toBe(testBoot().processId);
          expect(log.lines).toContainEqual(
            expect.objectContaining({
              level: 'warn',
              message: 'Took over the lease from a Lantern that did not shut down cleanly.',
              fields: expect.objectContaining({ previousPid: 500 }),
            }),
          );
        } finally {
          store.close();
        }
      });

      it('is respected when its heartbeat is fresh and since this boot', async () => {
        // Not from an earlier boot at all: another machine sharing the hostname, alive.
        await leftBehind(earlierBoot, options.bootedAt + 1000);
        const attempt = openInstall(dataDir, { boot: testBoot(), log: collectingLog() }, options);
        await expect(attempt).rejects.toThrow(InstanceLockHeldError);
        expect(leaseNow()?.processId).toBe('proc_before_reboot');
      });

      it('is taken over when its heartbeat is further ahead than the stale window', async () => {
        // Written by a clock that ran ahead, before it was corrected.
        await leftBehind(earlierBoot, now + 2 * 60 * 1000);
        const { store } = await openInstall(
          dataDir,
          { boot: testBoot(), log: collectingLog() },
          options,
        );
        store.close();
        expect(leaseNow()).toBeNull();
      });
    });

    it('is respected from another host even when its heartbeat predates this boot', async () => {
      const now = Date.now();
      await leftBehind(
        { pid: 3333, processId: 'proc_nas', machineBootId: OTHER_BOOT, hostname: 'nas' },
        now - 10_000,
      );
      const attempt = openInstall(
        dataDir,
        { boot: testBoot(), log: collectingLog() },
        { now: () => now, bootedAt: now - 5_000 },
      );
      await expect(attempt).rejects.toThrow(InstanceLockHeldError);
    });

    it('says a heartbeat in the future is in the future, not 0 s ago', async () => {
      const now = Date.now();
      await leftBehind(
        { pid: 3333, processId: 'proc_nas', machineBootId: OTHER_BOOT, hostname: 'nas' },
        now + 30_000,
      );
      const attempt = openInstall(
        dataDir,
        { boot: testBoot(), log: collectingLog() },
        { now: () => now },
      );
      await expect(attempt).rejects.toThrow(/pid 3333 on nas, last heartbeat 30 s in the future/);
    });

    it('is taken over when from another boot but stale', async () => {
      await leftBehind(
        { pid: 3333, processId: 'proc_nas', machineBootId: OTHER_BOOT, hostname: 'nas' },
        Date.now() - LEASE_STALE_AFTER_MS - 1,
      );
      const store = await openInstallStore(dataDir, { boot: testBoot(), log: collectingLog() });
      store.close();
      expect(leaseNow()).toBeNull();
    });
  });

  it('refuses a database written by a newer build and changes nothing in it', async () => {
    withDatabase(installDb, (db) => {
      db.exec('pragma user_version = 99');
    });
    const attempt = openInstallStore(dataDir, { boot: testBoot(), log: collectingLog() });
    await expect(attempt).rejects.toThrow(InstallSchemaTooNewError);
    await expect(attempt).rejects.toThrow(/schema version 99, but this Lantern knows 1/);
    expect(userVersionOf(installDb)).toBe(99);
    // Not even switched to WAL: the probe opened it read-only.
    expect(
      withDatabase(
        installDb,
        (db) => db.prepare('pragma journal_mode').get()?.['journal_mode'],
        true,
      ),
    ).toBe('delete');
  });

  it('refuses a newer database whose lease table this build cannot read for its version, not as damage', async () => {
    withDatabase(installDb, (db) => {
      db.exec(`
        create table lease (id integer primary key, boot_id text, host text, heartbeat text) strict;
        insert into lease values (1, 'b', null, 'soon');
        pragma user_version = ${String(INSTALL_STEPS.length + 1)};
      `);
    });
    const bytes = await readFile(installDb);
    const attempt = openInstallStore(dataDir, { boot: testBoot(), log: collectingLog() });
    await expect(attempt).rejects.toThrow(InstallSchemaTooNewError);
    expect(Buffer.compare(await readFile(installDb), bytes)).toBe(0);
  });

  describe('a refusal leaves the data directory alone', () => {
    async function partialSnapshot(): Promise<string> {
      const backups = dataPaths(dataDir).backups;
      await mkdir(backups, { recursive: true });
      const partial = join(backups, `lantern.v1.${createUlidGenerator()(Date.now())}.db.part`);
      await writeFile(partial, '');
      return partial;
    }

    it('including a partial snapshot a live holder elsewhere may still be writing', async () => {
      await leftBehind(
        { pid: 3333, processId: 'proc_nas', machineBootId: OTHER_BOOT, hostname: 'nas' },
        Date.now(),
      );
      const partial = await partialSnapshot();
      await expect(
        openInstallStore(dataDir, { boot: testBoot(), log: collectingLog() }),
      ).rejects.toThrow(InstanceLockHeldError);
      expect(existsSync(partial)).toBe(true);
    });

    it('when the database is newer than this build', async () => {
      withDatabase(installDb, (db) => {
        db.exec('pragma user_version = 99');
      });
      const partial = await partialSnapshot();
      await expect(
        openInstallStore(dataDir, { boot: testBoot(), log: collectingLog() }),
      ).rejects.toThrow(InstallSchemaTooNewError);
      expect(existsSync(partial)).toBe(true);
    });
  });

  // Root ignores permission bits, so the file would be writable after all.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses a lantern.db this process cannot write in one sentence, leaving nothing beside it',
    async () => {
      (await openInstallStore(dataDir, { boot: testBoot(), log: collectingLog() })).close();
      await chmod(installDb, 0o444);
      const attempt = openInstallStore(dataDir, { boot: testBoot(), log: collectingLog() });
      // A StoreError, so the CLI prints the message alone rather than a stack trace.
      await expect(attempt).rejects.toThrow(DatabaseNotWritableError);
      await expect(attempt).rejects.toThrow(StoreError);
      await expect(attempt).rejects.toThrow(
        `lantern.db (${installDb}) cannot be written by this process (EACCES on ${installDb}).`,
      );
      expect(existsSync(`${installDb}-wal`)).toBe(false);
      expect(existsSync(`${installDb}-shm`)).toBe(false);
    },
  );

  it('refuses a file that is not a database, in one sentence', async () => {
    await writeFile(installDb, 'not a database, but long enough to be read as one and rejected');
    const attempt = openInstallStore(dataDir, { boot: testBoot(), log: collectingLog() });
    await expect(attempt).rejects.toThrow(StoreError);
    await expect(attempt).rejects.toThrow(/lantern\.db could not be read/);
  });

  it('snapshots an existing database with pending steps into <data>/backups first', async () => {
    (await openInstallStore(dataDir, { boot: testBoot(), log: collectingLog() })).close();
    const next = [...INSTALL_STEPS, { sql: 'create table later (id text primary key) strict;' }];

    const { store, migration } = await openInstall(
      dataDir,
      { boot: testBoot(), log: collectingLog() },
      { steps: next },
    );
    store.close();
    expect(migration.from).toBe(1);
    expect(migration.to).toBe(2);
    expect(migration.snapshot).toMatch(/[/\\]backups[/\\]lantern\.v1\.[0-9A-Z]{26}\.db$/);
    expect(userVersionOf(migration.snapshot ?? '')).toBe(1);
  });

  it('sweeps partial snapshots an interrupted migration left', async () => {
    const backups = dataPaths(dataDir).backups;
    await mkdir(backups, { recursive: true });
    await writeFile(join(backups, `lantern.v1.${createUlidGenerator()(1_000)}.db.part`), '');
    (await openInstallStore(dataDir, { boot: testBoot(), log: collectingLog() })).close();
    expect(await readdir(backups)).toEqual([]);
  });
});
