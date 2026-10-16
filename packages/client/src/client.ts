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
  CancelJobRoute,
  CreateBackendRoute,
  CreateLibraryRoute,
  DetectBackendsRoute,
  GetModelRoute,
  ListBackendKindsRoute,
  ListBackendsRoute,
  ListModelsRoute,
  ListProfilesRoute,
  PatchModelRoute,
  RefreshBackendRoute,
  type BackendKindListResponse,
  type BackendListResponse,
  type BackendSummary,
  type CreateBackendBody,
  type DetectBody,
  type DetectResponse,
  type ModelDetail,
  type ModelListResponse,
  type ModelPatchBody,
  type ProfileListResponse,
  DeleteAssetRoute,
  EventsRoute,
  GetJobRoute,
  GetQueueRoute,
  ListJobsRoute,
  ReproduceJobRoute,
  RerollJobRoute,
  SubmitJobRoute,
  type JobDetail,
  type JobPage,
  type JobSummary,
  type QueueResponse,
  type SubmitBody,
  type SubmitResponse,
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
import { createEventParser, type LanternStreamEvent } from './events.js';

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
  /**
   * `POST /api/v1/libraries/{lib}/jobs`. Resolves to the queued job (or, for
   * an idempotency key already used with this body, that job, `replayed`).
   * Rejects with `invalid` (422) or `conflict` (409).
   */
  submitJob(lib: string, body: SubmitBody, options?: SubmitOptions): Promise<SubmitResponse>;
  /** `GET …/jobs`: history, newest first. */
  listJobs(lib: string, options?: ListJobsOptions): Promise<JobPage>;
  /** `GET …/jobs/{id}`: one job with its payloads and outputs. */
  getJob(lib: string, job: string, options?: RequestOptions): Promise<JobDetail>;
  /** `POST …/jobs/{id}/cancel`: the job as it now is; the end arrives as an event. */
  cancelJob(lib: string, job: string, options?: RequestOptions): Promise<JobSummary>;
  /** `POST …/jobs/{id}/reproduce`. */
  reproduceJob(lib: string, job: string, options?: RequestOptions): Promise<SubmitResponse>;
  /** `POST …/jobs/{id}/reroll`. */
  rerollJob(lib: string, job: string, options?: RequestOptions): Promise<SubmitResponse>;
  /** `GET /api/v1/queue`: the live queue; `library`'s jobs in full, others collapsed. */
  queue(library?: string, options?: RequestOptions): Promise<QueueResponse>;
  /**
   * `GET /api/v1/events`: calls `onEvent` for each event until the stream
   * ends or `signal` aborts, and resolves with the last event id seen, to
   * pass as `lastEventId` when reconnecting. A `reset` event means refetch.
   */
  streamEvents(
    onEvent: (event: LanternStreamEvent) => void,
    options?: StreamOptions,
  ): Promise<string | null>;
  /** `GET /api/v1/backend-kinds`: the kinds, each with JSON Schema for its settings (A26). */
  backendKinds(options?: RequestOptions): Promise<BackendKindListResponse>;
  /**
   * `POST /api/v1/backends/detect`: probes each kind's default addresses, or
   * `body.url` as every kind, and answers the proposal cards. Adds nothing.
   */
  detectBackends(body?: DetectBody, options?: RequestOptions): Promise<DetectResponse>;
  /** `GET /api/v1/backends`. */
  listBackends(options?: RequestOptions): Promise<BackendListResponse>;
  /**
   * `POST /api/v1/backends`: adds a backend with a proposal card's choices.
   * Rejects with `invalid` (422) or `conflict` (409, already registered).
   */
  createBackend(body: CreateBackendBody, options?: RequestOptions): Promise<BackendSummary>;
  /** `POST /api/v1/backends/{id}/refresh`: asks it again and re-reads its descriptors. */
  refreshBackend(id: string, options?: RequestOptions): Promise<BackendSummary>;
  /** `GET /api/v1/models`. */
  listModels(options?: RequestOptions): Promise<ModelListResponse>;
  /** `GET /api/v1/models/{id}`: with each route's effective descriptor, which the form renders. */
  getModel(id: string, options?: RequestOptions): Promise<ModelDetail>;
  /** `PATCH /api/v1/models/{id}`: its display name or its profile. */
  updateModel(id: string, patch: ModelPatchBody, options?: RequestOptions): Promise<ModelDetail>;
  /** `GET /api/v1/profiles`: for the profile picker. */
  listProfiles(options?: RequestOptions): Promise<ProfileListResponse>;
}

export interface SubmitOptions extends RequestOptions {
  /** Sent as `Idempotency-Key`: a retry with the same key never makes a second job. */
  idempotencyKey?: string;
}

export interface ListJobsOptions extends RequestOptions {
  state?: 'live' | 'finished';
  limit?: number;
  cursor?: string;
}

