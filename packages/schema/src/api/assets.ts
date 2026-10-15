// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `/api/v1/libraries/{lib}/assets`: the library's content-addressed images,
 * their provenance and lineage (plan, "Asset store" and "HTTP API").
 *
 * An asset's id is the SHA-256 of its bytes as stored and served, so it never
 * changes and its bytes can be cached for good. Deleting an asset removes its
 * bytes and keeps its record, provenance and pixel hash; the bytes then answer
 * 410 (A23).
 *
 * Provenance is stored JSON, upgraded by `schema_version` when read, so the
 * stored payloads are `Type.Unknown()` here: serialisation can't strip what
 * a newer daemon wrote (rule 5).
 */

import { type Static, Type } from '@sinclair/typebox';

import { AssetId } from '../request/generation-request.js';
import { errorResponse, ForbiddenHostOrOrigin } from './errors.js';
import { LibraryId, LibraryParams } from './libraries.js';
import { API_V1_PREFIX, binaryResponse, noContent, type RouteContract } from './route.js';

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const AssetOrigin = Type.Union(
  [
    Type.Literal('generated'),
    Type.Literal('uploaded'),
    Type.Literal('derived'),
    Type.Literal('imported'),
  ],
  {
    description:
      '`generated`: a job made it. `uploaded`: sent to this library. `derived`: made by Lantern from another asset, such as a crop (A7). `imported`: copied in from another library or tool.',
  },
);
export type AssetOrigin = Static<typeof AssetOrigin>;

export const BytesState = Type.Union(
  [Type.Literal('present'), Type.Literal('trashed'), Type.Literal('evicted')],
  {
    description:
      '`present`: the bytes are on disk. `trashed`: deleted by a person. `evicted`: a client copy removed to save space. Only `present` assets can be fetched.',
  },
);
export type BytesState = Static<typeof BytesState>;

export const Retention = Type.Union([Type.Literal('keep'), Type.Literal('client_copy')], {
  description:
    '`keep`: kept until deleted. `client_copy`: a copy made for a client, which may be evicted.',
});
export type Retention = Static<typeof Retention>;

/** What an asset may be stored as. */
export const ASSET_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
] as const;

export const RATING_MIN = 1;
export const RATING_MAX = 5;

export const Rating = Type.Integer({
  minimum: RATING_MIN,
  maximum: RATING_MAX,
  description: 'A rating from 1 to 5.',
});
export type Rating = Static<typeof Rating>;

const Timestamp = (description: string) => Type.String({ format: 'date-time', description });

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export const AssetOutputOf = Type.Object(
  {
    job_id: Type.String({ description: 'The job that made the asset.' }),
    index: Type.Integer({ minimum: 0, description: "The asset's place among the job's outputs." }),
    seed: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()], {
      description: 'The seed this output used (the base seed plus its index), when known.',
    }),
    model_id: Type.String({ description: 'The model the job ran on.' }),
  },
  { additionalProperties: false, description: 'Which job output this asset is.' },
);
export type AssetOutputOf = Static<typeof AssetOutputOf>;

export const AssetSummary = Type.Object(
  {
    id: AssetId,
    media_type: Type.String({ description: 'The MIME type of the bytes, e.g. `image/png`.' }),
    bytes: Type.Integer({ minimum: 0, description: 'The size of the file, in bytes.' }),
    width: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
      description: 'Width in pixels (of one frame).',
    }),
    height: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
      description: 'Height in pixels (of one frame).',
    }),
    frames: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
      description: 'Frames in an animation; null for a still image.',
    }),
    origin: AssetOrigin,
    bytes_state: BytesState,
    retention: Retention,
    rating: Type.Union([Rating, Type.Null()], { description: 'The rating; null when unrated.' }),
    pixel_hash: Type.Union([Type.String(), Type.Null()], {
      description:
        "A hash of the decoded pixels (A25): equal hashes are identical images whatever the metadata. Null where it isn't computed (images other than PNG).",
    }),
    pixel_hash_alg: Type.Union([Type.String(), Type.Null()], {
      description: 'How `pixel_hash` was computed; hashes compare only under the same algorithm.',
    }),
    created_at: Timestamp('When the asset entered this library.'),
    output_of: Type.Union([AssetOutputOf, Type.Null()], {
      description: 'The job output this asset is; null for an asset no job made.',
    }),
  },
  { additionalProperties: false, description: 'One asset.' },
);
export type AssetSummary = Static<typeof AssetSummary>;

