// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The shape of one route in the API contract: method, path and Fastify route
 * schema in one object, so the daemon registers exactly what the client calls
 * and the OpenAPI spec documents (rule 1).
 */

import { type TNull, type TSchema, type TUnsafe, Type } from '@sinclair/typebox';

/** Every v1 API route lives under this prefix; `/healthz` is the exception. */
export const API_V1_PREFIX = '/api/v1';

/** The methods the API uses. */
export type RouteMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * A Fastify route schema plus the OpenAPI annotations @fastify/swagger reads.
 * Responses are keyed by status code and every one carries a `description`.
 */
export interface RouteSchema {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: readonly string[];
  /** Keeps the route out of the generated spec. */
  hide?: boolean;
  /**
   * Request media types other than JSON, for OpenAPI. A route that takes
   * `multipart/form-data` has no `body` schema: the upload is read as a
   * stream, not parsed into a body.
   */
  consumes?: readonly string[];
  body?: TSchema;
  params?: TSchema;
  querystring?: TSchema;
  response?: Record<number, TSchema>;
}

export interface RouteContract<S extends RouteSchema = RouteSchema> {
  readonly method: RouteMethod;
  /**
   * The full path the daemon serves and the client requests, with path
   * parameters in OpenAPI's form (`{lib}`; fill them with `fillPath`).
   */
  readonly path: string;
  /**
   * The path inside its Fastify mount: relative to {@link API_V1_PREFIX} for
   * API routes (registered in the prefixed plugin), equal to `path` otherwise.
   * Path parameters are in Fastify's form (`:lib`).
   */
  readonly url: string;
  readonly schema: S;
}

/** A response with no body (204). @fastify/swagger documents `type: null` as no content. */
export function noContent(description: string): TNull {
  return Type.Null({ description });
}

/**
 * A response whose body is bytes rather than JSON (an image), under each of
 * `mediaTypes`. Written as Fastify and @fastify/swagger both read a
 * per-media-type response (`content`), so only this status is documented as
 * an image and the error answers beside it stay JSON. Fastify never
 * serialises a Buffer, so the schema is documentation only.
 */
export function binaryResponse(
  description: string,
  mediaTypes: readonly string[],
): TUnsafe<Uint8Array> {
  const schema = { type: 'string', contentEncoding: 'binary', description };
  return Type.Unsafe<Uint8Array>({
    description,
    content: Object.fromEntries(mediaTypes.map((mediaType) => [mediaType, { schema }])),
  });
}
