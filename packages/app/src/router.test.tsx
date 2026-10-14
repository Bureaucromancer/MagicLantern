// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { LanternApiError, UNKNOWN_ERROR_CODE } from '@bureaucromancer/lantern-client';
import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from './App.js';
import { createAppState, type AppState } from './app-state.js';
import { LAST_LIBRARY_KEY } from './last-library.js';
import {
  fakeClient,
  LIB_A,
  LIB_B,
  LIB_C,
  librarySummary,
  TEST_VERSION,
  type FakeClient,
} from './test-fake-client.js';

/**
 * The real route tree and query client around a fake lantern-client, starting
 * at `path`. Asserting where a navigation lands, rather than what the route
 * table says, is the claim that matters.
 */
function renderAt(client: FakeClient, path: string): AppState {
  const state = createAppState(client, createMemoryHistory({ initialEntries: [path] }));
  render(<App {...state} />);
  return state;
}

async function landsAt(state: AppState, pathname: string): Promise<void> {
  await waitFor(() => {
    expect(state.router.state.location.pathname).toBe(pathname);
  });
}

const generate = (id: string) => `/l/${id}/generate`;

const signedOut = { session: { mode: 'password', authenticated: false } } as const;
const signedIn = { session: { mode: 'password', authenticated: true } } as const;

beforeEach(() => {
  localStorage.clear();
});

describe('arriving at /', () => {
  it('opens the only library, named in the header with its status and the daemon version below', async () => {
    const { client } = fakeClient();
    const state = renderAt(client, '/');

    await landsAt(state, generate(LIB_A));
    const header = screen.getByRole('banner');
    expect(within(header).getByText('Library')).toBeTruthy();
    expect(within(header).getByText('Available')).toBeTruthy();
    expect(
      await screen.findByRole('heading', { name: 'Generate — coming in the prototype' }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole('contentinfo').textContent).toContain(TEST_VERSION);
    });
  });

  it('asks once for what the route already fetched, rather than again as the page mounts', async () => {
    const { client } = fakeClient();
    renderAt(client, '/');

    await screen.findByRole('heading', { name: 'Generate — coming in the prototype' });
    await waitFor(() => {
      expect(client.info).toHaveBeenCalled();
    });
    expect(client.session).toHaveBeenCalledTimes(1);
    expect(client.listLibraries).toHaveBeenCalledTimes(1);
  });

  it('opens the library this browser used last', async () => {
    localStorage.setItem(LAST_LIBRARY_KEY, LIB_B);
    const { client } = fakeClient({
      libraries: [librarySummary(LIB_A, 'First'), librarySummary(LIB_B, 'Second')],
    });
    const state = renderAt(client, '/');

    await landsAt(state, generate(LIB_B));
    expect(within(screen.getByRole('banner')).getByText('Second')).toBeTruthy();
  });

  it('opens the first library that works when the remembered one cannot be opened', async () => {
    localStorage.setItem(LAST_LIBRARY_KEY, LIB_B);
    const { client } = fakeClient({
      libraries: [
        librarySummary(LIB_A, 'First'),
        librarySummary(LIB_B, 'Broken', 'unavailable', 'library.db is corrupt'),
      ],
    });
    const state = renderAt(client, '/');

    await landsAt(state, generate(LIB_A));
  });

  it('opens the first library when the remembered one has gone', async () => {
    localStorage.setItem(LAST_LIBRARY_KEY, LIB_C);
    const { client } = fakeClient();
    const state = renderAt(client, '/');

    await landsAt(state, generate(LIB_A));
  });

  it('says why when no library can be opened', async () => {
    const { client } = fakeClient({
      libraries: [librarySummary(LIB_A, 'Broken', 'unavailable', 'library.db is corrupt')],
    });
    renderAt(client, '/');

    expect(await screen.findByRole('heading', { name: 'No library can be opened' })).toBeTruthy();
    expect(screen.getByText(/library\.db is corrupt/)).toBeTruthy();
  });

  it('sends a visitor without a session to sign-in, before asking for libraries', async () => {
    const { client } = fakeClient(signedOut);
    const state = renderAt(client, '/');

    await landsAt(state, '/login');
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(client.listLibraries).not.toHaveBeenCalled();
  });
});

