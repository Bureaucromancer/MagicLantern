// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { LanternApiError, UNKNOWN_ERROR_CODE } from '@bureaucromancer/lantern-client';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { LanternClientProvider } from '../client-context.js';
import { createQueryClient } from '../queries.js';
import { fakeClient, type FakeClient } from '../test-fake-client.js';
import { LoginPage } from './LoginPage.js';

/** The page alone, with a fake client: no router, no daemon. */
function renderLogin(client: FakeClient) {
  const onSessionEnded = vi.fn();
  const queryClient = createQueryClient({ onSessionEnded });
  queryClient.setQueryData(['libraries'], { libraries: [] });
  const onSignedIn = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <LanternClientProvider client={client}>
        <LoginPage onSignedIn={onSignedIn} />
      </LanternClientProvider>
    </QueryClientProvider>,
  );
  return { onSignedIn, onSessionEnded, queryClient };
}

async function signIn(password: string): Promise<void> {
  const user = userEvent.setup();
  if (password !== '') await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

const passwordMode = { session: { mode: 'password', authenticated: false } } as const;

describe('the sign-in page', () => {
  it('signs in with the password typed, then hands back to the route', async () => {
    const { client } = fakeClient(passwordMode);
    const { onSignedIn } = renderLogin(client);

    await signIn('hunter2');

    await waitFor(() => {
      expect(onSignedIn).toHaveBeenCalledTimes(1);
    });
    expect(client.login).toHaveBeenCalledWith('hunter2');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('drops what was cached before sign-in', async () => {
    const { client } = fakeClient(passwordMode);
    const { onSignedIn, queryClient } = renderLogin(client);

    await signIn('hunter2');

    await waitFor(() => {
      expect(onSignedIn).toHaveBeenCalled();
    });
    expect(queryClient.getQueryData(['libraries'])).toBeUndefined();
  });

  it('says a wrong password was not recognised, inline, and stays', async () => {
    const { client } = fakeClient(passwordMode);
    const { onSignedIn, onSessionEnded } = renderLogin(client);

    await signIn('wrong');

    expect((await screen.findByRole('alert')).textContent).toBe(
      'That password was not recognised.',
    );
    expect(onSignedIn).not.toHaveBeenCalled();
    // A 401 here is a typo, not a session ending: nothing redirects.
    expect(onSessionEnded).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveProperty('disabled', false);
  });

  it('submits an empty password rather than refusing it in the browser', async () => {
    const { client } = fakeClient(passwordMode);
    renderLogin(client);

    await signIn('');

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(client.login).toHaveBeenCalledWith('');
  });

  it('carries on when the daemon turns out to need no password', async () => {
    const { client } = fakeClient({ session: { mode: 'none', authenticated: true } });
    const { onSignedIn } = renderLogin(client);

    await signIn('anything');

    await waitFor(() => {
      expect(onSignedIn).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so when the daemon cannot be reached', async () => {
    const { client } = fakeClient(passwordMode);
    client.login.mockRejectedValue(new TypeError('Failed to fetch'));
    const { onSignedIn } = renderLogin(client);

    await signIn('hunter2');

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be reached/);
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('says so when a proxy in front of the daemon answers for it', async () => {
    const { client } = fakeClient(passwordMode);
    client.login.mockRejectedValue(
      new LanternApiError(504, UNKNOWN_ERROR_CODE, 'The Lantern daemon answered with status 504.'),
    );
    renderLogin(client);

    await signIn('hunter2');

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be reached/);
  });

  it('reports any other refusal in the daemon’s words', async () => {
    const { client } = fakeClient(passwordMode);
    client.login.mockRejectedValue(
      new LanternApiError(403, 'forbidden-origin', 'This origin is not allowed.'),
    );
    renderLogin(client);

    await signIn('hunter2');

    expect((await screen.findByRole('alert')).textContent).toBe('This origin is not allowed.');
  });

  it('asks password managers for the current password, under a fixed username', () => {
    const { client } = fakeClient(passwordMode);
    renderLogin(client);

    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('current-password');
    const username = document.querySelector('input[autocomplete="username"]');
    expect(username?.getAttribute('value')).toBe('lantern');
  });
});
