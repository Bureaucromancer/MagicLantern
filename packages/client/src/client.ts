// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The typed client for the daemon's HTTP API. Runs in browsers and Node: no
 * `document`, an injectable `fetch`, and request/response types taken from the
 * schema package's route contracts rather than written by hand.
 *
 * Responses are not validated strictly, so a newer daemon may add fields.
 */

import {
  GetHealthRoute,
  GetInfoRoute,
  GetSessionRoute,
  ListLibrariesRoute,
  LoginRoute,
  LogoutRoute,
  type HealthResponse,
  type InfoResponse,
  type LibraryListResponse,
  type LoginBody,
  type RouteMethod,
  type SessionResponse,
} from '@bureaucromancer/lantern-schema';

import { INVALID_RESPONSE_CODE, LanternApiError, refusalFrom } from './errors.js';

export interface LanternClientOptions {
  /**
   * Where the daemon is, e.g. `http://127.0.0.1:7600`, optionally with a path
   * prefix when it sits behind a reverse proxy. In a browser it may be omitted
   * or be a path (`/lantern`), and requests are relative to the page; elsewhere
   * it must be an http(s) URL, because a relative URL means nothing to Node's fetch.
   */
  baseUrl?: string;
  /** Defaults to the global `fetch`, looked up per request. */
  fetch?: typeof fetch;
  /**
   * Sent with every request, e.g. a credential header for a machine client.
   * `accept` and `content-type` are the client's own and are not overridden.
   */
  headers?: Record<string, string>;
}

/** Per-call options. */
export interface RequestOptions {
  /** Aborts the request, e.g. when TanStack Query cancels a query. */
  signal?: AbortSignal;
}

export interface LanternClient {
  /** `GET /healthz`. */
  health(options?: RequestOptions): Promise<HealthResponse>;
  /** `GET /api/v1/session`: the auth mode and whether this client is signed in. */
  session(options?: RequestOptions): Promise<SessionResponse>;
  /**
   * `POST /api/v1/session`. The daemon sets the session cookie, which a
   * browser keeps; rejects with `invalid-credentials` (401) or `auth-disabled` (409).
   */
  login(password: string, options?: RequestOptions): Promise<void>;
  /** `DELETE /api/v1/session`. */
  logout(options?: RequestOptions): Promise<void>;
  /** `GET /api/v1/info`. */
  info(options?: RequestOptions): Promise<InfoResponse>;
  /** `GET /api/v1/libraries`. */
  listLibraries(options?: RequestOptions): Promise<LibraryListResponse>;
}

/** True where relative URLs resolve against a page (a browser), false in Node. */
function hasDocumentLocation(): boolean {
  return 'location' in globalThis;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Trailing slashes trimmed, so `http://host:7600/` and `http://host:7600`
 * build the same URLs and a path prefix keeps its own segments. Checked here
 * rather than left to fetch, which would fail every request with a parse error
 * that does not name the option at fault.
 */
function normaliseBaseUrl(baseUrl: string | undefined): string {
  let trimmed = baseUrl ?? '';
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);

  if (isHttpUrl(trimmed)) return trimmed;
  if (trimmed !== '' && !trimmed.startsWith('/')) {
    throw new TypeError(
      `createLanternClient's baseUrl must be an http(s) URL or a path starting with /, not "${String(baseUrl)}".`,
    );
  }
  // Empty or a path: relative to the page, which only a browser has.
  if (!hasDocumentLocation()) {
    throw new TypeError(
      'createLanternClient needs an absolute baseUrl outside a browser, e.g. http://127.0.0.1:7600.',
    );
  }
  return trimmed;
}

export function createLanternClient(options: LanternClientOptions = {}): LanternClient {
  const baseUrl = normaliseBaseUrl(options.baseUrl);
  // Built once, so a malformed header name or value fails here rather than on
  // the first request.
  const extraHeaders = new Headers(options.headers);
  // Looked up per call and never stored as a method: a browser's fetch called
  // with the wrong `this` throws "Illegal invocation".
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  /**
   * Sends one request and answers the parsed JSON body, or undefined for an
   * empty one. Network failures and aborts propagate unchanged (TanStack Query
   * recognises an abort); every answer the daemon gave becomes a
   * LanternApiError when it is not a success.
   */
  async function send(
    method: RouteMethod,
    path: string,
    body: unknown,
    requestOptions: RequestOptions | undefined,
  ): Promise<{ status: number; payload: unknown }> {
    // A Headers object rather than a record, because names are case-insensitive:
    // a caller's `Accept` beside our `accept` would be sent as one merged value.
    // The two headers that describe the exchange are the client's to set.
    const headers = new Headers(extraHeaders);
    headers.set('accept', 'application/json');
    const init: RequestInit = {
      method,
      headers,
      // Browsers send the session cookie only to the page's own origin; the
      // daemon is reached same-origin (or through the dev proxy), never by CORS.
      credentials: 'same-origin',
    };
    if (body === undefined) {
      // Describes a body that is not there, which the daemon may refuse as non-JSON.
      headers.delete('content-type');
    } else {
      // Only with a body: the daemon refuses an empty body declared as JSON.
      headers.set('content-type', 'application/json');
      init.body = JSON.stringify(body);
    }
    if (requestOptions?.signal !== undefined) init.signal = requestOptions.signal;

    const response = await doFetch(`${baseUrl}${path}`, init);
    const text = response.status === 204 ? '' : await response.text();

    let payload: unknown;
    if (text.trim() !== '') {
      try {
        payload = JSON.parse(text);
      } catch {
        if (!response.ok) throw refusalFrom(response.status, undefined);
        throw new LanternApiError(
          response.status,
          INVALID_RESPONSE_CODE,
          `The Lantern daemon answered ${method} ${path} with a body that is not JSON.`,
        );
      }
    }

    if (!response.ok) throw refusalFrom(response.status, payload);
    return { status: response.status, payload };
  }

  /**
   * For routes whose success has a body. Every v1 success body is a JSON
   * object; anything else (empty, `null`, an array) is a protocol error here,
   * rather than a TypeError somewhere in the caller. Fields are not checked, so
   * a newer daemon may add some.
   */
  async function sendForBody(
    method: RouteMethod,
    path: string,
    requestOptions: RequestOptions | undefined,
  ): Promise<unknown> {
    const { status, payload } = await send(method, path, undefined, requestOptions);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new LanternApiError(
        status,
        INVALID_RESPONSE_CODE,
        payload === undefined
          ? `The Lantern daemon answered ${method} ${path} with an empty body.`
          : `The Lantern daemon answered ${method} ${path} with JSON that is not an object.`,
      );
    }
    return payload;
  }

  return {
    health: async (requestOptions) =>
      (await sendForBody(
        GetHealthRoute.method,
        GetHealthRoute.path,
        requestOptions,
      )) as HealthResponse,
    session: async (requestOptions) =>
      (await sendForBody(
        GetSessionRoute.method,
        GetSessionRoute.path,
        requestOptions,
      )) as SessionResponse,
    login: async (password, requestOptions) => {
      const body: LoginBody = { password };
      await send(LoginRoute.method, LoginRoute.path, body, requestOptions);
    },
    logout: async (requestOptions) => {
      await send(LogoutRoute.method, LogoutRoute.path, undefined, requestOptions);
    },
    info: async (requestOptions) =>
      (await sendForBody(GetInfoRoute.method, GetInfoRoute.path, requestOptions)) as InfoResponse,
    listLibraries: async (requestOptions) =>
      (await sendForBody(
        ListLibrariesRoute.method,
        ListLibrariesRoute.path,
        requestOptions,
      )) as LibraryListResponse,
  };
}
