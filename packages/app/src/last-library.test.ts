// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { describe, expect, it } from 'vitest';

import {
  LAST_LIBRARY_KEY,
  readLastLibrary,
  rememberLibrary,
  type LibraryMemoryStorage,
} from './last-library.js';

const A = 'lib_01JA0000000000000000000000';

/** An in-memory stand-in for localStorage. */
function memoryStorage(initial: Record<string, string> = {}): LibraryMemoryStorage & {
  entries: Map<string, string>;
} {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

/** What a private window or blocked site data looks like: every call throws. */
const refusingStorage: LibraryMemoryStorage = {
  getItem: () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('Quota exceeded.', 'QuotaExceededError');
  },
};

describe('the last library used in this browser', () => {
  it('reads back what was remembered', () => {
    const storage = memoryStorage();
    rememberLibrary(A, storage);
    expect(storage.entries.get(LAST_LIBRARY_KEY)).toBe(A);
    expect(readLastLibrary(storage)).toBe(A);
  });

  it('is nothing when nothing was remembered', () => {
    expect(readLastLibrary(memoryStorage())).toBeNull();
  });

  it('ignores a value that is not a library id, rather than trusting the mirror', () => {
    expect(readLastLibrary(memoryStorage({ [LAST_LIBRARY_KEY]: 'not-a-library' }))).toBeNull();
  });

  it('is nothing, not a failure, when storage refuses to be read', () => {
    expect(readLastLibrary(refusingStorage)).toBeNull();
  });

  it('forgets quietly when storage refuses to be written', () => {
    expect(() => {
      rememberLibrary(A, refusingStorage);
    }).not.toThrow();
  });

  it('is nothing when there is no storage at all', () => {
    expect(readLastLibrary(null)).toBeNull();
    expect(() => {
      rememberLibrary(A, null);
    }).not.toThrow();
  });
});