describe('a library in the URL', () => {
  it('becomes the one a fresh tab starts in', async () => {
    const { client } = fakeClient({
      libraries: [librarySummary(LIB_A, 'First'), librarySummary(LIB_B, 'Second')],
    });
    renderAt(client, generate(LIB_B));

    await screen.findByText('Second');
    await waitFor(() => {
      expect(localStorage.getItem(LAST_LIBRARY_KEY)).toBe(LIB_B);
    });
  });

  it('opens its generate page from the bare library address', async () => {
    const { client } = fakeClient();
    const state = renderAt(client, `/l/${LIB_A}`);

    await landsAt(state, generate(LIB_A));
  });

  it('is a friendly not-found when the daemon does not list it, after asking afresh', async () => {
    const { client } = fakeClient();
    renderAt(client, generate(LIB_C));

    expect(await screen.findByRole('heading', { name: 'Library not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to your library' }).getAttribute('href')).toBe('/');
    expect(client.listLibraries).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(LAST_LIBRARY_KEY)).toBeNull();
    expect(screen.getAllByRole('banner')).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it.each(['settings', 'generat', 'generate/extra'])(
    'says a page under it is not found, inside its frame, for /%s',
    async (rest) => {
      const { client } = fakeClient();
      const state = renderAt(client, `/l/${LIB_A}/${rest}`);

      expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Library not found' })).toBeNull();
      // One frame: the library's own, still naming it.
      expect(screen.getAllByRole('banner')).toHaveLength(1);
      expect(screen.getAllByRole('main')).toHaveLength(1);
      expect(within(screen.getByRole('banner')).getByText('Library')).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Go to this library' }).getAttribute('href')).toBe(
        generate(LIB_A),
      );
      expect(state.router.state.location.pathname).toBe(`/l/${LIB_A}/${rest}`);
    },
  );

  it('says a library it does not list is not found, whatever page under it was asked for', async () => {
    const { client } = fakeClient();
    renderAt(client, `/l/${LIB_C}/settings`);

    expect(await screen.findByRole('heading', { name: 'Library not found' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Page not found' })).toBeNull();
    expect(screen.getAllByRole('banner')).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it('is not found without asking when it is not shaped like a library id', async () => {
    const { client } = fakeClient();
    renderAt(client, '/l/holiday-photos/generate');

    expect(await screen.findByRole('heading', { name: 'Library not found' })).toBeTruthy();
    expect(client.listLibraries).not.toHaveBeenCalled();
  });

  it('warns that a library written by a newer Lantern is read-only', async () => {
    const { client } = fakeClient({
      libraries: [librarySummary(LIB_A, 'Library', 'read-only', 'Schema 3 is newer than 1.')],
    });
    renderAt(client, generate(LIB_A));

    expect(await screen.findByText(/opens read-only/)).toBeTruthy();
    expect(screen.getByText('Schema 3 is newer than 1.')).toBeTruthy();
    expect(within(screen.getByRole('banner')).getByText('Read-only')).toBeTruthy();
  });

  it('explains a library that cannot be opened, and does not remember it', async () => {
    const { client } = fakeClient({
      libraries: [librarySummary(LIB_A, 'Library', 'unavailable', 'library.db is corrupt')],
    });
    renderAt(client, generate(LIB_A));

    expect(await screen.findByText('This library can’t be opened.')).toBeTruthy();
    expect(screen.getByText('library.db is corrupt')).toBeTruthy();
    expect(localStorage.getItem(LAST_LIBRARY_KEY)).toBeNull();
  });
});

describe('signing in and out', () => {
  it('follows a deep link to sign-in when the daemon answers 401', async () => {
    const { client } = fakeClient(signedOut);
    const state = renderAt(client, generate(LIB_A));

    await landsAt(state, '/login');
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('goes to sign-in when a session ends under an open page', async () => {
    const { client, state: daemon } = fakeClient(signedIn);
    const state = renderAt(client, generate(LIB_A));
    await screen.findByRole('heading', { name: 'Generate — coming in the prototype' });

    // Signed out elsewhere: the next request the page makes is refused.
    daemon.session = { mode: 'password', authenticated: false };
    await state.queryClient.refetchQueries({ queryKey: ['libraries'] }).catch(() => undefined);

    await landsAt(state, '/login');
  });

  it('signs in and returns to the library', async () => {
    const { client } = fakeClient(signedOut);
    const state = renderAt(client, '/login');
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await landsAt(state, generate(LIB_A));
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('leaves sign-in for / when there is nothing to sign in to', async () => {
    const { client } = fakeClient();
    const state = renderAt(client, '/login');

    await landsAt(state, generate(LIB_A));
  });

  it('offers sign-out only in password mode', async () => {
    const { client } = fakeClient();
    renderAt(client, generate(LIB_A));

    await screen.findByRole('heading', { name: 'Generate — coming in the prototype' });
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('signs out to the sign-in page', async () => {
    const { client } = fakeClient(signedIn);
    const state = renderAt(client, generate(LIB_A));
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    await landsAt(state, '/login');
    expect(client.logout).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});

describe('everything else', () => {
  it('is a friendly not-found for an address the app does not have', async () => {
    const { client } = fakeClient();
    renderAt(client, '/settings');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });

  it('says the daemon could not be reached, and offers to try again', async () => {
    const { client } = fakeClient();
    client.session.mockRejectedValue(new TypeError('Failed to fetch'));
    const state = renderAt(client, '/');

    expect(await screen.findByText(/could not be reached/, {}, { timeout: 5000 })).toBeTruthy();

    client.session.mockResolvedValue({ mode: 'none', authenticated: true });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    await landsAt(state, generate(LIB_A));
  });

  it('says the daemon could not be reached when a proxy in front of it answers 502', async () => {
    const { client } = fakeClient();
    // Vite's dev proxy with the daemon stopped: a bare 502, no Lantern envelope.
    client.session.mockRejectedValue(
      new LanternApiError(502, UNKNOWN_ERROR_CODE, 'The Lantern daemon answered with status 502.'),
    );
    renderAt(client, '/');

    expect(await screen.findByText(/could not be reached/, {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText(/internal error/)).toBeNull();
  });

  it('reports a refusal in the daemon’s words', async () => {
    const { client } = fakeClient();
    client.listLibraries.mockRejectedValue(
      new LanternApiError(403, 'forbidden-host', 'This host name is not allowed.'),
    );
    renderAt(client, '/');

    expect(await screen.findByText('This host name is not allowed.')).toBeTruthy();
  });
});
