// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The shape of one route in the API contract: method, path and Fastify route
 * schema in one object, so the daemon registers exactly what the client calls
 * and the OpenAPI spec documents (rule 1).
 */

import { type TNull, type TSchema, Type } from '@sinclair/typebox';

/** Every v1 API route lives under this prefix; `/healthz` is the exception. */
export const API_V1_PREFIX = '/api/v1';

/** Methods Phase 1 uses. */
export type RouteMethod = 'GET' | 'POST' | 'DELETE';

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
  body?: TSchema;
  params?: TSchema;
  querystring?: TSchema;
  response?: Record<number, TSchema>;
}

export interface RouteContract<S extends RouteSchema = RouteSchema> {
  readonly method: RouteMethod;
  /** The full path the daemon serves and the client requests. */
  readonly path: string;
  /**
   * The path inside its Fastify mount: relative to {@link API_V1_PREFIX} for
   * API routes (registered in the prefixed plugin), equal to `path` otherwise.
   */
  readonly url: string;
  readonly schema: S;
}

/** A response with no body (204). @fastify/swagger documents `type: null` as no content. */
export function noContent(description: string): TNull {
  return Type.Null({ description });
}
