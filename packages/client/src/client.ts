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
  CreateLibraryRoute,
  DeleteAssetRoute,
  fillPath,
  GetAssetRoute,
  GetHealthRoute,
  GetInfoRoute,
  GetLineageRoute,
  GetProvenanceRoute,
  GetSessionRoute,
  GetThumbnailRoute,
  ListAssetsRoute,
  ListLibrariesRoute,
  LoginRoute,
  LogoutRoute,
  PatchAssetRoute,
  RenameLibraryRoute,
  ResolveRoute,
  UploadAssetRoute,
  type AssetLineage,
  type AssetOrigin,
  type AssetPage,
  type AssetPatchBody,
  type AssetProvenance,
  type AssetSummary,
  type HealthResponse,
  type InfoResponse,
  type LibraryListResponse,
  type LibraryNameBody,
  type LibrarySummary,
  type LoginBody,
  type ResolveBody,
  type ResolveResponse,
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

/**
 * A library query (`GET /api/v1/libraries/{lib}/assets`), with numbers as
 * numbers; the client writes the query string.
 */
export interface ListAssetsOptions extends RequestOptions {
  /** Prompt search; every word must appear. */
  q?: string;
  model?: string;
  route?: string;
  collection?: string;
  origin?: AssetOrigin;
  /** 1 to 5. */
  ratingMin?: number;
  /** RFC 3339; inclusive. */
  createdAfter?: string;
  /** RFC 3339; exclusive. */
  createdBefore?: string;
  /** 1 to 200; 50 when absent. */
  limit?: number;
  /** The previous page's `next_cursor`. */
  cursor?: string;
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
  /**
   * `POST /api/v1/libraries/{lib}/resolve`: the dry run. Rejects with
   * `invalid` (422), whose issues point into the body (`/request/sampling/steps`)
   * and may carry a `suggested` value, or `not-found` (404) for an unknown library.
   */
  resolve(lib: string, body: ResolveBody, options?: RequestOptions): Promise<ResolveResponse>;
  /** `POST /api/v1/libraries`. Rejects with `conflict` (409) when the name is taken. */
  createLibrary(name: string, options?: RequestOptions): Promise<LibrarySummary>;
  /** `PATCH /api/v1/libraries/{lib}`. Rejects with `conflict` (409) or `not-found` (404). */
  renameLibrary(lib: string, name: string, options?: RequestOptions): Promise<LibrarySummary>;
  /**
   * `POST /api/v1/libraries/{lib}/assets`: uploads one image (a `File` or
   * `Blob`) as multipart/form-data. Resolves to the asset whether it is new or
   * the library already held the bytes. Rejects with `invalid` (422) for a
   * file that is not an image Lantern takes, `payload-too-large` (413), or
   * `library-read-only` (409).
   */
  uploadAsset(lib: string, file: Blob, options?: RequestOptions): Promise<AssetSummary>;
  /** `GET /api/v1/libraries/{lib}/assets`: one page, newest first. */
  listAssets(lib: string, options?: ListAssetsOptions): Promise<AssetPage>;
  /** `GET …/assets/{id}/provenance`. */
  assetProvenance(lib: string, asset: string, options?: RequestOptions): Promise<AssetProvenance>;
  /** `GET …/assets/{id}/lineage`. */
  assetLineage(lib: string, asset: string, options?: RequestOptions): Promise<AssetLineage>;
  /** `PATCH …/assets/{id}`: sets the rating (1 to 5) or clears it (null). */
  rateAsset(
    lib: string,
    asset: string,
    rating: number | null,
    options?: RequestOptions,
  ): Promise<AssetSummary>;
  /** `DELETE …/assets/{id}`: removes the bytes; the record and provenance stay. */
  deleteAsset(lib: string, asset: string, options?: RequestOptions): Promise<void>;
  /**
   * The URL of an asset's bytes, for an `<img src>`: no request is made. The
   * browser sends the session cookie itself, as for any same-origin image.
   */
  assetUrl(lib: string, asset: string): string;
  /** The URL of an asset's thumbnail, for an `<img src>`. */
  thumbnailUrl(lib: string, asset: string): string;
}

