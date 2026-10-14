// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import type { JSX } from 'react';

import type { AppState } from './app-state.js';
import { LanternClientProvider } from './client-context.js';

/** The providers around the router. Takes its state, so tests pass their own. */
export function App({ client, queryClient, router }: AppState): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <LanternClientProvider client={client}>
        <RouterProvider router={router} />
      </LanternClientProvider>
    </QueryClientProvider>
  );
}
