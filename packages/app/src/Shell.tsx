// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The frame every routed page shares: a header with the app name (and the
 * library, inside one), the page, and a footer. Pages own their column inside
 * `main`; the frame only holds the regions.
 */

import type { LibraryStatus as Status, LibrarySummary } from '@bureaucromancer/lantern-client';
import { LibraryStatusBadge } from '@bureaucromancer/lantern-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { JSX, ReactNode } from 'react';

import { useLanternClient } from './client-context.js';
import { infoQuery } from './queries.js';
import { pageColumn } from './ui/classes.js';

export const APP_NAME = 'Magic Lantern';

export interface ShellProps {
  /** The library this page belongs to, named beside the app. */
  library?: LibrarySummary;
  /** Controls at the end of the header, e.g. sign-out. */
  actions?: ReactNode;
  /** The footer line; omitted, there is no footer. */
  footer?: ReactNode;
  children: ReactNode;
}

export function Shell({ library, actions, footer, children }: ShellProps): JSX.Element {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line bg-surface">
        <div className={`${pageColumn} flex flex-wrap items-center gap-x-3 gap-y-2 py-3`}>
          <Link
            to="/"
            className="rounded-control font-semibold text-ink focus-visible:outline-2 focus-visible:outline-focus"
          >
            {APP_NAME}
          </Link>
          {library === undefined ? null : (
            <div className="flex min-w-0 items-center gap-2">
              <span aria-hidden="true" className="text-ink-faint">
                /
              </span>
              <span className="truncate text-ink-muted">{library.name}</span>
              <LibraryStatusLabel status={library.status} />
            </div>
          )}
          {actions === undefined ? null : <div className="ms-auto">{actions}</div>}
        </div>
      </header>
      <main className="flex-1 py-8">{children}</main>
      {footer === undefined ? null : (
        <footer className="border-t border-line">
          <div className={`${pageColumn} py-3 text-xs text-ink-faint`}>{footer}</div>
        </footer>
      )}
    </div>
  );
}

const STATUS_TONE: Record<Status, string> = {
  ok: 'bg-badge-surface text-badge-ink',
  'read-only': 'bg-warn-surface text-warn-ink',
  unavailable: 'bg-danger-surface text-danger-ink',
};

/** lantern-react's badge is unstyled (`data-status` is its hook), so the app dresses it in tokens. */
function LibraryStatusLabel({ status }: { status: Status }): JSX.Element {
  return (
    <span className={`rounded-control px-2 py-0.5 text-xs font-medium ${STATUS_TONE[status]}`}>
      <LibraryStatusBadge status={status} />
    </span>
  );
}

/**
 * What is answering, from `GET /api/v1/info`. Only on signed-in pages: the
 * route needs a session in password mode.
 */
export function DaemonVersion(): JSX.Element {
  const client = useLanternClient();
  const info = useQuery(infoQuery(client));
  if (info.data === undefined) return <span>{APP_NAME}</span>;
  return <span>{`${APP_NAME} ${info.data.version} · API ${info.data.apiVersion}`}</span>;
}
