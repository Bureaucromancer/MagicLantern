// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { LanternApiError, UNKNOWN_ERROR_CODE } from '@bureaucromancer/lantern-client';
import { describe, expect, it, vi } from 'vitest';

import {
  createQueryClient,
  DaemonUnreachableError,
  describeFailure,
  endsTheSession,
  request,
  shouldRetry,
} from './queries.js';

const unauthenticated = new LanternApiError(401, 'unauthenticated', 'Sign in first.');
const wrongPassword = new LanternApiError(401, 'invalid-credentials', 'Invalid credentials.');

describe('a session ending', () => {
  it('is a 401 unauthenticated', () => {
    expect(endsTheSession(unauthenticated)).toBe(true);
  });

  it('is not a wrong password, which is a 401 too', () => {
    expect(endsTheSession(wrongPassword)).toBe(false);
  });

  it('is not a network failure', () => {
    expect(endsTheSession(new DaemonUnreachableError(new TypeError('Failed to fetch')))).toBe(
      false,
    );
  });

  it('is reported once from any query, and not for other failures', async () => {
    const onSessionEnded = vi.fn();
    const queryClient = createQueryClient({ onSessionEnded });

    await expect(
      queryClient.fetchQuery({ queryKey: ['a'], queryFn: () => Promise.reject(wrongPassword) }),
    ).rejects.toBe(wrongPassword);
    expect(onSessionEnded).not.toHaveBeenCalled();

    await expect(
      queryClient.fetchQuery({ queryKey: ['b'], queryFn: () => Promise.reject(unauthenticated) }),
    ).rejects.toBe(unauthenticated);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('is reported from a mutation too', async () => {
    const onSessionEnded = vi.fn();
    const queryClient = createQueryClient({ onSessionEnded });
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: () => Promise.reject(unauthenticated),
    });

    await expect(mutation.execute(undefined)).rejects.toBe(unauthenticated);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });
});

describe('retrying', () => {
  it('does not retry a refusal, which would only repeat', () => {
    expect(shouldRetry(0, wrongPassword)).toBe(false);
    expect(shouldRetry(0, new LanternApiError(404, 'not-found', 'Not found.'))).toBe(false);
  });

  it('retries once what might pass: the network, or a daemon mid-restart', () => {
    const unreachable = new DaemonUnreachableError(new TypeError('Failed to fetch'));
    expect(shouldRetry(0, unreachable)).toBe(true);
    expect(shouldRetry(1, unreachable)).toBe(false);
    expect(shouldRetry(0, new LanternApiError(503, 'internal', 'Internal error'))).toBe(true);
  });

  it('works whatever navigator.onLine says (networkMode always)', () => {
    const queryClient = createQueryClient({ onSessionEnded: vi.fn() });
    expect(queryClient.getDefaultOptions().queries?.networkMode).toBe('always');
    expect(queryClient.getDefaultOptions().mutations?.networkMode).toBe('always');
  });
});

describe('a request through the client', () => {
  it('passes an answer through', async () => {
    await expect(request(() => Promise.resolve(7))).resolves.toBe(7);
  });

  it('keeps a refusal as the daemon gave it', async () => {
    await expect(request(() => Promise.reject(wrongPassword))).rejects.toBe(wrongPassword);
  });

  it('names a transport failure as the daemon being unreachable', async () => {
    const cause = new TypeError('Failed to fetch');
    const failure = await request(() => Promise.reject(cause)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DaemonUnreachableError);
    expect((failure as Error).cause).toBe(cause);
  });

  it.each([502, 503, 504])(
    'names a proxy’s %i for a daemon that is down as the daemon being unreachable',
    async (status) => {
      // What Vite's dev proxy (or nginx) answers when nothing listens behind it: no envelope.
      const cause = new LanternApiError(
        status,
        UNKNOWN_ERROR_CODE,
        `The Lantern daemon answered with status ${String(status)}.`,
      );
      const failure = await request(() => Promise.reject(cause)).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DaemonUnreachableError);
      expect((failure as Error).cause).toBe(cause);
      expect(describeFailure(failure)).toMatch(/could not be reached/);
    },
  );

  it('keeps the daemon’s own 5xx, which carries an envelope, as the daemon gave it', async () => {
    const internal = new LanternApiError(500, 'internal', 'Internal error');
    const unavailable = new LanternApiError(503, 'backend-unavailable', 'The backend is down.');
    await expect(request(() => Promise.reject(internal))).rejects.toBe(internal);
    await expect(request(() => Promise.reject(unavailable))).rejects.toBe(unavailable);
  });

  it('keeps an envelope-less answer that is not a gateway’s as a refusal', async () => {
    const notFound = new LanternApiError(
      404,
      UNKNOWN_ERROR_CODE,
      'The Lantern daemon answered with status 404.',
    );
    await expect(request(() => Promise.reject(notFound))).rejects.toBe(notFound);
  });

  it('leaves a cancellation alone, so TanStack Query recognises it', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    await expect(request(() => Promise.reject(abort))).rejects.toBe(abort);
  });
});

describe('a failure, in words', () => {
  it('tells someone to check the daemon when it could not be reached', () => {
    expect(describeFailure(new DaemonUnreachableError(new TypeError('x')))).toMatch(
      /could not be reached/,
    );
  });

  it('repeats the daemon’s message for a refusal', () => {
    expect(describeFailure(new LanternApiError(404, 'not-found', 'No such library.'))).toBe(
      'No such library.',
    );
  });

  it('says the daemon is shutting down for its 503 unavailable, rather than pointing at the log', () => {
    expect(
      describeFailure(
        new LanternApiError(
          503,
          'unavailable',
          'Lantern is shutting down; try again once it is back.',
        ),
      ),
    ).toBe('The Lantern daemon is shutting down. Try again once it is back.');
  });

  it('points at the log for a 5xx, whose body is generic by design', () => {
    expect(describeFailure(new LanternApiError(500, 'internal', 'Internal error'))).toMatch(/log/);
  });

  it('uses the message of anything else', () => {
    expect(describeFailure(new Error('Render failed'))).toBe('Render failed');
  });
});
