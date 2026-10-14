// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Every error answer in the shared envelope (lantern-schema `ErrorBody`):
 * validation → 422 `invalid` with `issues` (the path is an RFC 6901 JSON
 * pointer naming the field, including the rejected key for an
 * additionalProperties failure); a non-JSON body → 415
 * `unsupported-media-type`; an unknown API route → 404 `not-found` (sent by
 * the not-found handler in static.ts, which owns the SPA fallback); anything
 * else → 500 `internal` with a generic message, the cause logged as
 * type/message/code/stack only (never the whole error object).
 *
 * Two answers come from outside the error handler, because Fastify sends them
 * before any hook runs: the router's refusals (`frameworkErrors`, a malformed
 * percent-escape in the path) and a request Node could not read at all
 * (`clientErrorHandler`: an unparseable request, or one that took too long to
 * arrive). app.ts installs both; without them Fastify answers in its own shape.
 */

import { STATUS_CODES } from 'node:http';
import type { Socket } from 'node:net';

import {
  ErrorCodes,
  type ErrorBody,
  type ErrorCode,
  type ValidationIssue,
} from '@bureaucromancer/lantern-schema';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

import type { LanternApp } from './types.js';

/** Sends the envelope. The one way any module in this package answers an error. */
export function sendError(
  reply: FastifyReply,
  status: number,
  error: ErrorCode,
  message: string,
  issues?: readonly ValidationIssue[],
): FastifyReply {
  const body: ErrorBody =
    issues === undefined ? { error, message } : { error, message, issues: [...issues] };
  return reply.code(status).send(body);
}

/** The not-found answer, shared by the not-found handler. */
export function sendNotFound(reply: FastifyReply): FastifyReply {
  return sendError(reply, 404, ErrorCodes.notFound, 'No such route.');
}

/**
 * What to log about an unexpected error: never the object itself, because
 * pino copies every enumerable property (a request body, a prompt, a path).
 */
export function unhandledShape(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  const shape: Record<string, unknown> = { type: error.name, message: error.message };
  for (const key of ['code', 'errno', 'syscall']) {
    const value: unknown = (error as unknown as Record<string, unknown>)[key];
    if (typeof value === 'string' || typeof value === 'number') shape[key] = value;
  }
  if (error.stack !== undefined) shape['stack'] = error.stack;
  return shape;
}

interface AjvIssue {
  readonly keyword: string;
  readonly instancePath: string;
  readonly params: Record<string, unknown>;
  readonly message?: string;
}

