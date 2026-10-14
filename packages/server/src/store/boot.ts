// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The machine boot id for the lease row: Linux `/proc/sys/kernel/random/boot_id`;
 * macOS `sysctl -n kern.bootsessionuuid`; otherwise (Windows, or when those
 * fail) the boot time derived from `os.uptime()`. Containers sharing a volume
 * share the kernel's boot id, which is what lets the lease tell a reused pid
 * from a live one, and a second machine on a network filesystem from this one.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { uptime } from 'node:os';
import { promisify } from 'node:util';

/** Where the id comes from; injectable so tests can ask what another platform does. */
export interface BootIdSources {
  readFile(path: string): Promise<string>;
  sysctl(name: string): Promise<string>;
  /** Epoch milliseconds. */
  now(): number;
  /** Seconds since boot. */
  uptimeSeconds(): number;
}

const SYSCTL_TIMEOUT_MS = 2000;

const runFile = promisify(execFile);

const DEFAULT_SOURCES: BootIdSources = {
  readFile: (path) => readFile(path, 'utf8'),
  // An absolute path, so PATH cannot substitute another sysctl.
  sysctl: async (name) =>
    (
      await runFile('/usr/sbin/sysctl', ['-n', name], {
        timeout: SYSCTL_TIMEOUT_MS,
        encoding: 'utf8',
      })
    ).stdout,
  now: () => Date.now(),
  uptimeSeconds: () => uptime(),
};

/** What a kernel boot id looks like on Linux and macOS. */
const KERNEL_BOOT_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const DERIVED_PREFIX = 'boot-time:';

/**
 * How far two derived ids may differ and still name one boot. `now - uptime`
 * is not exact (both are sampled, and NTP slews the wall clock while uptime
 * keeps counting), so equality would make the same boot look like another.
 */
const DERIVED_TOLERANCE_SECONDS = 120;

export async function readMachineBootId(
  platform: NodeJS.Platform,
  sources: Partial<BootIdSources> = {},
): Promise<string> {
  const from: BootIdSources = { ...DEFAULT_SOURCES, ...sources };
  try {
    let candidate: string | null = null;
    if (platform === 'linux' || platform === 'android') {
      candidate = await from.readFile('/proc/sys/kernel/random/boot_id');
    } else if (platform === 'darwin') {
      candidate = await from.sysctl('kern.bootsessionuuid');
    }
    const id = candidate?.trim().toLowerCase();
    if (id !== undefined && KERNEL_BOOT_ID.test(id)) return id;
  } catch {
    // A sandbox without /proc or sysctl still has a clock and an uptime.
  }
  return derivedBootId(from.now(), from.uptimeSeconds());
}

/** The boot time in whole epoch seconds, tagged so it never equals a kernel id. */
export function derivedBootId(nowMs: number, uptimeSeconds: number): string {
  return `${DERIVED_PREFIX}${String(Math.round(nowMs / 1000 - uptimeSeconds))}`;
}

/** Whether two boot ids name the same boot of the same kernel. */
export function sameMachineBoot(a: string, b: string): boolean {
  if (a === b) return true;
  const first = derivedSeconds(a);
  const second = derivedSeconds(b);
  return first !== null && second !== null && Math.abs(first - second) <= DERIVED_TOLERANCE_SECONDS;
}

function derivedSeconds(id: string): number | null {
  if (!id.startsWith(DERIVED_PREFIX)) return null;
  const rest = id.slice(DERIVED_PREFIX.length);
  return /^-?\d+$/.test(rest) ? Number(rest) : null;
}
