// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * HTTP for adapters and managers: `fetch` with a deadline, URLs that keep a
 * base URL's path (a proxy prefix, L1), and errors that carry the status and
 * the body's `error` text, so a refusal can be told from a network failure.
 */

/** The `fetch` an adapter uses; injectable so contract tests can replay fixtures. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** An answer outside 2xx, with what the backend said. */
export class HttpStatusError extends Error {
  readonly status: number;
  /** The parsed JSON body, or the text when it is not JSON. */
  readonly body: unknown;
  /** `Retry-After` in seconds, when the backend sent one. */
  readonly retryAfterS: number | undefined;

  constructor(url: string, status: number, body: unknown, retryAfterS?: number) {
    super(`${url} answered ${String(status)}${describeBody(body)}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.body = body;
    this.retryAfterS = retryAfterS;
  }
}

function describeBody(body: unknown): string {
  const text = errorText(body);
  return text === undefined ? '.' : `: ${text}`;
}

/** The `error` (and `message`) a JSON error body carries, or a short text body. */
export function errorText(body: unknown): string | undefined {
  if (typeof body === 'string') return body.length > 0 && body.length <= 200 ? body : undefined;
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const error = record['error'];
  const message = record['message'];
  const parts = [error, message].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return parts.length === 0 ? undefined : parts.join(': ');
}

/**
 * A URL under a base URL that may carry a path: `joinUrl('http://h/x/', '/a')`
 * is `http://h/x/a`, never `http://h/a` as `new URL('/a', base)` would make it.
 *
 * @param base the base URL, with or without a trailing slash
 * @param path an absolute path, starting with `/`
 */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/** `Retry-After` in seconds: delta seconds, or an HTTP date. */
export function retryAfterSeconds(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, (at - now) / 1000);
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST';
  /** Sent as JSON. */
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Milliseconds before the request is abandoned. */
  readonly timeoutMs: number;
  /** The caller's own abort, combined with the deadline. */
  readonly signal?: AbortSignal;
}

/** A response's body: parsed JSON when it says so (or looks like it), else its text. */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('json') || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

/** Socket errors a pooled keep-alive connection gives when the server went away under it. */
const STALE_SOCKET: ReadonlySet<string> = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']);

function staleSocket(error: unknown): boolean {
  let cause: unknown = error;
  for (let depth = 0; depth < 4 && cause instanceof Error; depth += 1) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== undefined && STALE_SOCKET.has(code)) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Sends a request and answers its status and body. Throws on a network
 * failure or the deadline (the cause is the `fetch` error), never for a status.
 *
 * A GET whose pooled connection the server had closed (it restarted) is sent
 * once more on a fresh one: it changes nothing, and the first attempt never
 * reached a live server.
 */
export async function request(
  fetchImpl: FetchLike,
  url: string,
  options: RequestOptions,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  try {
    return await requestOnce(fetchImpl, url, options);
  } catch (error) {
    if ((options.method ?? 'GET') !== 'GET' || !staleSocket(error)) throw error;
    return await requestOnce(fetchImpl, url, options);
  }
}

async function requestOnce(
  fetchImpl: FetchLike,
  url: string,
  options: RequestOptions,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal =
    options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  const init: RequestInit = { method: options.method ?? 'GET', headers, signal };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    const reason = deadline.aborted
      ? `timed out after ${String(options.timeoutMs)} ms`
      : error instanceof Error
        ? (causeMessage(error) ?? error.message)
        : String(error);
    throw new Error(`${url} did not answer: ${reason}.`, { cause: error });
  }
  return { status: response.status, body: await readBody(response), headers: response.headers };
}

function causeMessage(error: Error): string | undefined {
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code === undefined ? cause.message : `${code} (${cause.message})`;
  }
  return undefined;
}

/** {@link request}, throwing {@link HttpStatusError} for anything outside 2xx. */
export async function requestOk(
  fetchImpl: FetchLike,
  url: string,
  options: RequestOptions,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const answer = await request(fetchImpl, url, options);
  if (answer.status < 200 || answer.status > 299) {
    throw new HttpStatusError(
      url,
      answer.status,
      answer.body,
      retryAfterSeconds(answer.headers.get('retry-after')),
    );
  }
  return answer;
}