/** One key as a JSON-pointer segment (RFC 6901): `~` first, or the `~1` for a slash would be escaped again. */
function pointerSegment(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * The JSON pointer (RFC 6901) to the field at fault; `''` is the whole body.
 * Ajv reports an additionalProperties (or required) failure at the parent
 * object and puts the raw key in `params`, so joining them, escaped like the
 * rest of Ajv's already-escaped `instancePath`, turns "this object is wrong"
 * into "this field is wrong".
 */
export function pathOfIssue(issue: Pick<AjvIssue, 'instancePath' | 'params'>): string {
  const field = issue.params['additionalProperty'] ?? issue.params['missingProperty'];
  if (typeof field === 'string') return `${issue.instancePath}/${pointerSegment(field)}`;
  return issue.instancePath;
}

function messageOfIssue(issue: AjvIssue): string {
  if (issue.keyword === 'additionalProperties') return 'is not a known field';
  if (issue.keyword === 'required') return 'is required';
  return issue.message ?? 'is invalid';
}

/** Fastify's shape for a thrown or framework error; `unknown` until checked. */
interface HttpError {
  readonly statusCode?: number;
  readonly code?: string;
  readonly message: string;
  /** http-errors' flag (what @fastify/static raises): true when the message is written for clients. */
  readonly expose?: boolean;
  readonly validation?: readonly AjvIssue[];
  readonly validationContext?: string;
}

function asHttpError(error: unknown): HttpError | null {
  return error instanceof Error ? error : null;
}

/** No 405: the router answers a known path under a method it does not serve with 404. */
const FOUR_XX_CODES: Readonly<Partial<Record<number, ErrorCode>>> = {
  403: ErrorCodes.forbidden,
  404: ErrorCodes.notFound,
  413: ErrorCodes.payloadTooLarge,
  415: ErrorCodes.unsupportedMediaType,
};

/** Human wording for the framework's own 4xx answers, whose messages are fine to show. */
const FOUR_XX_MESSAGES: Readonly<Partial<Record<number, string>>> = {
  415: 'The body must be application/json.',
};

/**
 * Whether an error's message was written for clients: Fastify's own errors
 * (`FST_ERR_*`: bad JSON, an empty JSON body, a body too large) and
 * http-errors marked `expose` (@fastify/static's 412 and 416). Anything else
 * carrying a 4xx status, such as a library error with a path in its message,
 * gets the status's generic wording instead.
 */
function messageIsForClients(error: HttpError): boolean {
  return error.code?.startsWith('FST_ERR_') === true || error.expose === true;
}

function genericMessage(status: number): string {
  return `${STATUS_CODES[status] ?? 'Bad Request'}.`;
}

/** What a validation issue reads as in the summary message; the root pointer is the whole part. */
function issueLabel(path: string, part: string): string {
  return path === '' ? `the whole ${part}` : path;
}

export function registerErrorHandling(app: LanternApp): void {
  app.setErrorHandler((rawError, request, reply) => {
    const error = asHttpError(rawError);

    if (error?.validation !== undefined) {
      const issues = error.validation.map((issue) => ({
        path: pathOfIssue(issue),
        message: messageOfIssue(issue),
      }));
      const part = error.validationContext ?? 'request';
      const summary = issues
        .map((issue) => `${issueLabel(issue.path, part)} ${issue.message}`)
        .join('; ');
      return sendError(
        reply,
        422,
        ErrorCodes.invalid,
        `The ${part} is not valid: ${summary}.`,
        issues,
      );
    }

    const status = error?.statusCode ?? 500;
    if (error !== null && status >= 400 && status < 500) {
      // `bad-request` stands for every 4xx without a code of its own (the
      // schema's "and other 4xx it raises"), e.g. a static file's 412 or 416.
      const code = FOUR_XX_CODES[status] ?? ErrorCodes.badRequest;
      const message =
        FOUR_XX_MESSAGES[status] ??
        (messageIsForClients(error) ? error.message : genericMessage(status));
      return sendError(reply, status, code, message);
    }

    request.log.error({ event: 'request.failed', ...unhandledShape(rawError) }, 'Unhandled error');
    return sendError(reply, 500, ErrorCodes.internal, 'Internal error');
  });
}

/**
 * Fastify's `frameworkErrors`, after the security guard: the router refused
 * the request before routing, so no hook or handler ran. A malformed
 * percent-escape (`/%ZZ`) is `FST_ERR_BAD_URL`; the path is not echoed back.
 */
export function answerFrameworkError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const status = error.statusCode ?? 500;
  if (status >= 400 && status < 500) {
    request.log.info(
      { event: 'request.bad-url', code: error.code },
      'Refused a request whose URL the router could not read',
    );
    const message =
      error.code === 'FST_ERR_MAX_PARAM_LENGTH'
        ? 'A part of the request URL is too long.'
        : 'The request URL is not valid.';
    return sendError(reply, status, ErrorCodes.badRequest, message);
  }
  request.log.error({ event: 'request.failed', ...unhandledShape(error) }, 'Unhandled error');
  return sendError(reply, 500, ErrorCodes.internal, 'Internal error');
}

/** Node's error for a request that did not arrive in time (`requestTimeout`, `headersTimeout`). */
const REQUEST_TIMEOUT_CODE = 'ERR_HTTP_REQUEST_TIMEOUT';

/** A raw HTTP/1.1 answer in the envelope, with the headers every answer carries, closing the connection. */
export function rawErrorResponse(status: number, error: ErrorCode, message: string): string {
  const body: ErrorBody = { error, message };
  const json = JSON.stringify(body);
  return [
    `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? 'Error'}`,
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(json))}`,
    'X-Content-Type-Options: nosniff',
    'X-Frame-Options: DENY',
    'Cache-Control: no-store',
    'Connection: close',
    '',
    json,
  ].join('\r\n');
}

/**
 * Fastify's `clientErrorHandler`: Node could not read a request (a malformed
 * request line or headers, headers too large) or it took too long to arrive.
 * There is no request to check, so this answers with a fixed envelope and
 * closes the connection. As Node's own handler does, it writes nothing when
 * the socket is gone or an answer has already started on it.
 */
export function answerClientError(error: Error & { code?: string }, socket: Socket): void {
  if (error.code === 'ECONNRESET' || socket.destroyed) return;
  const inFlight = (socket as Socket & { _httpMessage?: { headersSent?: boolean } | null })
    ._httpMessage;
  if (socket.writable && inFlight?.headersSent !== true) {
    socket.write(
      error.code === REQUEST_TIMEOUT_CODE
        ? rawErrorResponse(408, ErrorCodes.badRequest, 'The request took too long to arrive.')
        : error.code === 'HPE_HEADER_OVERFLOW'
          ? rawErrorResponse(431, ErrorCodes.badRequest, 'The request headers are too large.')
          : rawErrorResponse(400, ErrorCodes.badRequest, 'The request could not be read.'),
    );
  }
  socket.destroy(error);
}