export interface StreamOptions extends RequestOptions {
  /** Replays what came after this id (`Last-Event-ID`). */
  lastEventId?: string;
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
    callHeaders: Readonly<Record<string, string>> = {},
  ): Promise<{ status: number; payload: unknown }> {
    // A Headers object rather than a record, because names are case-insensitive:
    // a caller's `Accept` beside our `accept` would be sent as one merged value.
    // The two headers that describe the exchange are the client's to set.
    const headers = new Headers(extraHeaders);
    for (const [name, value] of Object.entries(callHeaders)) headers.set(name, value);
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
    callHeaders?: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    const { status, payload } = await send(method, path, body, requestOptions, callHeaders);
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
    submitJob: async (lib, body, submitOptions = {}) =>
      (await sendForBody(
        SubmitJobRoute.method,
        fillPath(SubmitJobRoute.path, { lib }),
        submitOptions,
        { json: body },
        submitOptions.idempotencyKey === undefined
          ? {}
          : { 'idempotency-key': submitOptions.idempotencyKey },
      )) as SubmitResponse,
    listJobs: async (lib, listOptions = {}) => {
      const params = new URLSearchParams();
      if (listOptions.state !== undefined) params.append('state', listOptions.state);
      if (listOptions.limit !== undefined) params.append('limit', String(listOptions.limit));
      if (listOptions.cursor !== undefined) params.append('cursor', listOptions.cursor);
      const query = params.toString();
      return (await sendForBody(
        ListJobsRoute.method,
        `${fillPath(ListJobsRoute.path, { lib })}${query === '' ? '' : `?${query}`}`,
        listOptions,
      )) as JobPage;
    },
    getJob: async (lib, job, requestOptions) =>
      (await sendForBody(
        GetJobRoute.method,
        fillPath(GetJobRoute.path, { lib, job }),
        requestOptions,
      )) as JobDetail,
    cancelJob: async (lib, job, requestOptions) =>
      (await sendForBody(
        CancelJobRoute.method,
        fillPath(CancelJobRoute.path, { lib, job }),
        requestOptions,
      )) as JobSummary,
    reproduceJob: async (lib, job, requestOptions) =>
      (await sendForBody(
        ReproduceJobRoute.method,
        fillPath(ReproduceJobRoute.path, { lib, job }),
        requestOptions,
      )) as SubmitResponse,
    rerollJob: async (lib, job, requestOptions) =>
      (await sendForBody(
        RerollJobRoute.method,
        fillPath(RerollJobRoute.path, { lib, job }),
        requestOptions,
      )) as SubmitResponse,
    queue: async (library, requestOptions) =>
      (await sendForBody(
        GetQueueRoute.method,
        `${GetQueueRoute.path}${library === undefined ? '' : `?library=${encodeURIComponent(library)}`}`,
        requestOptions,
      )) as QueueResponse,
    backendKinds: async (requestOptions) =>
      (await sendForBody(
        ListBackendKindsRoute.method,
        ListBackendKindsRoute.path,
        requestOptions,
      )) as BackendKindListResponse,
    detectBackends: async (body = {}, requestOptions) =>
      (await sendForBody(DetectBackendsRoute.method, DetectBackendsRoute.path, requestOptions, {
        json: body,
      })) as DetectResponse,
    listBackends: async (requestOptions) =>
      (await sendForBody(
        ListBackendsRoute.method,
        ListBackendsRoute.path,
        requestOptions,
      )) as BackendListResponse,
    createBackend: async (body, requestOptions) =>
      (await sendForBody(CreateBackendRoute.method, CreateBackendRoute.path, requestOptions, {
        json: body,
      })) as BackendSummary,
    refreshBackend: async (id, requestOptions) =>
      (await sendForBody(
        RefreshBackendRoute.method,
        fillPath(RefreshBackendRoute.path, { id }),
        requestOptions,
      )) as BackendSummary,
    listModels: async (requestOptions) =>
      (await sendForBody(
        ListModelsRoute.method,
        ListModelsRoute.path,
        requestOptions,
      )) as ModelListResponse,
    getModel: async (id, requestOptions) =>
      (await sendForBody(
        GetModelRoute.method,
        fillPath(GetModelRoute.path, { id }),
        requestOptions,
      )) as ModelDetail,
    updateModel: async (id, patch, requestOptions) =>
      (await sendForBody(
        PatchModelRoute.method,
        fillPath(PatchModelRoute.path, { id }),
        requestOptions,
        { json: patch },
      )) as ModelDetail,
    listProfiles: async (requestOptions) =>
      (await sendForBody(
        ListProfilesRoute.method,
        ListProfilesRoute.path,
        requestOptions,
      )) as ProfileListResponse,
    streamEvents: async (onEvent, streamOptions = {}) => {
      const headers = new Headers(extraHeaders);
      headers.set('accept', 'text/event-stream');
      if (streamOptions.lastEventId !== undefined) {
        headers.set('last-event-id', streamOptions.lastEventId);
      }
      const init: RequestInit = { method: 'GET', headers, credentials: 'same-origin' };
      if (streamOptions.signal !== undefined) init.signal = streamOptions.signal;
      const response = await doFetch(`${baseUrl}${EventsRoute.path}`, init);
      if (!response.ok) {
        const text = await response.text();
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          payload = undefined;
        }
        throw refusalFrom(response.status, payload);
      }
      let lastId: string | null = streamOptions.lastEventId ?? null;
      const parse = createEventParser((event) => {
        if (event.id !== null) lastId = event.id;
        onEvent(event);
      });
      if (response.body === null) return lastId;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parse(decoder.decode(value, { stream: true }));
        }
      } catch (error) {
        // An abort ends the stream as the caller asked; anything else is theirs to see.
        if (!(streamOptions.signal?.aborted ?? false)) throw error;
      }
      return lastId;
    },
  };
}
