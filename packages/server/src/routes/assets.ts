// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `/api/v1/libraries/{lib}/assets` (ST4, ST5): upload, query, bytes,
 * thumbnail, provenance, lineage, rating and delete.
 *
 * Bytes are served as stored, under their own media type, with `nosniff`
 * (set for every answer by the security guard) and a sandboxing CSP, so a
 * file can never run as a page of this origin. They are named by their hash,
 * so they are cached for good and revalidate by `ETag`.
 *
 * Records are mapped to the wire field by field: times become ISO 8601,
 * and nothing the store keeps for itself is spread into an answer.
 */

import {
  ASSET_PAGE_DEFAULT,
  ASSET_PAGE_MAX,
  DeleteAssetRoute,
  ErrorCodes,
  GetAssetRoute,
  GetLineageRoute,
  GetProvenanceRoute,
  GetThumbnailRoute,
  ListAssetsRoute,
  PatchAssetRoute,
  UploadAssetRoute,
  type AssetLineage,
  type AssetPage,
  type AssetProvenance,
  type AssetSummary,
  type ValidationIssue,
} from '@bureaucromancer/lantern-schema';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { sendError, sendInvalid } from '../http/errors.js';
import type { LanternApp } from '../http/types.js';
import {
  ImageRefusedError,
  THUMBNAIL_MEDIA_TYPE,
  type AssetBytes,
  type AssetFilter,
  type AssetRecord,
  type LineageRecord,
  type ProvenanceRecord,
} from '../store/index.js';
import { createValidator } from '../validation/ajv.js';
import { isReply, libraryFor } from './libraries.js';

const MEGABYTE = 1024 * 1024;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function toAssetSummary(asset: AssetRecord): AssetSummary {
  return {
    id: asset.id,
    media_type: asset.mediaType,
    bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
    frames: asset.frames,
    origin: asset.origin,
    bytes_state: asset.bytesState,
    retention: asset.retention,
    rating: asset.rating,
    pixel_hash: asset.pixelHash,
    pixel_hash_alg: asset.pixelHashAlg,
    created_at: iso(asset.createdAt),
    output_of:
      asset.outputOf === null
        ? null
        : {
            job_id: asset.outputOf.jobId,
            index: asset.outputOf.index,
            seed: asset.outputOf.seed,
            model_id: asset.outputOf.modelId,
          },
  };
}

export function toProvenance(record: ProvenanceRecord): AssetProvenance {
  const { asset, job } = record;
  return {
    asset: toAssetSummary(asset),
    derived_from:
      asset.derivedFrom === null
        ? null
        : { asset_id: asset.derivedFrom.assetId, operation: asset.derivedFrom.operation },
    job:
      job === null
        ? null
        : {
            id: job.record.id,
            parent_id: job.record.parentId,
            state: job.record.state,
            outcome: job.record.outcome,
            outcome_reason: job.record.outcomeReason,
            model_id: job.record.modelId,
            route_id: job.record.routeId,
            collection: job.record.collection,
            end_user: job.record.endUser,
            created_at: iso(job.record.createdAt),
            finished_at: job.record.finishedAt === null ? null : iso(job.record.finishedAt),
            route_snapshot: job.record.routeSnapshot,
            canonical: job.canonical,
            effective: job.effective,
            field_report: job.fieldReport,
            wire: job.wire,
            backend_response: job.backendResponse,
            inputs: job.inputs.map((input) => ({
              position: input.position,
              asset_id: input.assetId,
              role: input.role,
              weight: input.weight,
              region: input.region,
              crop: input.crop,
              source_library: input.sourceLibrary,
            })),
            outputs: job.outputs.map((output) => ({
              index: output.index,
              asset_id: output.assetId,
              seed: output.seed,
            })),
          },
  };
}

export function toLineage(record: LineageRecord): AssetLineage {
  return {
    asset: record.assetId,
    nodes: record.nodes.map(toAssetSummary),
    edges: record.edges.map((edge) => ({
      parent: edge.parent,
      child: edge.child,
      kind: edge.kind,
      job_id: edge.jobId,
      role: edge.role,
    })),
    truncated: record.truncated,
  };
}

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

