// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `/l/$lib/generate`. A placeholder until the prototype builds the generate
 * panel (shaped by the chosen model's capabilities); it already says what
 * state the library is in, since that decides what the panel may do.
 */

import type { LibrarySummary } from '@bureaucromancer/lantern-client';
import { Link } from '@tanstack/react-router';
import { useId, type JSX } from 'react';

import { Alert } from '../ui/Alert.js';
import { link, pageColumn, panel } from '../ui/classes.js';
import { Note, PageTitle, SectionTitle } from '../ui/Text.js';

export function GeneratePage({ library }: { library: LibrarySummary }): JSX.Element {
  const headingId = useId();

  if (library.status === 'unavailable') {
    return (
      <div className={pageColumn}>
        <PageTitle className="mb-6">Generate</PageTitle>
        <Alert tone="error">
          <p className="font-medium">This library can’t be opened.</p>
          {library.reason === undefined ? null : <p className="mt-1">{library.reason}</p>}
          <p className="mt-2">
            <Link to="/" className={link}>
              Open another library
            </Link>
          </p>
        </Alert>
      </div>
    );
  }

  return (
    <div className={pageColumn}>
      <PageTitle className="mb-6">Generate</PageTitle>
      {library.status === 'read-only' ? (
        <Alert tone="warning" className="mb-6">
          <p className="font-medium">
            A newer Lantern has written to this library, so it opens read-only.
          </p>
          {library.reason === undefined ? null : <p className="mt-1">{library.reason}</p>}
        </Alert>
      ) : null}
      <section aria-labelledby={headingId} className={panel}>
        <SectionTitle id={headingId} className="mb-2">
          Generate — coming in the prototype
        </SectionTitle>
        <Note>
          This is where you will write a prompt and generate images into {library.name}, with a form
          shaped by what the chosen model can do.
        </Note>
      </section>
    </div>
  );
}
