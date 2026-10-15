// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * A fake `fetch` for the client tests: records each request and answers from a
 * queue, so a test states the daemon's answer and then reads what was sent.
 */

/** What the client sent, with the headers normalised to a Headers object. */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
  /** A multipart body, as the FormData the client built. */
  readonly form: FormData | undefined;
  readonly credentials: RequestCredentials | undefined;
  readonly signal: AbortSignal | undefined;
}

/** One queued answer: a response, a thrown error (a network failure), or a function of the request. */
export type FakeAnswer =
  Response | Error | ((request: RecordedRequest) => Response | Promise<Response>);

export interface FakeFetch {
  readonly fetch: typeof fetch;
  readonly requests: RecordedRequest[];
  /** The only request made; fails the test when there were none or several. */
  only(): RecordedRequest;
}

export function fakeFetch(...answers: FakeAnswer[]): FakeFetch {
  const requests: RecordedRequest[] = [];
  const queue = [...answers];

  const fake = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const form = init.body instanceof FormData ? init.body : undefined;
    if (
      form === undefined &&
      typeof init.body !== 'string' &&
      init.body !== undefined &&
      init.body !== null
    ) {
      throw new Error('The client sent a body that is neither a string nor a FormData.');
    }
    const request: RecordedRequest = {
      url: input instanceof Request ? input.url : String(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
      form,
      credentials: init.credentials,
      signal: init.signal ?? undefined,
    };
    requests.push(request);
    const answer = queue.shift();
    if (answer === undefined)
      throw new Error(`No answer queued for ${request.method} ${request.url}.`);
    if (answer instanceof Error) throw answer;
    return await (typeof answer === 'function' ? answer(request) : answer);
  };

  return {
    fetch: fake,
    requests,
    only: () => {
      if (requests.length !== 1) {
        throw new Error(`Expected exactly one request, got ${String(requests.length)}.`);
      }
      return requests[0]!;
    },
  };
}

/** A JSON answer, as the daemon sends it. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** An answer with no body (204, or an empty error). */
export function empty(status: number): Response {
  return new Response(null, { status });
}

/** A body that is not JSON, e.g. a proxy's error page. */
export function text(status: number, body: string, contentType = 'text/html'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}
