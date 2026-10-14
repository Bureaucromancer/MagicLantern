// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The lock is the kernel's, so what matters is what another process sees:
 * refused while a holder is alive, free the moment it is gone, however it
 * went, and never let go by anything the store does while this process holds it.
 */

import type { ChildProcess } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inTransaction } from './db.js';
import { StoreError } from './errors.js';
import { DataDirError } from './files.js';
import { openInstall } from './install.js';
import { writeLease } from './lease.js';
import { openLibraries } from './libraries.js';
import { acquireInstanceLock, InstanceLockHeldError } from './lock.js';
import { migrateAll } from './migrate.js';
import { dataPaths } from './paths.js';
import {
  aProcessHoldingTheLock,
  aProcessThatHeldTheLockAndDied,
  collectingLog,
  killAndWait,
  lockIsFreeElsewhere,
  removeDir,
  tempDir,
  testBoot,
} from './test-store.js';

let dataDir: string;
let child: ChildProcess | null = null;

beforeEach(async () => {
  dataDir = await tempDir('lock');
});

afterEach(async () => {
  if (child !== null) await killAndWait(child);
  child = null;
  await removeDir(dataDir);
});

function refusalOf(take: () => void): unknown {
  try {
    take();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('the instance lock', () => {
  it('refuses a second holder in this process, naming the directory, and survives the attempt', () => {
    const first = acquireInstanceLock(dataDir);
    try {
      const refusal = refusalOf(() => {
        acquireInstanceLock(dataDir).release();
      });
      expect(refusal).toBeInstanceOf(InstanceLockHeldError);
      expect((refusal as Error).message).toContain(dataDir);
      expect(lockIsFreeElsewhere(dataPaths(dataDir).lock)).toBe(false);
    } finally {
      first.release();
    }
  });

  it('can be taken again once released, and releasing twice is harmless', () => {
    const lock = acquireInstanceLock(dataDir);
    lock.release();
    lock.release();
    expect(lockIsFreeElsewhere(dataPaths(dataDir).lock)).toBe(true);
    acquireInstanceLock(dataDir).release();
  });

  it('is refused while another process holds it, and free once that process is killed', async () => {
    child = await aProcessHoldingTheLock(dataPaths(dataDir).lock);
    expect(
      refusalOf(() => {
        acquireInstanceLock(dataDir).release();
      }),
    ).toBeInstanceOf(InstanceLockHeldError);

    await killAndWait(child);
    expect(() => {
      acquireInstanceLock(dataDir).release();
    }).not.toThrow();
  });

  it('is free once a holder has exited without releasing, with nothing to clean up', () => {
    aProcessThatHeldTheLockAndDied(dataPaths(dataDir).lock);
    expect(() => {
      acquireInstanceLock(dataDir).release();
    }).not.toThrow();
  });

  it('names the holder from a fresh lease row when it has one', async () => {
    // The lease row a running daemon keeps, while another process holds the lock.
    const { store } = await openInstall(dataDir, {
      boot: testBoot({ pid: 9876 }),
      log: collectingLog(),
    });
    try {
      child = await aProcessHoldingTheLock(dataPaths(dataDir).lock);
      const refusal = refusalOf(() => {
        acquireInstanceLock(dataDir).release();
      });
      expect((refusal as Error).message).toMatch(
        /^Another Lantern is already using the data directory .+ \(pid 9876 on test-host, last heartbeat \d+ s ago\)\.$/,
      );
    } finally {
      store.close();
    }
  });

  it('does not name a holder whose lease row is stale', async () => {
    const { store } = await openInstall(dataDir, { boot: testBoot(), log: collectingLog() });
    inTransaction(store.db, () => {
      writeLease(store.db, testBoot({ pid: 1111 }), Date.now() - 60 * 60 * 1000);
    });
    try {
      child = await aProcessHoldingTheLock(dataPaths(dataDir).lock);
      const refusal = refusalOf(() => {
        acquireInstanceLock(dataDir).release();
      });
      expect((refusal as Error).message).toBe(
        `Another Lantern is already using the data directory ${dataDir}.`,
      );
    } finally {
      store.close();
    }
  });

  // Root ignores permission bits, so the file would be writable after all.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'is refused when this process cannot write the lock file, though SQLite would open it read-only',
    async () => {
      const lockPath = dataPaths(dataDir).lock;
      await writeFile(lockPath, '');
      await chmod(lockPath, 0o444);
      // What a second daemon would find: a holder whose read-only open took only a shared lock.
      child = await aProcessHoldingTheLock(lockPath);
      const refusal = refusalOf(() => {
        acquireInstanceLock(dataDir).release();
      });
      expect(refusal).toBeInstanceOf(DataDirError);
      expect((refusal as Error).message).toContain(`EACCES on access ${lockPath}`);
      expect((refusal as Error).message).toContain('chown -R');
    },
  );

  it('refuses a lock file that is not one, in one sentence', async () => {
    const lockPath = dataPaths(dataDir).lock;
    await writeFile(lockPath, 'hello, not a SQLite file');
    const refusal = refusalOf(() => {
      acquireInstanceLock(dataDir).release();
    });
    expect(refusal).toBeInstanceOf(StoreError);
    expect(refusal).not.toBeInstanceOf(InstanceLockHeldError);
    expect((refusal as Error).message).toBe(
      `${lockPath} is not a Lantern lock file; remove it and start again.`,
    );
  });

  it('is not let go by opening, migrating and closing the stores while it is held', async () => {
    const lock = acquireInstanceLock(dataDir);
    try {
      await migrateAll(dataDir, { boot: testBoot(), log: collectingLog() });
      const { store } = await openInstall(dataDir, { boot: testBoot(), log: collectingLog() });
      const { registry } = await openLibraries(store, dataDir, { log: collectingLog() });
      registry.close();
      store.close();
      expect(lockIsFreeElsewhere(dataPaths(dataDir).lock)).toBe(false);
    } finally {
      lock.release();
    }
  });
});
