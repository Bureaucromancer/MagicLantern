// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * A stand-in for lantern-client with a little daemon state behind it, so
 * tests drive the real router and pages without HTTP. Every method is a vi.fn,
 * so a test can assert what was asked or override one answer.
 */

import {
  LanternApiError,
  type InfoResponse,
  type LanternClient,
  type LibraryStatus,
  type LibrarySummary,
  type SessionResponse,
} from '@bureaucromancer/lantern-client';
import { vi, type Mock } from 'vitest';

export const LIB_A = 'lib_01JA0000000000000000000000';
export const LIB_B = 'lib_01JB0000000000000000000000';
export const LIB_C = 'lib_01JC0000000000000000000000';

export const TEST_VERSION = '0.1.0-test';

export function librarySummary(
  id: string,
  name: string,
  status: LibraryStatus = 'ok',
  reason?: string,
): LibrarySummary {
  return { id, name, status, ...(reason === undefined ? {} : { reason }) };
}

export interface FakeDaemonState {
  session: SessionResponse;
  libraries: LibrarySummary[];
  /** What `login` accepts; anything else is `invalid-credentials`. */
  password: string;
}

export type FakeClient = { [K in keyof LanternClient]: Mock<LanternClient[K]> };

export function fakeClient(initial: Partial<FakeDaemonState> = {}): {
  client: FakeClient;
  state: FakeDaemonState;
} {
  const state: FakeDaemonState = {
    session: { mode: 'none', authenticated: true },
    libraries: [librarySummary(LIB_A, 'Library')],
    password: 'hunter2',
    ...initial,
  };
  const info: InfoResponse = { name: 'lantern', version: TEST_VERSION, apiVersion: 'v1' };

  /** The daemon's auth gate: password mode without a session is refused. */
  function gate(): Promise<void> {
    return state.session.mode === 'password' && !state.session.authenticated
      ? Promise.reject(new LanternApiError(401, 'unauthenticated', 'Sign in first.'))
      : Promise.resolve();
  }

  const client: FakeClient = {
    health: vi.fn<LanternClient['health']>(() => Promise.resolve({ status: 'ok' })),
    session: vi.fn<LanternClient['session']>(() => Promise.resolve({ ...state.session })),
    login: vi.fn<LanternClient['login']>((password) => {
      if (state.session.mode === 'none') {
        return Promise.reject(new LanternApiError(409, 'auth-disabled', 'Auth mode is none.'));
      }
      if (password !== state.password) {
        return Promise.reject(
          new LanternApiError(401, 'invalid-credentials', 'Invalid credentials.'),
        );
      }
      state.session = { mode: 'password', authenticated: true };
      return Promise.resolve();
    }),
    logout: vi.fn<LanternClient['logout']>(() => {
      if (state.session.mode === 'password') {
        state.session = { mode: 'password', authenticated: false };
      }
      return Promise.resolve();
    }),
    info: vi.fn<LanternClient['info']>(() => gate().then(() => info)),
    listLibraries: vi.fn<LanternClient['listLibraries']>(() =>
      gate().then(() => ({ libraries: state.libraries.map((library) => ({ ...library })) })),
    ),
    // The fake daemon knows no models: every library answers as a fresh daemon would.
    resolve: vi.fn<LanternClient['resolve']>((lib) =>
      gate().then(() =>
        Promise.reject(
          state.libraries.some((library) => library.id === lib)
            ? new LanternApiError(422, 'invalid', 'The body is not valid.', [
                { path: '/model', message: 'is not a known model' },
              ])
            : new LanternApiError(404, 'not-found', 'No such library.'),
        ),
      ),
    ),
    createLibrary: vi.fn<LanternClient['createLibrary']>((name) =>
      gate().then(() => {
        const library = librarySummary(
          `lib_01JZ${String(state.libraries.length).padStart(22, '0')}`,
          name,
        );
        state.libraries.push(library);
        return { ...library };
      }),
    ),
    renameLibrary: vi.fn<LanternClient['renameLibrary']>((lib, name) =>
      gate().then(() => {
        const library = state.libraries.find((candidate) => candidate.id === lib);
        if (library === undefined) {
          return Promise.reject(new LanternApiError(404, 'not-found', 'No such library.'));
        }
        library.name = name;
        return { ...library };
      }),
    ),
    // The fake daemon holds no assets: uploads are refused, queries are empty.
    uploadAsset: vi.fn<LanternClient['uploadAsset']>(() =>
      gate().then(() =>
        Promise.reject(
          new LanternApiError(422, 'invalid', 'The body is not valid.', [
            { path: '/file', message: 'is not an image Lantern can read' },
          ]),
        ),
      ),
    ),
    listAssets: vi.fn<LanternClient['listAssets']>(() =>
      gate().then(() => ({ assets: [], next_cursor: null })),
    ),
    assetProvenance: vi.fn<LanternClient['assetProvenance']>(() => noAsset()),
    assetLineage: vi.fn<LanternClient['assetLineage']>(() => noAsset()),
    rateAsset: vi.fn<LanternClient['rateAsset']>(() => noAsset()),
    deleteAsset: vi.fn<LanternClient['deleteAsset']>(() => noAsset()),
    assetUrl: vi.fn<LanternClient['assetUrl']>(
      (lib, asset) => `/api/v1/libraries/${lib}/assets/${asset}`,
    ),
    thumbnailUrl: vi.fn<LanternClient['thumbnailUrl']>(
      (lib, asset) => `/api/v1/libraries/${lib}/assets/${asset}/thumb`,
    ),
  };

  function noAsset(): Promise<never> {
    return gate().then(() =>
      Promise.reject(new LanternApiError(404, 'not-found', 'No such asset.')),
    );
  }

  return { client, state };
}
