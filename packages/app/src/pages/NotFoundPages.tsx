// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Friendly dead ends. Neither framed one shows the daemon's version: the
 * visitor may not be signed in, and asking would only bounce them to sign-in
 * from a page that is merely saying "not here".
 */

import { Link } from '@tanstack/react-router';
import type { JSX, ReactNode } from 'react';

import { Shell } from '../Shell.js';
import { link, pageColumn } from '../ui/classes.js';
import { Note, PageTitle } from '../ui/Text.js';

export function LibraryNotFound({ libraryId }: { libraryId: string }): JSX.Element {
  return (
    <Shell>
      <div className={pageColumn}>
        <PageTitle className="mb-4">Library not found</PageTitle>
        <Note className="mb-4">
          This Lantern has no library with the id <code className="break-all">{libraryId}</code>. It
          may have been removed, or the link may come from another Lantern.
        </Note>
        <Link to="/" className={link}>
          Go to your library
        </Link>
      </div>
    </Shell>
  );
}

/** "Not here" without a frame; `children` is the way out. */
function PageNotFoundBody({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className={pageColumn}>
      <PageTitle className="mb-4">Page not found</PageTitle>
      <Note className="mb-4">Nothing lives at this address.</Note>
      {children}
    </div>
  );
}

export function PageNotFound(): JSX.Element {
  return (
    <Shell>
      <PageNotFoundBody>
        <Link to="/" className={link}>
          Go to your library
        </Link>
      </PageNotFoundBody>
    </Shell>
  );
}

/**
 * An unknown page under a library that exists. Unframed, because it renders
 * inside that library's frame, which already names the library.
 */
export function LibraryPageNotFound({ libraryId }: { libraryId: string }): JSX.Element {
  return (
    <PageNotFoundBody>
      <Link to="/l/$lib/generate" params={{ lib: libraryId }} className={link}>
        Go to this library
      </Link>
    </PageNotFoundBody>
  );
}