export const AssetParams = Type.Object(
  { lib: LibraryId, asset: AssetId },
  { additionalProperties: false, description: 'The library and the asset.' },
);
export type AssetParams = Static<typeof AssetParams>;

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

const DIGITS = (description: string) => Type.String({ pattern: '^[0-9]{1,15}$', description });

export const ASSET_PAGE_DEFAULT = 50;
export const ASSET_PAGE_MAX = 200;

export const AssetQuery = Type.Object(
  {
    q: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 500,
        description:
          'Prompt search over the positive and negative prompts of the job that made each asset. Every word must appear; `long_hair` is one word.',
      }),
    ),
    model: Type.Optional(
      Type.String({ minLength: 1, maxLength: 128, description: 'Only outputs of this model.' }),
    ),
    route: Type.Optional(
      Type.String({ minLength: 1, maxLength: 128, description: 'Only outputs of this route.' }),
    ),
    collection: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description: "Only outputs of jobs in this client collection (a client's own grouping).",
      }),
    ),
    origin: Type.Optional(AssetOrigin),
    rating_min: Type.Optional(
      Type.String({
        pattern: '^[1-5]$',
        description: 'Only assets rated at least this (1 to 5).',
      }),
    ),
    created_after: Type.Optional(
      Timestamp('Only assets that entered the library at or after this time.'),
    ),
    created_before: Type.Optional(
      Timestamp('Only assets that entered the library before this time.'),
    ),
    limit: Type.Optional(
      DIGITS(
        `How many assets per page, 1 to ${String(ASSET_PAGE_MAX)}; ${String(ASSET_PAGE_DEFAULT)} when absent.`,
      ),
    ),
    cursor: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        pattern: '^[A-Za-z0-9_-]+$',
        description: 'The `next_cursor` of the previous page. Opaque.',
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      'Filters, all optional and combined with AND. Only assets whose bytes are present are listed.',
  },
);
export type AssetQuery = Static<typeof AssetQuery>;

export const AssetPage = Type.Object(
  {
    assets: Type.Array(AssetSummary, { description: 'Newest first.' }),
    next_cursor: Type.Union([Type.String(), Type.Null()], {
      description: 'Pass as `cursor` for the next page; null on the last one.',
    }),
  },
  { additionalProperties: false, description: 'One page of assets.' },
);
export type AssetPage = Static<typeof AssetPage>;

// ---------------------------------------------------------------------------
// Provenance and lineage
// ---------------------------------------------------------------------------

export const ProvenanceInput = Type.Object(
  {
    position: Type.Integer({ minimum: 0, description: "The input's place in the request." }),
    asset_id: AssetId,
    role: Type.String({ description: 'What the input was for (`init`, `mask`, `ref`…).' }),
    weight: Type.Union([Type.Number(), Type.Null()]),
    region: Type.Unknown({ description: 'Where in the output it applied; null when everywhere.' }),
    crop: Type.Unknown({ description: 'The part of the source used; null when all of it.' }),
    source_library: Type.Union([LibraryId, Type.Null()], {
      description: 'The library the input was copied from, when it came from another.',
    }),
  },
  { additionalProperties: false, description: 'One input of a job.' },
);
export type ProvenanceInput = Static<typeof ProvenanceInput>;

