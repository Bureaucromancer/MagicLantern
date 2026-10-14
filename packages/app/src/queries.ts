// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Server state, through TanStack Query: the query client's defaults, the
 * queries the shell makes, and how a failure reads to a person. Every request
 * goes through lantern-client (rule 1); nothing here builds a URL.
 */

import {
  ErrorCodes,
  LanternApiError,
  UNKNOWN_ERROR_CODE,
  type LanternClient,
} from '@bureaucromancer/lantern-client';
import { MutationCache, QueryCache, QueryClient, queryOptions } from '@tanstack/react-query';

/**
 * A request the daemon never answered: it is down or unreachable. Named,
 * because fetch reports it as a bare TypeError, which is indistinguishable
 * from a bug once it has left the call; and because a proxy in front of a
 * daemon that is down answers in the daemon's place (see `request`).
 */
export class DaemonUnreachableError extends Error {
  constructor(cause: unknown) {
    super('The Lantern daemon could not be reached.', { cause });
    this.name = 'DaemonUnreachableError';
  }
}

function isAbort(failure: unknown): boolean {
  return failure instanceof DOMException && failure.name === 'AbortError';
}

/** What a gateway answers when nothing is listening behind it, or nothing answers in time. */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * Whether an answer came from a proxy standing in for a daemon it could not
 * reach: Vite's dev proxy answers 502 with an empty body while the daemon is
 * stopped or restarting, and nginx or Caddy do the same. Every refusal of the
 * daemon's own, 5xx included, carries an envelope and so a code; only an
 * answer without one can be the proxy's.
 */
function isGatewayStandIn(failure: LanternApiError): boolean {
  return failure.code === UNKNOWN_ERROR_CODE && GATEWAY_STATUSES.has(failure.status);
}

/**
 * Runs one lantern-client call. The client throws LanternApiError for every
 * answer it got and lets transport failures through, so anything else (bar a
 * cancellation, which TanStack Query must see as itself) is "unreachable", as
 * is a proxy's answer for a daemon behind it that is down.
 */
export async function request<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (failure) {
    if (isAbort(failure)) throw failure;
    if (failure instanceof LanternApiError && !isGatewayStandIn(failure)) throw failure;
    throw new DaemonUnreachableError(failure);
  }
}

export const queryKeys = {
  session: ['session'],
  libraries: ['libraries'],
  info: ['info'],
} as const;

/**
 * Long enough that a page mounting just after its route fetched the same data
 * does not ask again. The routes that decide something from it (`/`, `/login`)
 * fetch afresh regardless.
 */
const ROUTE_DATA_STALE_MS = 10_000;

export function sessionQuery(client: LanternClient) {
  return queryOptions({
    queryKey: queryKeys.session,
    queryFn: ({ signal }) => request(() => client.session({ signal })),
    staleTime: ROUTE_DATA_STALE_MS,
  });
}

export function librariesQuery(client: LanternClient) {
  return queryOptions({
    queryKey: queryKeys.libraries,
    queryFn: ({ signal }) => request(() => client.listLibraries({ signal })),
    staleTime: ROUTE_DATA_STALE_MS,
  });
}

export function infoQuery(client: LanternClient) {
  return queryOptions({
    queryKey: queryKeys.info,
    queryFn: ({ signal }) => request(() => client.info({ signal })),
    // What is answering changes only when the daemon restarts.
    staleTime: 5 * 60_000,
  });
}

/**
 * Whether a failure is the daemon saying this browser has no session. Only
 * `unauthenticated`: a wrong password is a 401 too (`invalid-credentials`) and
 * belongs to the sign-in form, not to a redirect.
 */
export function endsTheSession(failure: unknown): boolean {
  return (
    failure instanceof LanternApiError &&
    failure.status === 401 &&
    failure.code === ErrorCodes.unauthenticated
  );
}

/**
 * One retry for a failure that might not repeat (the network, a 5xx while the
 * daemon restarts); none for a refusal, which will.
 */
export function shouldRetry(failureCount: number, failure: unknown): boolean {
  if (failure instanceof LanternApiError && failure.status < 500) return false;
  return failureCount < 1;
}

export interface QueryClientOptions {
  /** Called when any query or mutation is refused as signed out. */
  onSessionEnded: () => void;
}

export function createQueryClient({ onSessionEnded }: QueryClientOptions): QueryClient {
  // On the caches rather than per hook: the claim is about every request, and
  // a hook that forgot would be the one page that failed in silence.
  const onError = (failure: unknown): void => {
    if (endsTheSession(failure)) onSessionEnded();
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      // `always`, not the default `online`: navigator.onLine describes the
      // internet, and a daemon on loopback or the LAN is reachable without it.
      // Under `online` a laptop with Wi-Fi off would wait forever, silently.
      queries: { networkMode: 'always', retry: shouldRetry },
      mutations: { networkMode: 'always' },
    },
  });
}

/** A failure as one sentence for a person. */
export function describeFailure(failure: unknown): string {
  if (failure instanceof DaemonUnreachableError) {
    return 'The Lantern daemon could not be reached. Check that it is running, then try again.';
  }
  if (failure instanceof LanternApiError) {
    if (failure.code === ErrorCodes.unavailable) {
      return 'The Lantern daemon is shutting down. Try again once it is back.';
    }
    // 5xx bodies are deliberately generic; the cause is only in the daemon's log.
    return failure.status >= 500
      ? 'The Lantern daemon hit an internal error. Its log has the details.'
      : failure.message;
  }
  return failure instanceof Error ? failure.message : String(failure);
}
