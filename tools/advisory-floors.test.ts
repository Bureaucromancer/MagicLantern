// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Packages this repository deliberately holds above StoryEngine's pins, because
 * the versions below carry published advisories. Every other pin matches
 * StoryEngine's so the two repositories upgrade together, which makes "copy
 * StoryEngine's pin" the easy mistake this test exists to catch. It reads the
 * lockfile rather than package.json, so a second copy pulled in through some
 * other dependency's range counts too. Offline on purpose: `pnpm audit` needs
 * the network, and its verdict changes from one day to the next.
 *
 * Raise a floor when a newer advisory is triaged; drop an entry only when
 * StoryEngine's pin has passed it, and say why in the commit.
 */
const FLOORS: Record<string, { version: string; why: string }> = {
  fastify: {
    version: '5.12.5',
    why:
      'GHSA-p68q-wchp-6fh7, GHSA-hwr6-493r-vm6h, GHSA-667r-xxjv-c9mm and GHSA-9q9j-q6p8-xq58 ' +
      '(high, fixed in 5.12.2); GHSA-w2qp-rph6-63g4 and GHSA-3m5p-2c4r-xxw2 (fixed in 5.12.1); ' +
      'GHSA-4mh8-r7rc-xpvc (fixed in 5.12.5)',
  },
  vitest: { version: '4.1.11', why: 'GHSA-82fw-gwwq-j7x9, through @vitest/mocker' },
  '@vitest/mocker': { version: '4.1.11', why: 'GHSA-82fw-gwwq-j7x9 (path traversal)' },
};

const LOCKFILE = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');

/** Every version of `name` the lockfile resolves, from its `packages:` and `snapshots:` keys. */
function lockedVersions(name: string): string[] {
  const versions = new Set<string>();
  for (const line of LOCKFILE.split(/\r?\n/)) {
    const match = /^ {2}'?(@?[^@\s']+)@(\d+\.\d+\.\d+)/.exec(line);
    if (match?.[1] === name && match[2] !== undefined) versions.add(match[2]);
  }
  return [...versions];
}

function atLeast(version: string, floor: string): boolean {
  const a = version.split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

describe('the lockfile', () => {
  it.each(Object.entries(FLOORS))(
    'resolves %s only at or above its advisory floor',
    (name, floor) => {
      const versions = lockedVersions(name);

      // A package that disappears from the lockfile is a reason to revisit the table, not a pass.
      expect(versions.length, `${name} is in pnpm-lock.yaml`).toBeGreaterThan(0);
      for (const version of versions)
        expect(atLeast(version, floor.version), `${name}@${version}: ${floor.why}`).toBe(true);
    },
  );
});
