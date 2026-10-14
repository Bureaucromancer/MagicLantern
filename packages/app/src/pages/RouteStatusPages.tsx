// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * What the router renders while a route loads, and when loading or rendering
 * one fails. The router's own boundary rather than a hand-rolled one: it
 * resets on navigation, and keeps the header usable.
 */

import { useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import type { JSX } from 'react';

import { describeFailure, endsTheSession } from '../queries.js';
import { Shell } from '../Shell.js';
import { Alert } from '../ui/Alert.js';
import { Button } from '../ui/Button.js';
import { pageColumn } from '../ui/classes.js';
import { Note } from '../ui/Text.js';

export function PendingPage(): JSX.Element {
  return (
    <Shell>
      <div className={pageColumn}>
        <Note role="status">Loading…</Note>
      </div>
    </Shell>
  );
}

export function RouteErrorPage({ error }: ErrorComponentProps): JSX.Element {
  const router = useRouter();

  // The query client's handler is already navigating to sign-in; say so
  // rather than flash an error for the moment that takes.
  if (endsTheSession(error)) {
    return (
      <Shell>
        <div className={pageColumn}>
          <Note role="status">Your session has ended. Taking you to sign in…</Note>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className={pageColumn}>
        <Alert tone="error" role="alert">
          <p className="font-medium">This page could not be loaded.</p>
          <p className="mt-1">{describeFailure(error)}</p>
        </Alert>
        <Button
          type="button"
          className="mt-4"
          onClick={() => {
            void router.invalidate();
          }}
        >
          Try again
        </Button>
      </div>
    </Shell>
  );
}
