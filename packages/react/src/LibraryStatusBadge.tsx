// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import type { LibraryStatus } from '@bureaucromancer/lantern-schema';

const LABELS: Record<LibraryStatus, string> = {
  ok: 'Available',
  'read-only': 'Read-only',
  unavailable: 'Unavailable',
};

export interface LibraryStatusBadgeProps {
  status: LibraryStatus;
}

/**
 * A library's status as a label. Props only, no data fetching: components here
 * render inside StoryEngine too, which feeds them through its own server (D4).
 * Unstyled until the shared tokens land; `data-status` is the styling hook.
 */
export function LibraryStatusBadge({ status }: LibraryStatusBadgeProps) {
  return <span data-status={status}>{LABELS[status]}</span>;
}