/** The position after which the next page starts, opaque to clients. */
export function encodeCursor(position: { createdAt: number; id: string }): string {
  return Buffer.from(JSON.stringify([position.createdAt, position.id]), 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'number' &&
      Number.isFinite(value[0]) &&
      typeof value[1] === 'string' &&
      /^[0-9a-f]{64}$/.test(value[1])
    ) {
      return { createdAt: value[0], id: value[1] };
    }
  } catch {
    // Falls through to null: any malformed cursor is the same 422.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

/** Sends bytes under their media type, or the refusal for an asset with none. */
function sendBytes(
  request: FastifyRequest,
  reply: FastifyReply,
  found: AssetBytes,
  options: {
    readonly etag: (id: string) => string;
    readonly cache: string;
    readonly mediaType?: string;
  },
): FastifyReply {
  if (found.kind === 'missing') {
    return sendError(reply, 404, ErrorCodes.notFound, 'No such asset.');
  }
  if (found.kind === 'gone') {
    return sendError(
      reply,
      410,
      ErrorCodes.gone,
      "The asset's bytes were deleted; its record and provenance remain.",
    );
  }
  const etag = `"${options.etag(found.asset.id)}"`;
  void reply
    .header('etag', etag)
    .header('cache-control', options.cache)
    // An image is never a page: no scripts, no plugins, no same-origin access.
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('content-disposition', 'inline');
  const match = request.headers['if-none-match'];
  if (match?.split(',').some((tag) => tag.trim() === etag) === true) {
    return reply.code(304).send();
  }
  return reply
    .type(options.mediaType ?? found.asset.mediaType)
    .header('content-length', String(found.bytes.length))
    .send(found.bytes);
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/** What the multipart body held, or the issue that refuses it. */
async function readUpload(
  request: FastifyRequest,
  maxBytes: number,
): Promise<{ bytes: Buffer } | { issue: ValidationIssue }> {
  let bytes: Buffer | null = null;
  let issue: ValidationIssue | null = null;
  // Room for a stray field or a second file, so they are refused as 422
  // naming what was wrong rather than as a limit hit.
  const parts = request.parts({
    limits: { fileSize: maxBytes, files: 2, fields: 4, parts: 6, fieldNameSize: 100 },
  });
  for await (const part of parts) {
    if (part.type !== 'file') {
      issue ??= { path: `/${part.fieldname}`, message: 'is not a part this upload takes' };
      continue;
    }
    if (part.fieldname !== 'file' || bytes !== null) {
      issue ??= {
        path: `/${part.fieldname}`,
        message: bytes === null ? 'is not a part this upload takes' : 'is a second file; send one',
      };
      // Read and dropped: the parser waits for each file to be consumed.
      part.file.resume();
      continue;
    }
    bytes = await part.toBuffer();
  }
  if (issue !== null) return { issue };
  if (bytes === null) return { issue: { path: '/file', message: 'is required' } };
  return { bytes };
}

/** A multipart error with no status of its own is malformed input, not a fault of ours. */
function isUnstatusedParseError(error: unknown): boolean {
  return error instanceof Error && (error as { statusCode?: unknown }).statusCode === undefined;
}

export function registerAssetRoutes(
  app: LanternApp,
  options: { readonly maxUploadMb: number },
): void {
  const maxBytes = options.maxUploadMb * MEGABYTE;
  // The upload's body schema documents the multipart form for OpenAPI; the
  // body itself is a stream read by the handler, never a parsed object, so
  // only the params are validated.
  const validator = createValidator();

  app.route({
    method: UploadAssetRoute.method,
    url: UploadAssetRoute.url,
    schema: UploadAssetRoute.schema,
    config: { multipart: true },
    validatorCompiler: ({ schema, httpPart }) =>
      httpPart === 'body' ? () => true : validator.compile(schema),
    handler: async (request, reply) => {
      const library = libraryFor(request, reply, request.params.lib, { write: true });
      if (isReply(library)) return library;

      let upload: Awaited<ReturnType<typeof readUpload>>;
      try {
        upload = await readUpload(request, maxBytes);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === 'FST_REQ_FILE_TOO_LARGE') {
          return sendError(
            reply,
            413,
            ErrorCodes.payloadTooLarge,
            `The file is over the upload limit of ${String(options.maxUploadMb)} MB.`,
          );
        }
        if (isUnstatusedParseError(error)) {
          return sendError(
            reply,
            400,
            ErrorCodes.badRequest,
            'The body is not well-formed multipart/form-data.',
          );
        }
        throw error;
      }
      if ('issue' in upload) return sendInvalid(reply, [upload.issue], 'body');

      try {
        const { asset, created } = await library.ingestUpload(upload.bytes);
        return await reply.code(created ? 201 : 200).send(toAssetSummary(asset));
      } catch (error) {
        if (error instanceof ImageRefusedError) {
          return sendInvalid(reply, [{ path: '/file', message: error.message }], 'body');
        }
        throw error;
      }
    },
  });

  app.route({
    method: ListAssetsRoute.method,
    url: ListAssetsRoute.url,
    schema: ListAssetsRoute.schema,
    handler: async (request, reply) => {
      const library = libraryFor(request, reply, request.params.lib);
      if (isReply(library)) return library;
      const query = request.query;

      const issues: ValidationIssue[] = [];
      const limit = query.limit === undefined ? ASSET_PAGE_DEFAULT : Number(query.limit);
      if (limit < 1 || limit > ASSET_PAGE_MAX) {
        issues.push({
          path: '/limit',
          message: `must be from 1 to ${String(ASSET_PAGE_MAX)}`,
          suggested: Math.min(Math.max(limit, 1), ASSET_PAGE_MAX),
        });
      }
      const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      if (after === null)
        issues.push({ path: '/cursor', message: 'is not a cursor this daemon gave' });
      if (issues.length > 0) return sendInvalid(reply, issues, 'querystring');

      const filter: AssetFilter = {
        limit,
        ...(after === undefined || after === null ? {} : { after }),
        ...(query.q === undefined ? {} : { text: query.q }),
        ...(query.model === undefined ? {} : { modelId: query.model }),
        ...(query.route === undefined ? {} : { routeId: query.route }),
        ...(query.collection === undefined ? {} : { collection: query.collection }),
        ...(query.origin === undefined ? {} : { origin: query.origin }),
        ...(query.rating_min === undefined ? {} : { ratingMin: Number(query.rating_min) }),
        ...(query.created_after === undefined
          ? {}
          : { createdFrom: Date.parse(query.created_after) }),
        ...(query.created_before === undefined
          ? {}
          : { createdBefore: Date.parse(query.created_before) }),
      };
      const page = library.queryAssets(filter);
      const answer: AssetPage = {
        assets: page.assets.map(toAssetSummary),
        next_cursor: page.next === null ? null : encodeCursor(page.next),
      };
      return answer;
    },
  });

  app.route({
    method: GetAssetRoute.method,
    url: GetAssetRoute.url,
    schema: GetAssetRoute.schema,
    handler: async (request, reply) => {
      const library = libraryFor(request, reply, request.params.lib);
      if (isReply(library)) return library;
      return sendBytes(request, reply, await library.readAsset(request.params.asset), {
        etag: (id) => id,
        cache: 'private, max-age=31536000, immutable',
      });
    },
  });

  app.route({
    method: GetThumbnailRoute.method,
    url: GetThumbnailRoute.url,
    schema: GetThumbnailRoute.schema,
    handler: async (request, reply) => {
      const library = libraryFor(request, reply, request.params.lib);
      if (isReply(library)) return library;
      return sendBytes(request, reply, await library.readThumbnail(request.params.asset), {
        etag: (id) => `${id}.thumb`,
        // Remade, and so possibly re-encoded, when the cache is cleared.
        cache: 'private, max-age=86400',
        mediaType: THUMBNAIL_MEDIA_TYPE,
      });
    },
  });

  app.route({
    method: GetProvenanceRoute.method,
    url: GetProvenanceRoute.url,
    schema: GetProvenanceRoute.schema,
    handler: async (request, reply) => {
      const library = libraryFor(request, reply, request.params.lib);
      if (isReply(library)) return library;
      const record = library.provenance(request.params.asset);
      if (record === undefined) return sendError(reply, 404, ErrorCodes.notFound, 'No such asset.');
      return toProvenance(record);
    },
  });

  app.route({
    method: GetLineageRoute.method,
    url: GetLineageRoute.url,
    schema: GetLineageRoute.schema,
    handler: async (request, reply) => {
      const library = libraryFor(request, reply, request.params.lib);
      if (isReply(library)) return library;
      const record = library.lineage(request.params.asset);
      if (record === undefined) return sendError(reply, 404, ErrorCodes.notFound, 'No such asset.');
      return toLineage(record);
    },
  });

  app.route({
    method: PatchAssetRoute.method,
    url: PatchAssetRoute.url,
    schema: PatchAssetRoute.schema,
    handler: async (request, reply) => {
      const library = libraryFor(request, reply, request.params.lib, { write: true });
      if (isReply(library)) return library;
      const asset = library.rate(request.params.asset, request.body.rating);
      if (asset === undefined) return sendError(reply, 404, ErrorCodes.notFound, 'No such asset.');
      return toAssetSummary(asset);
    },
  });

  app.route({
    method: DeleteAssetRoute.method,
    url: DeleteAssetRoute.url,
    schema: DeleteAssetRoute.schema,
    handler: async (request, reply) => {
      const library = libraryFor(request, reply, request.params.lib, { write: true });
      if (isReply(library)) return library;
      const asset = await library.deleteAsset(request.params.asset);
      if (asset === undefined) return sendError(reply, 404, ErrorCodes.notFound, 'No such asset.');
      return await reply.code(204).send(null);
    },
  });
}
