// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The app's routes. Code-based rather than generated: at this size a route
 * generator would be more machinery than route.
 *
 * - `/` decides where a visitor goes: sign-in, or a library (A22: the last one
 *   this browser used if it still opens, else the first that does).
 * - `/l/$lib/generate` is a library's generate page; the library is in the URL
 *   so every tab is independent.
 * - `/login` is the password form, reachable only while it is needed.
 * - Anything else under `/l/$lib` is "page not found" inside that library's
 *   frame; anything else at all is "page not found" in a bare one.
 *
 * Routes reach the daemon through the query client and lantern-client in the
 * router context, so a test builds the real tree around a fake client. Page
 * components take props and know nothing about routes.
 */

import type { LanternClient } from '@bureaucromancer/lantern-client';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  notFound,
  Outlet,
  redirect,
  useNavigate,
  type RouterHistory,
} from '@tanstack/react-router';
import type { JSX } from 'react';

import { useLanternClient } from './client-context.js';
import { readLastLibrary } from './last-library.js';
import { findLibrary, isLibraryId, needsSignIn, pickLibrary } from './library-choice.js';
import { GeneratePage } from './pages/GeneratePage.js';
import { LibraryLayout, useLibrary } from './pages/LibraryLayout.js';
import { LoginPage } from './pages/LoginPage.js';
import { NoLibraryPage } from './pages/NoLibraryPage.js';
import { LibraryNotFound, LibraryPageNotFound, PageNotFound } from './pages/NotFoundPages.js';
import { PendingPage, RouteErrorPage } from './pages/RouteStatusPages.js';
import { librariesQuery, sessionQuery } from './queries.js';

export interface RouterContext {
  client: LanternClient;
  queryClient: QueryClient;
}

/** Fetched afresh rather than read from cache: a sign-in or sign-out in another tab changes it. */
function currentSession({ client, queryClient }: RouterContext) {
  return queryClient.fetchQuery({ ...sessionQuery(client), staleTime: 0 });
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  notFoundComponent: PageNotFound,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async ({ context }) => {
    if (needsSignIn(await currentSession(context))) {
      throw redirect({ to: '/login', replace: true });
    }
    const { libraries } = await context.queryClient.fetchQuery({
      ...librariesQuery(context.client),
      staleTime: 0,
    });
    const library = pickLibrary(libraries, readLastLibrary());
    if (library !== undefined) {
      // Replacing, so Back does not land on `/` and bounce forward again.
      throw redirect({ to: '/l/$lib/generate', params: { lib: library.id }, replace: true });
    }
  },
  // Rendered only when no library can be opened.
  component: function NoLibrary(): JSX.Element {
    const libraries = useQuery(librariesQuery(useLanternClient()));
    return libraries.data === undefined ? (
      <PendingPage />
    ) : (
      <NoLibraryPage libraries={libraries.data.libraries} />
    );
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: async ({ context }) => {
    if (!needsSignIn(await currentSession(context))) throw redirect({ to: '/', replace: true });
  },
  component: function Login(): JSX.Element {
    const navigate = useNavigate();
    return (
      <LoginPage
        onSignedIn={() => {
          void navigate({ to: '/', replace: true });
        }}
      />
    );
  },
});

const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/l/$lib',
  loader: async ({ context: { client, queryClient }, params }) => {
    // A malformed id cannot name a library; no need to ask the daemon.
    if (!isLibraryId(params.lib)) throw notFound();
    const cached = await queryClient.ensureQueryData(librariesQuery(client));
    if (findLibrary(cached.libraries, params.lib) !== undefined) return;
    // The cached list may predate the library; ask once more before saying no.
    const fresh = await queryClient.fetchQuery({ ...librariesQuery(client), staleTime: 0 });
    if (findLibrary(fresh.libraries, params.lib) === undefined) throw notFound();
  },
  component: function Library(): JSX.Element {
    const { lib } = libraryRoute.useParams();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    return (
      // Keyed, so moving to another library is a fresh frame rather than this one with new props.
      <LibraryLayout
        key={lib}
        libraryId={lib}
        onSignedOut={async () => {
          await navigate({ to: '/login', replace: true });
          // What was cached belonged to the session that just ended.
          queryClient.removeQueries();
        }}
      >
        <Outlet />
      </LibraryLayout>
    );
  },
  // The loader's notFound(): rendered instead of the layout, so it brings its own frame.
  notFoundComponent: function LibraryMissing(): JSX.Element {
    const { lib } = libraryRoute.useParams();
    return <LibraryNotFound libraryId={lib} />;
  },
});

/** `/l/$lib` alone has no page of its own yet; generate is the library's front door. */
const libraryIndexRoute = createRoute({
  getParentRoute: () => libraryRoute,
  path: '/',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/l/$lib/generate', params: { lib: params.lib }, replace: true });
  },
});

const generateRoute = createRoute({
  getParentRoute: () => libraryRoute,
  path: 'generate',
  component: function Generate(): JSX.Element | null {
    const { lib } = generateRoute.useParams();
    const { library } = useLibrary(lib);
    // The layout above answers for a list still loading or no longer naming it.
    return library === undefined ? null : <GeneratePage key={lib} library={library} />;
  },
});

/**
 * Any other page under a library. Without it the router would hand an unknown
 * child path to the library's notFoundComponent, which says the library does
 * not exist (it does: the loader found it) and draws a second frame inside the
 * first. Ranked below `/` and `generate`, so it takes only what they do not.
 */
const libraryUnknownPageRoute = createRoute({
  getParentRoute: () => libraryRoute,
  path: '$',
  component: function UnknownLibraryPage(): JSX.Element {
    const { lib } = libraryUnknownPageRoute.useParams();
    return <LibraryPageNotFound libraryId={lib} />;
  },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  libraryRoute.addChildren([libraryIndexRoute, generateRoute, libraryUnknownPageRoute]),
]);

export function createAppRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context,
    ...(history === undefined ? {} : { history }),
    defaultErrorComponent: RouteErrorPage,
    defaultPendingComponent: PendingPage,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
