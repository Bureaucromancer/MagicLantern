// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Builds the app's long-lived objects around one lantern-client: the query
 * client and the router. A factory rather than module singletons, so each test
 * gets its own and the entry point is the only place that picks real ones.
 */

import type { LanternClient } from '@bureaucromancer/lantern-client';
import type { QueryClient } from '@tanstack/react-query';
import type { RouterHistory } from '@tanstack/react-router';

import { createQueryClient } from './queries.js';
import { createAppRouter, type AppRouter } from './router.js';

export interface AppState {
  client: LanternClient;
  queryClient: QueryClient;
  router: AppRouter;
}

export function createAppState(client: LanternClient, history?: RouterHistory): AppState {
  // Each needs the other: routes fetch through the query client, and a 401
  // from any query sends the router to sign-in. The holder breaks the cycle.
  const holder: { router?: AppRouter } = {};
  const queryClient = createQueryClient({
    onSessionEnded: () => {
      const { router } = holder;
      if (router === undefined || router.state.location.pathname === '/login') return;
      // Replacing: Back would only return to a page that answers 401 again.
      void router.navigate({ to: '/login', replace: true });
    },
  });
  const router = createAppRouter({ client, queryClient }, history);
  holder.router = router;
  return { client, queryClient, router };
}
