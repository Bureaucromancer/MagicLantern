// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The frame for everything under `/l/$lib`: the shell with this library in
 * the header, sign-out in password mode, and the daemon's version in the
 * footer. Opening a library here is what makes it the one a fresh tab starts
 * in (A22).
 */

import type { LibrarySummary } from '@bureaucromancer/lantern-client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, type JSX, type ReactNode } from 'react';

import { useLanternClient } from '../client-context.js';
import { rememberLibrary } from '../last-library.js';
import { findLibrary } from '../library-choice.js';
import { describeFailure, librariesQuery, request, sessionQuery } from '../queries.js';
import { DaemonVersion, Shell } from '../Shell.js';
import { Button } from '../ui/Button.js';
import { pageColumn } from '../ui/classes.js';
import { Note } from '../ui/Text.js';
import { LibraryNotFound } from './NotFoundPages.js';

/**
 * One library from the cached list. `undefined` while the list is loading or
 * once it no longer names this id; `loaded` tells the two apart.
 */
export function useLibrary(libraryId: string): {
  loaded: boolean;
  library: LibrarySummary | undefined;
} {
  const client = useLanternClient();
  const libraries = useQuery(librariesQuery(client));
  return {
    loaded: libraries.data !== undefined,
    library:
      libraries.data === undefined ? undefined : findLibrary(libraries.data.libraries, libraryId),
  };
}

export interface LibraryLayoutProps {
  libraryId: string;
  /** Called after the daemon has cleared the session. */
  onSignedOut: () => void | Promise<void>;
  children: ReactNode;
}

export function LibraryLayout({
  libraryId,
  onSignedOut,
  children,
}: LibraryLayoutProps): JSX.Element {
  const client = useLanternClient();
  const { loaded, library } = useLibrary(libraryId);
  const session = useQuery(sessionQuery(client));

  useEffect(() => {
    // An unavailable library is not remembered: a fresh tab should start
    // somewhere it can work.
    if (library !== undefined && library.status !== 'unavailable') rememberLibrary(library.id);
  }, [library]);

  if (!loaded) {
    // The route's loader fetched the list; it is missing only while the cache
    // is being reset (sign-out), a moment before this page goes away.
    return (
      <Shell>
        <div className={pageColumn}>
          <Note role="status">Loading…</Note>
        </div>
      </Shell>
    );
  }
  // Removed since the route loaded (a later refetch no longer lists it).
  if (library === undefined) return <LibraryNotFound libraryId={libraryId} />;

  return (
    <Shell
      library={library}
      actions={
        session.data?.mode === 'password' ? <SignOutButton onSignedOut={onSignedOut} /> : undefined
      }
      footer={<DaemonVersion />}
    >
      {children}
    </Shell>
  );
}

function SignOutButton({ onSignedOut }: { onSignedOut: () => void | Promise<void> }): JSX.Element {
  const client = useLanternClient();
  const signOut = useMutation({
    mutationFn: () => request(() => client.logout()),
    onSuccess: onSignedOut,
  });
  return (
    <div className="flex items-center gap-3">
      {signOut.error === null ? null : (
        <span role="alert" className="text-sm text-danger-ink">
          {describeFailure(signOut.error)}
        </span>
      )}
      <Button
        type="button"
        size="compact"
        disabled={signOut.isPending}
        onClick={() => {
          signOut.mutate();
        }}
      >
        Sign out
      </Button>
    </div>
  );
}
