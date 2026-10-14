// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { describe, expect, it } from 'vitest';

import { derivedBootId, readMachineBootId, sameMachineBoot } from './boot.js';

const UUID = '6f1c2b0e-3d4a-4b5c-8d9e-0a1b2c3d4e5f';

/** Sources that fail unless a test says otherwise, so each test names what it relies on. */
const failing = {
  readFile: () => Promise.reject(new Error('no /proc here')),
  sysctl: () => Promise.reject(new Error('no sysctl here')),
  now: () => 1_700_000_000_000,
  uptimeSeconds: () => 3600,
};

describe('readMachineBootId', () => {
  it('reads the kernel boot id on Linux', async () => {
    const paths: string[] = [];
    const id = await readMachineBootId('linux', {
      ...failing,
      readFile: (path) => {
        paths.push(path);
        return Promise.resolve(`${UUID.toUpperCase()}\n`);
      },
    });
    expect(paths).toEqual(['/proc/sys/kernel/random/boot_id']);
    expect(id).toBe(UUID);
  });

  it('asks sysctl for the boot session on macOS', async () => {
    const names: string[] = [];
    const id = await readMachineBootId('darwin', {
      ...failing,
      sysctl: (name) => {
        names.push(name);
        return Promise.resolve(`${UUID}\n`);
      },
    });
    expect(names).toEqual(['kern.bootsessionuuid']);
    expect(id).toBe(UUID);
  });

  it('derives the boot time on Windows', async () => {
    expect(await readMachineBootId('win32', failing)).toBe('boot-time:1699996400');
  });

  it('falls back to the boot time when the kernel id is missing or not an id', async () => {
    expect(await readMachineBootId('linux', failing)).toBe('boot-time:1699996400');
    expect(
      await readMachineBootId('darwin', { ...failing, sysctl: () => Promise.resolve('garbage') }),
    ).toBe('boot-time:1699996400');
  });

  it('answers the same id twice on this machine', async () => {
    const first = await readMachineBootId(process.platform);
    expect(first).not.toBe('');
    expect(sameMachineBoot(first, await readMachineBootId(process.platform))).toBe(true);
  });
});

describe('sameMachineBoot', () => {
  it('compares kernel ids exactly', () => {
    expect(sameMachineBoot(UUID, UUID)).toBe(true);
    expect(sameMachineBoot(UUID, UUID.replace('6f', '7f'))).toBe(false);
  });

  it('lets derived ids drift a little, since now − uptime is sampled', () => {
    const boot = derivedBootId(1_700_000_000_000, 3600);
    expect(sameMachineBoot(boot, derivedBootId(1_700_000_030_400, 3630))).toBe(true);
    expect(sameMachineBoot(boot, derivedBootId(1_700_000_000_000, 3540))).toBe(true);
    expect(sameMachineBoot(boot, derivedBootId(1_700_000_000_000, 60))).toBe(false);
  });

  it('never matches a derived id with a kernel id', () => {
    expect(sameMachineBoot(derivedBootId(0, 0), UUID)).toBe(false);
  });
});
