// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The last library opened in this browser, kept in localStorage as a mirror
 * only: it says where a fresh tab starts, and the daemon's list always decides
 * whether that library is still there. Storage can throw (private windows,
 * blocked site data), so every access is guarded and a failure means "no
 * memory", never a broken page.
 */

import { isLibraryId } from './library-choice.js';

export const LAST_LIBRARY_KEY = 'lantern.lastLibrary';

/** The part of `Storage` used here, so tests can pass a fake. */
export type LibraryMemoryStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Reading the `localStorage` property itself can throw a SecurityError. */
function browserStorage(): LibraryMemoryStorage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/** The remembered id, or null when there is none, storage is refused, or the value is junk. */
export function readLastLibrary(
  storage: LibraryMemoryStorage | null = browserStorage(),
): string | null {
  try {
    const stored = storage?.getItem(LAST_LIBRARY_KEY) ?? null;
    return stored !== null && isLibraryId(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function rememberLibrary(
  id: string,
  storage: LibraryMemoryStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(LAST_LIBRARY_KEY, id);
  } catch {
    // A browser that refuses storage just starts the next tab at the first library.
  }
}
