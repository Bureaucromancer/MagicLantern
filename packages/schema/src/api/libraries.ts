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

/**
 * A library's display name: 1 to 100 characters, no control characters, and
 * no space at either end. Refused rather than trimmed, because validation
 * never rewrites a request (rule 5).
 */
export const LIBRARY_NAME_PATTERN = '^[^\\s\\p{Cc}](?:[^\\p{Cc}]*[^\\s\\p{Cc}])?$';

export const LibraryName = Type.String({
  minLength: 1,
  maxLength: 100,
  pattern: LIBRARY_NAME_PATTERN,
  description:
    'The display name: 1 to 100 characters, no control characters, no space at either end. Unique among libraries, ignoring case.',
});
export type LibraryName = Static<typeof LibraryName>;

export const LibraryUsage = Type.Object(
  {
    total_bytes: Type.Integer({ minimum: 0, description: 'Everything below, added up.' }),
    assets_bytes: Type.Integer({
      minimum: 0,
      description: 'Images and other assets whose bytes are present.',
    }),
    database_bytes: Type.Integer({
      minimum: 0,
      description: 'The library database and its write-ahead log.',
    }),
    cache_bytes: Type.Integer({
      minimum: 0,
      description: 'Thumbnails, which are rebuilt when missing.',
    }),
  },
  {
    additionalProperties: false,
    description:
      'Disk used by the library, in bytes. Snapshots taken before migrations are not counted.',
  },
);
export type LibraryUsage = Static<typeof LibraryUsage>;

export const LibrarySummary = Type.Object(
  {
    id: LibraryId,
    name: Type.String({ description: 'The display name.' }),
    status: LibraryStatus,
    reason: Type.Optional(
      Type.String({ description: 'Why the library is read-only or unavailable, in prose.' }),
    ),
    usage: Type.Optional(
      Type.Union([LibraryUsage, Type.Null()], {
        description:
          'Disk used, on the list; null when it could not be measured. Absent for an unavailable library and on create and rename.',
      }),
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

export const LibraryNameBody = Type.Object(
  { name: LibraryName },
  { additionalProperties: false, description: 'A library name.' },
);
export type LibraryNameBody = Static<typeof LibraryNameBody>;

/** `{lib}` in a library route's path. */
export const LibraryParams = Type.Object(
  { lib: LibraryId },
  { additionalProperties: false, description: 'The library.' },
);
export type LibraryParams = Static<typeof LibraryParams>;

export const ListLibrariesRoute = {
  method: 'GET',
  path: `${API_V1_PREFIX}/libraries`,
  url: '/libraries',
  schema: {
    operationId: 'listLibraries',
    summary: 'List libraries',
    description: 'Every registered library, oldest first, with the disk each one uses.',
    tags: ['libraries'],
    response: {
      200: LibraryListResponse,
      401: errorResponse('`unauthenticated`: password mode and no valid session.'),
      403: ForbiddenHostOrOrigin,
    },
  },
} satisfies RouteContract;

export const CreateLibraryRoute = {
  method: 'POST',
  path: `${API_V1_PREFIX}/libraries`,
  url: '/libraries',
  schema: {
    operationId: 'createLibrary',
    summary: 'Create a library',
    description:
      'Creates an empty library folder with its own database, and registers it. The library is usable at once.',
    tags: ['libraries'],
    body: LibraryNameBody,
    response: {
      201: LibrarySummary,
      400: errorResponse('`bad-request`: the body is empty or is not valid JSON.'),
      401: errorResponse('`unauthenticated`: password mode and no valid session.'),
      403: ForbiddenHostOrOrigin,
      409: errorResponse('`conflict`: another library already has this name (ignoring case).'),
      413: errorResponse("`payload-too-large`: the body is over the daemon's size limit."),
      415: errorResponse('`unsupported-media-type`: the body is not JSON.'),
      422: errorResponse('`invalid`: the body does not match the schema.'),
    },
  },
} satisfies RouteContract;

export const RenameLibraryRoute = {
  method: 'PATCH',
  path: `${API_V1_PREFIX}/libraries/{lib}`,
  url: '/libraries/:lib',
  schema: {
    operationId: 'renameLibrary',
    summary: 'Rename a library',
    description:
      "Changes the display name, in the registry and in the folder's `library.json`. A read-only or unavailable library is renamed in the registry only, since its folder is not this daemon's to write.",
    tags: ['libraries'],
    params: LibraryParams,
    body: LibraryNameBody,
    response: {
      200: LibrarySummary,
      400: errorResponse('`bad-request`: the body is empty or is not valid JSON.'),
      401: errorResponse('`unauthenticated`: password mode and no valid session.'),
      403: ForbiddenHostOrOrigin,
      404: errorResponse('`not-found`: no library has this id.'),
      409: errorResponse('`conflict`: another library already has this name (ignoring case).'),
      413: errorResponse("`payload-too-large`: the body is over the daemon's size limit."),
      415: errorResponse('`unsupported-media-type`: the body is not JSON.'),
      422: errorResponse(
        '`invalid`: the body does not match the schema, or the library id is malformed.',
      ),
    },
  },
} satisfies RouteContract;
