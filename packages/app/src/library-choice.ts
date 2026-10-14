// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The rules behind the app's redirects, as pure functions: whether `/` must go
 * to sign-in, and which library it opens. The router calls these; tests drive
 * them without a router or a daemon.
 */

import type { LibrarySummary, SessionResponse } from '@bureaucromancer/lantern-client';
import { LIBRARY_ID_PATTERN } from '@bureaucromancer/lantern-schema';

const LIBRARY_ID = new RegExp(LIBRARY_ID_PATTERN);

/** Whether a string is shaped like a library id; anything else is not found without asking. */
export function isLibraryId(value: string): boolean {
  return LIBRARY_ID.test(value);
}

/** Password mode without a session: every other API call would answer 401. */
export function needsSignIn(session: SessionResponse): boolean {
  return session.mode === 'password' && !session.authenticated;
}

export function findLibrary(
  libraries: readonly LibrarySummary[],
  id: string,
): LibrarySummary | undefined {
  return libraries.find((library) => library.id === id);
}

/**
 * The library `/` opens, or undefined when none can be opened.
 *
 * The one last used in this browser wins while the daemon still lists it and
 * can open it (A22: each tab keeps its own library in the URL, and this is only
 * where a fresh tab starts). Otherwise the first library that opens, preferring
 * a writable one: a read-only library is a worse place to land when there is a
 * choice, but still better than nowhere.
 */
export function pickLibrary(
  libraries: readonly LibrarySummary[],
  lastUsed: string | null,
): LibrarySummary | undefined {
  if (lastUsed !== null) {
    const remembered = findLibrary(libraries, lastUsed);
    if (remembered !== undefined && remembered.status !== 'unavailable') return remembered;
  }
  return (
    libraries.find((library) => library.status === 'ok') ??
    libraries.find((library) => library.status === 'read-only')
  );
}