export const ProvenanceOutput = Type.Object(
  {
    index: Type.Integer({ minimum: 0 }),
    asset_id: AssetId,
    seed: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  { additionalProperties: false, description: 'One output of a job.' },
);
export type ProvenanceOutput = Static<typeof ProvenanceOutput>;

export const ProvenanceJob = Type.Object(
  {
    id: Type.String({ description: 'The job id.' }),
    parent_id: Type.Union([Type.String(), Type.Null()], {
      description: 'The job this one reran (Reproduce, Re-roll), if any.',
    }),
    state: Type.String({ description: 'The job state; `finished` for any job with outputs.' }),
    outcome: Type.Union([Type.String(), Type.Null()], {
      description: '`done`, `failed`, `refused` or `cancelled` once finished.',
    }),
    outcome_reason: Type.Union([Type.String(), Type.Null()]),
    model_id: Type.String(),
    route_id: Type.Union([Type.String(), Type.Null()]),
    collection: Type.Union([Type.String(), Type.Null()]),
    end_user: Type.Union([Type.String(), Type.Null()]),
    created_at: Timestamp('When the job was submitted.'),
    finished_at: Type.Union([Timestamp('When the job finished.'), Type.Null()]),
    route_snapshot: Type.Unknown({
      description:
        'What ran, as it was when it ran: model identity, backend kind and URL, generator version, profile and descriptor digests.',
    }),
    canonical: Type.Unknown({ description: 'The request as the user set it.' }),
    effective: Type.Unknown({
      description:
        'The request with every pixel-affecting value written out; submit it to reproduce.',
    }),
    field_report: Type.Unknown({ description: 'What became of each field.' }),
    wire: Type.Unknown({
      description: 'The exact body sent to the backend, with `$asset` placeholders.',
    }),
    backend_response: Type.Unknown({ description: "The backend's metadata, without image data." }),
    inputs: Type.Array(ProvenanceInput),
    outputs: Type.Array(ProvenanceOutput),
  },
  { additionalProperties: false, description: 'The job that made an asset, as stored.' },
);
export type ProvenanceJob = Static<typeof ProvenanceJob>;

export const AssetProvenance = Type.Object(
  {
    asset: AssetSummary,
    job: Type.Union([ProvenanceJob, Type.Null()], {
      description:
        'The job that made the asset (the first, if several made the same bytes); null for an asset no job made.',
    }),
    derived_from: Type.Union(
      [
        Type.Object(
          {
            asset_id: AssetId,
            operation: Type.Unknown({
              description: 'What was done, e.g. `{ "crop": SourceRect }`.',
            }),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ],
      { description: 'For a derived asset, its source and how it was derived.' },
    ),
  },
  { additionalProperties: false, description: 'Where an asset came from.' },
);
export type AssetProvenance = Static<typeof AssetProvenance>;

export const LineageEdge = Type.Object(
  {
    parent: AssetId,
    child: AssetId,
    kind: Type.Union([Type.Literal('job'), Type.Literal('derived')], {
      description:
        '`job`: the parent was an input of the job that made the child. `derived`: the child was cut from the parent.',
    }),
    job_id: Type.Union([Type.String(), Type.Null()]),
    role: Type.Union([Type.String(), Type.Null()], { description: "The parent's input role." }),
  },
  { additionalProperties: false, description: 'One parent-to-child link.' },
);
export type LineageEdge = Static<typeof LineageEdge>;

export const LINEAGE_MAX_NODES = 500;

export const AssetLineage = Type.Object(
  {
    asset: AssetId,
    nodes: Type.Array(AssetSummary, {
      description: 'The asset, its ancestors and its descendants.',
    }),
    edges: Type.Array(LineageEdge),
    truncated: Type.Boolean({
      description: `True when the family tree is larger than ${String(LINEAGE_MAX_NODES)} assets and only the nearest are listed.`,
    }),
  },
  { additionalProperties: false, description: "An asset's family tree." },
);
export type AssetLineage = Static<typeof AssetLineage>;

export const AssetPatchBody = Type.Object(
  {
    rating: Type.Union([Rating, Type.Null()], { description: 'The rating; null clears it.' }),
  },
  { additionalProperties: false, description: 'Changes to an asset.' },
);
export type AssetPatchBody = Static<typeof AssetPatchBody>;

export const UploadBody = Type.Object(
  {
    file: Type.String({
      contentEncoding: 'binary',
      contentMediaType: 'application/octet-stream',
      description: 'The image: PNG, JPEG, WebP, GIF or AVIF.',
    }),
  },
  { additionalProperties: false, description: 'One file, in the part named `file`.' },
);
export type UploadBody = Static<typeof UploadBody>;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const ASSETS = `${API_V1_PREFIX}/libraries/{lib}/assets`;
const ASSET = `${ASSETS}/{asset}`;

const unauthenticated = errorResponse('`unauthenticated`: password mode and no valid session.');
const libraryNotFound = errorResponse('`not-found`: no library has this id.');
const assetNotFound = errorResponse(
  '`not-found`: no library has this id, or it has no such asset.',
);
const libraryUnavailable = errorResponse(
  '`library-unavailable`: the library could not be opened; its `reason` in the library list says why.',
);
const libraryNotWritable = errorResponse(
  '`library-read-only`: the library was written by a newer Lantern and is open read-only. `library-unavailable`: the library could not be opened.',
);
const bytesGone = errorResponse(
  "`gone`: the asset's bytes were deleted; its record and provenance remain.",
);

export const UploadAssetRoute = {
  method: 'POST',
  path: ASSETS,
  url: '/libraries/:lib/assets',
  schema: {
    operationId: 'uploadAsset',
    summary: 'Upload an input image',
    description:
      'Stores one raster image (PNG, JPEG, WebP, GIF or AVIF) exactly as sent, with no metadata added, so its id is the SHA-256 of the file. The body is `multipart/form-data` with the file in a part named `file`; nothing else is accepted. Uploading bytes the library already holds answers that asset (200), and brings back bytes that were deleted.',
    tags: ['assets'],
    consumes: ['multipart/form-data'],
    params: LibraryParams,
    body: UploadBody,
    response: {
      200: Type.Object(AssetSummary.properties, {
        additionalProperties: false,
        description: 'The library already held these bytes; this is that asset.',
      }),
      201: Type.Object(AssetSummary.properties, {
        additionalProperties: false,
        description: 'Stored.',
      }),
      400: errorResponse('`bad-request`: the body is not well-formed multipart.'),
      401: unauthenticated,
      403: ForbiddenHostOrOrigin,
      404: libraryNotFound,
      409: libraryNotWritable,
      413: errorResponse('`payload-too-large`: the file is over `limits.maxUploadMb`.'),
      415: errorResponse('`unsupported-media-type`: the body is not `multipart/form-data`.'),
      422: errorResponse(
        '`invalid`: no part named `file`, a part other than it, or a file that is not an image Lantern takes, does not decode, or has too many pixels. The issue path is `/file`.',
      ),
    },
  },
} satisfies RouteContract;

export const ListAssetsRoute = {
  method: 'GET',
  path: ASSETS,
  url: '/libraries/:lib/assets',
  schema: {
    operationId: 'listAssets',
    summary: 'Query a library',
    description:
      'Assets newest first, filtered and paged by a cursor. Pages stay consistent while assets are added: a new asset never shifts one already seen onto the next page.',
    tags: ['assets'],
    params: LibraryParams,
    querystring: AssetQuery,
    response: {
      200: AssetPage,
      401: unauthenticated,
      403: ForbiddenHostOrOrigin,
      404: libraryNotFound,
      409: libraryUnavailable,
      422: errorResponse('`invalid`: a filter or the cursor is malformed.'),
    },
  },
} satisfies RouteContract;

export const GetAssetRoute = {
  method: 'GET',
  path: ASSET,
  url: '/libraries/:lib/assets/:asset',
  schema: {
    operationId: 'getAsset',
    summary: "An asset's bytes",
    description:
      'The file as stored, with its media type. The id is a hash of the bytes, so the answer may be cached for good (`ETag` is the id).',
    tags: ['assets'],
    params: AssetParams,
    response: {
      200: binaryResponse('The bytes, under their own media type.', ASSET_MEDIA_TYPES),
      304: noContent('Not modified: the `If-None-Match` names this asset.'),
      401: unauthenticated,
      403: ForbiddenHostOrOrigin,
      404: assetNotFound,
      409: libraryUnavailable,
      410: bytesGone,
      422: errorResponse('`invalid`: the library or asset id is malformed.'),
    },
  },
} satisfies RouteContract;

export const GetThumbnailRoute = {
  method: 'GET',
  path: `${ASSET}/thumb`,
  url: '/libraries/:lib/assets/:asset/thumb',
  schema: {
    operationId: 'getThumbnail',
    summary: "An asset's thumbnail",
    description:
      'A WebP no larger than 384 pixels on its longer side, made when the asset was stored and remade if the cache was cleared.',
    tags: ['assets'],
    params: AssetParams,
    response: {
      200: binaryResponse('The thumbnail.', ['image/webp']),
      304: noContent('Not modified: the `If-None-Match` names this thumbnail.'),
      401: unauthenticated,
      403: ForbiddenHostOrOrigin,
      404: assetNotFound,
      409: libraryUnavailable,
      410: bytesGone,
      422: errorResponse('`invalid`: the library or asset id is malformed.'),
    },
  },
} satisfies RouteContract;

export const GetProvenanceRoute = {
  method: 'GET',
  path: `${ASSET}/provenance`,
  url: '/libraries/:lib/assets/:asset/provenance',
  schema: {
    operationId: 'getProvenance',
    summary: 'Where an asset came from',
    description:
      'The asset and the job that made it, with every stored request and report. Answered for deleted assets too: provenance outlives the bytes.',
    tags: ['assets'],
    params: AssetParams,
    response: {
      200: AssetProvenance,
      401: unauthenticated,
      403: ForbiddenHostOrOrigin,
      404: assetNotFound,
      409: libraryUnavailable,
      422: errorResponse('`invalid`: the library or asset id is malformed.'),
    },
  },
} satisfies RouteContract;

export const GetLineageRoute = {
  method: 'GET',
  path: `${ASSET}/lineage`,
  url: '/libraries/:lib/assets/:asset/lineage',
  schema: {
    operationId: 'getLineage',
    summary: "An asset's family tree",
    description:
      'Its ancestors (the inputs of the job that made it, and theirs) and descendants (what was made from it), as nodes and parent-to-child edges.',
    tags: ['assets'],
    params: AssetParams,
    response: {
      200: AssetLineage,
      401: unauthenticated,
      403: ForbiddenHostOrOrigin,
      404: assetNotFound,
      409: libraryUnavailable,
      422: errorResponse('`invalid`: the library or asset id is malformed.'),
    },
  },
} satisfies RouteContract;

export const PatchAssetRoute = {
  method: 'PATCH',
  path: ASSET,
  url: '/libraries/:lib/assets/:asset',
  schema: {
    operationId: 'patchAsset',
    summary: 'Rate an asset',
    tags: ['assets'],
    params: AssetParams,
    body: AssetPatchBody,
    response: {
      200: Type.Object(AssetSummary.properties, {
        additionalProperties: false,
        description: 'The asset as changed.',
      }),
      400: errorResponse('`bad-request`: the body is empty or is not valid JSON.'),
      401: unauthenticated,
      403: ForbiddenHostOrOrigin,
      404: assetNotFound,
      409: libraryNotWritable,
      413: errorResponse("`payload-too-large`: the body is over the daemon's size limit."),
      415: errorResponse('`unsupported-media-type`: the body is not JSON.'),
      422: errorResponse('`invalid`: the body does not match the schema, or an id is malformed.'),
    },
  },
} satisfies RouteContract;

export const DeleteAssetRoute = {
  method: 'DELETE',
  path: ASSET,
  url: '/libraries/:lib/assets/:asset',
  schema: {
    operationId: 'deleteAsset',
    summary: "Delete an asset's bytes",
    description:
      'Removes the file and its thumbnail. The record, the job that made it, its provenance and its pixel hash stay, so the job can still be reproduced and its lineage still reads; the bytes then answer 410 (A23). Deleting an asset whose bytes are already gone succeeds.',
    tags: ['assets'],
    params: AssetParams,
    response: {
      204: noContent('Deleted.'),
      400: errorResponse('`bad-request`: a body was sent as JSON but is not valid JSON.'),
      401: unauthenticated,
      403: ForbiddenHostOrOrigin,
      404: assetNotFound,
      409: libraryNotWritable,
      413: errorResponse(
        "`payload-too-large`: a body was sent and is over the daemon's size limit.",
      ),
      415: errorResponse('`unsupported-media-type`: a body was sent and is not JSON.'),
      422: errorResponse('`invalid`: the library or asset id is malformed.'),
    },
  },
} satisfies RouteContract;
