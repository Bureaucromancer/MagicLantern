// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Sign-in for password mode: one install-wide password, no accounts. The
 * password is set from the CLI (`lantern set-password`), so there is no setup
 * form. Router-free (it reports success through `onSignedIn`), so tests render
 * it with a fake client alone.
 */

import { ErrorCodes, errorCode, type LanternClient } from '@bureaucromancer/lantern-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type JSX } from 'react';

import { useLanternClient } from '../client-context.js';
import { describeFailure, request } from '../queries.js';
import { APP_NAME } from '../Shell.js';
import { Alert } from '../ui/Alert.js';
import { Button } from '../ui/Button.js';
import { control, fieldLabel } from '../ui/classes.js';

/**
 * The 401 carries one code for every failure on purpose (nothing to probe),
 * so the sentence lives here. Everything else reports what happened.
 */
export function loginFailureMessage(failure: unknown): string {
  if (errorCode(failure) === ErrorCodes.invalidCredentials) {
    return 'That password was not recognised.';
  }
  return describeFailure(failure);
}

/**
 * `auth-disabled` means the daemon needs no password (mode none, perhaps
 * switched while this page was open): nothing to sign in to, so carry on.
 */
async function signIn(client: LanternClient, password: string): Promise<void> {
  try {
    await request(() => client.login(password));
  } catch (failure) {
    if (errorCode(failure) === ErrorCodes.authDisabled) return;
    throw failure;
  }
}

export interface LoginPageProps {
  /** Called once the session cookie is set; the route goes back to `/`. */
  onSignedIn: () => void;
}

export function LoginPage({ onSignedIn }: LoginPageProps): JSX.Element {
  const client = useLanternClient();
  const queryClient = useQueryClient();
  const passwordId = useId();
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: (candidate: string) => signIn(client, candidate),
    onSuccess: () => {
      // Nothing cached before sign-in describes what this session may see.
      queryClient.removeQueries();
      onSignedIn();
    },
  });

  return (
    <div className="flex min-h-dvh flex-col">
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center p-6">
        <h1 className="mb-6 text-center text-title text-ink">{APP_NAME}</h1>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            login.mutate(password);
          }}
        >
          {login.error === null ? null : (
            <Alert tone="error" role="alert">
              {loginFailureMessage(login.error)}
            </Alert>
          )}
          {/* Password managers file a password under a username; this gives them one. */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value="lantern"
            readOnly
            hidden
          />
          <div>
            <label htmlFor={passwordId} className={`${fieldLabel} mb-1`}>
              Password
            </label>
            {/* Not `required`: the daemon sets no minimum, and an empty
                password is answered like any other wrong one. */}
            <input
              id={passwordId}
              name="password"
              type="password"
              className={control}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              autoComplete="current-password"
              autoFocus
            />
          </div>
          <Button type="submit" variant="primary" className="w-full" disabled={login.isPending}>
            Sign in
          </Button>
        </form>
      </main>
    </div>
  );
}
