// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `/` when there is nowhere to send the visitor: every library failed to open
 * (or, in principle, there are none; the daemon creates one on first start).
 * Says why per library rather than an empty screen.
 */

import type { LibrarySummary } from '@bureaucromancer/lantern-client';
import type { JSX } from 'react';

import { Shell } from '../Shell.js';
import { pageColumn } from '../ui/classes.js';
import { Note, PageTitle } from '../ui/Text.js';

export function NoLibraryPage({
  libraries,
}: {
  libraries: readonly LibrarySummary[];
}): JSX.Element {
  return (
    <Shell>
      <div className={pageColumn}>
        <PageTitle className="mb-4">No library can be opened</PageTitle>
        {libraries.length === 0 ? (
          <Note>This Lantern has no libraries. Restarting the daemon creates one.</Note>
        ) : (
          <>
            <Note className="mb-4">
              Each library below failed to open. The daemon’s log has the details.
            </Note>
            <ul className="flex flex-col gap-2">
              {libraries.map((library) => (
                <li key={library.id} className="text-sm text-ink">
                  <span className="font-medium">{library.name}</span>
                  {library.reason === undefined ? null : (
                    <span className="text-ink-subtle">: {library.reason}</span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Shell>
  );
}
