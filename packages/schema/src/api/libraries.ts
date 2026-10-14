// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `/api/v1/libraries`. A library is a self-contained folder (its own database
 * and assets) and stands in for user accounts; it is part of the app's URL
 * (`/l/<id>/generate`). Requires a session in password mode.
 */

import { type Static, Type } from '@sinclair/typebox';

import { errorResponse, ForbiddenHostOrOrigin } from './errors.js';
import { API_V1_PREFIX, type RouteContract } from './route.js';

/**
 * `lib_` plus a ULID (26 Crockford base32 characters). Checked before an id
 * reaches the disk, so it doubles as the path-traversal guard for library
 * folders.
 */
export const LIBRARY_ID_PATTERN = '^lib_[0-9A-HJKMNP-TV-Z]{26}$';

export const LibraryId = Type.String({
  pattern: LIBRARY_ID_PATTERN,
  description: 'A library id: `lib_` and a ULID.',
});
export type LibraryId = Static<typeof LibraryId>;

export const LibraryStatus = Type.Union(
  [Type.Literal('ok'), Type.Literal('read-only'), Type.Literal('unavailable')],
  {
    description:
      '`ok`: usable. `read-only`: written by a newer daemon that this one can still read. `unavailable`: cannot be opened (see `reason`).',
  },
);
export type LibraryStatus = Static<typeof LibraryStatus>;

export const LibrarySummary = Type.Object(
  {
    id: LibraryId,
    name: Type.String({ description: 'The display name.' }),
    status: LibraryStatus,
    reason: Type.Optional(
      Type.String({ description: 'Why the library is read-only or unavailable, in prose.' }),
    ),
  },
  { description: 'One library.' },
);
export type LibrarySummary = Static<typeof LibrarySummary>;

export const LibraryListResponse = Type.Object(
  { libraries: Type.Array(LibrarySummary, { description: 'Every registered library.' }) },
  { description: 'The libraries this install knows.' },
);
export type LibraryListResponse = Static<typeof LibraryListResponse>;

export const ListLibrariesRoute = {
  method: 'GET',
  path: `${API_V1_PREFIX}/libraries`,
  url: '/libraries',
  schema: {
    operationId: 'listLibraries',
    summary: 'List libraries',
    tags: ['libraries'],
    response: {
      200: LibraryListResponse,
      401: errorResponse('`unauthenticated`: password mode and no valid session.'),
      403: ForbiddenHostOrOrigin,
    },
  },
} satisfies RouteContract;