/** A request body: JSON, or a form the browser encodes as multipart with its own boundary. */
type Body = { readonly json: unknown } | { readonly form: FormData };

/** The query string for a library query, `?…` or empty, in a fixed order. */
export function assetQueryString(options: ListAssetsOptions): string {
  const params = new URLSearchParams();
  const add = (name: string, value: string | number | undefined): void => {
    if (value !== undefined) params.append(name, String(value));
  };
  add('q', options.q);
  add('model', options.model);
  add('route', options.route);
  add('collection', options.collection);
  add('origin', options.origin);
  add('rating_min', options.ratingMin);
  add('created_after', options.createdAfter);
  add('created_before', options.createdBefore);
  add('limit', options.limit);
  add('cursor', options.cursor);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
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
    body: Body | undefined,
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
    } else if ('form' in body) {
      // fetch writes multipart/form-data with the boundary itself.
      headers.delete('content-type');
      init.body = body.form;
    } else {
      // Only with a body: the daemon refuses an empty body declared as JSON.
      headers.set('content-type', 'application/json');
      init.body = JSON.stringify(body.json);
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
    body?: Body,
  ): Promise<unknown> {
    const { status, payload } = await send(method, path, body, requestOptions);
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
      await send(LoginRoute.method, LoginRoute.path, { json: body }, requestOptions);
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
    resolve: async (lib, body, requestOptions) =>
      (await sendForBody(
        ResolveRoute.method,
        fillPath(ResolveRoute.path, { lib }),
        requestOptions,
        { json: body },
      )) as ResolveResponse,
    createLibrary: async (name, requestOptions) => {
      const body: LibraryNameBody = { name };
      return (await sendForBody(
        CreateLibraryRoute.method,
        CreateLibraryRoute.path,
        requestOptions,
        {
          json: body,
        },
      )) as LibrarySummary;
    },
    renameLibrary: async (lib, name, requestOptions) => {
      const body: LibraryNameBody = { name };
      return (await sendForBody(
        RenameLibraryRoute.method,
        fillPath(RenameLibraryRoute.path, { lib }),
        requestOptions,
        { json: body },
      )) as LibrarySummary;
    },
    uploadAsset: async (lib, file, requestOptions) => {
      const form = new FormData();
      form.append('file', file);
      return (await sendForBody(
        UploadAssetRoute.method,
        fillPath(UploadAssetRoute.path, { lib }),
        requestOptions,
        { form },
      )) as AssetSummary;
    },
    listAssets: async (lib, listOptions = {}) => {
      const query = assetQueryString(listOptions);
      return (await sendForBody(
        ListAssetsRoute.method,
        `${fillPath(ListAssetsRoute.path, { lib })}${query}`,
        listOptions,
      )) as AssetPage;
    },
    assetProvenance: async (lib, asset, requestOptions) =>
      (await sendForBody(
        GetProvenanceRoute.method,
        fillPath(GetProvenanceRoute.path, { lib, asset }),
        requestOptions,
      )) as AssetProvenance,
    assetLineage: async (lib, asset, requestOptions) =>
      (await sendForBody(
        GetLineageRoute.method,
        fillPath(GetLineageRoute.path, { lib, asset }),
        requestOptions,
      )) as AssetLineage,
    rateAsset: async (lib, asset, rating, requestOptions) => {
      const body: AssetPatchBody = { rating };
      return (await sendForBody(
        PatchAssetRoute.method,
        fillPath(PatchAssetRoute.path, { lib, asset }),
        requestOptions,
        { json: body },
      )) as AssetSummary;
    },
    deleteAsset: async (lib, asset, requestOptions) => {
      await send(
        DeleteAssetRoute.method,
        fillPath(DeleteAssetRoute.path, { lib, asset }),
        undefined,
        requestOptions,
      );
    },
    assetUrl: (lib, asset) => `${baseUrl}${fillPath(GetAssetRoute.path, { lib, asset })}`,
    thumbnailUrl: (lib, asset) => `${baseUrl}${fillPath(GetThumbnailRoute.path, { lib, asset })}`,
  };
}
