// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `/api/v1/libraries`: list (with disk usage), create and rename
 * (`ListLibrariesRoute`, `CreateLibraryRoute`, `RenameLibraryRoute`).
 * Records are mapped to summaries field by field rather than spread, so the
 * folder path and schema version (daemon-side facts) never reach the wire.
 *
 * Also the lookup every library route shares: an unknown library is 404, one
 * that could not be opened is 409 `library-unavailable`, and a write to one a
 * newer Lantern wrote is 409 `library-read-only`.
 */

import {
  CreateLibraryRoute,
  ErrorCodes,
  ListLibrariesRoute,
  RenameLibraryRoute,
  type LibrarySummary,
  type LibraryUsage,
} from '@bureaucromancer/lantern-schema';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { sendError } from '../http/errors.js';
import type { LanternApp } from '../http/types.js';
import { LibraryNameTakenError, type Library, type LibraryRecord } from '../store/index.js';

export function toLibrarySummary(
  record: LibraryRecord,
  usage?: LibraryUsage | null,
): LibrarySummary {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * The library a request names, or the refusal already sent. `write` asks for
 * one this daemon may change.
 */
export function libraryFor(
  request: FastifyRequest,
  reply: FastifyReply,
  id: string,
  options: { readonly write?: boolean } = {},
): Library | FastifyReply {
  const { libraries } = request.server.services;
  const record = libraries.get(id);
  if (record === undefined) return sendError(reply, 404, ErrorCodes.notFound, 'No such library.');
  const library = libraries.library(id);
  if (library === undefined) {
    return sendError(
      reply,
      409,
      ErrorCodes.libraryUnavailable,
      `The library is unavailable. ${record.reason ?? 'It could not be opened.'}`,
    );
  }
  if (options.write === true && !library.writable) {
    return sendError(
      reply,
      409,
      ErrorCodes.libraryReadOnly,
      'The library was written by a newer Lantern and is open read-only.',
    );
  }
  return library;
}

/** Whether {@link libraryFor} answered with a refusal. */
export function isReply(value: Library | FastifyReply): value is FastifyReply {
  return 'send' in value && typeof value.send === 'function';
}

export function registerLibrariesRoutes(app: LanternApp): void {
  app.route({
    method: ListLibrariesRoute.method,
    url: ListLibrariesRoute.url,
    schema: ListLibrariesRoute.schema,
    // Services are read per request, never at registration (the OpenAPI
    // emitter registers routes with stub services).
    handler: async (request) => {
      const { libraries } = request.server.services;
      const summaries = await Promise.all(
        libraries.list().map(async (record) => {
          const library = libraries.library(record.id);
          if (library === undefined) return toLibrarySummary(record);
          try {
            return toLibrarySummary(record, await library.usage());
          } catch (error) {
            request.log.warn(
              { event: 'library.usage-failed', library: record.id, err: String(error) },
              'Could not measure the disk a library uses',
            );
            return toLibrarySummary(record, null);
          }
        }),
      );
      return { libraries: summaries };
    },
  });

  app.route({
    method: CreateLibraryRoute.method,
    url: CreateLibraryRoute.url,
    schema: CreateLibraryRoute.schema,
    handler: async (request, reply) => {
      try {
        const record = await request.server.services.libraries.create(request.body.name);
        return await reply.code(201).send(toLibrarySummary(record));
      } catch (error) {
        if (error instanceof LibraryNameTakenError) {
          return await sendError(reply, 409, ErrorCodes.conflict, error.message);
        }
        throw error;
      }
    },
  });

  app.route({
    method: RenameLibraryRoute.method,
    url: RenameLibraryRoute.url,
    schema: RenameLibraryRoute.schema,
    handler: async (request, reply) => {
      try {
        const record = await request.server.services.libraries.rename(
          request.params.lib,
          request.body.name,
        );
        if (record === undefined) {
          return await sendError(reply, 404, ErrorCodes.notFound, 'No such library.');
        }
        return toLibrarySummary(record);
      } catch (error) {
        if (error instanceof LibraryNameTakenError) {
          return await sendError(reply, 409, ErrorCodes.conflict, error.message);
        }
        throw error;
      }
    },
  });
}
