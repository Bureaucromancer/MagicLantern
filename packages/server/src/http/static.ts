// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Serving the built app, registered last, and the not-found answer.
 *
 * The app root is resolved before this runs (config/app-root.ts, which may read
 * the disk). SPA fallback (index.html) for GET and HEAD only, never for the
 * reserved prefixes (`/api`, `/healthz`, `/v1`), which answer JSON 404s;
 * `allowedPath` keeps those prefixes off the disk too, because a file at
 * `<root>/api/x` is otherwise a route. Both checks decode the path first: the
 * router decodes before matching, so `/%61pi/...` is `/api/...` to it, and a
 * check on the raw URL would disagree (StoryEngine's bypass).
 *
 * Hashed build assets are cached for a year; everything else revalidates, so
 * a new build's index.html is picked up at once. A rebuild can also remove
 * index.html under a running daemon for a moment (Vite empties dist first);
 * the fallback then answers the JSON 404, not Fastify's plain-text one.
 */

import { join, sep } from 'node:path';

import fastifyStatic from '@fastify/static';

import type { AppRootResolution } from '../config/app-root.js';
import { sendNotFound } from './errors.js';
import type { LanternApp } from './types.js';

/** Paths the daemon's router owns. `/v1` is the OpenAI-compatible proxy from 0.2. */
export const RESERVED_PREFIXES = ['/api', '/healthz', '/v1'] as const;

/** Vite's content-hashed output directory. */
const ASSETS_PREFIX = '/assets/';

/** The path as the router sees it: query dropped, percent-escapes decoded, lowercased. */
function routedPath(url: string): string {
  const end = url.search(/[?#]/);
  let path = end === -1 ? url : url.slice(0, end);
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape. The router refuses such a URL before any handler
    // runs (app.ts's frameworkErrors), so only a direct caller gets here.
  }
  // Lowercased because a case-insensitive filesystem would serve `<root>/API/x` for `/api/x`.
  return path.toLowerCase();
}

export function isReservedPath(url: string): boolean {
  const path = routedPath(url);
  return RESERVED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export interface StaticAppOptions {
  readonly appRoot: AppRootResolution;
}

export async function registerStaticApp(app: LanternApp, options: StaticAppOptions): Promise<void> {
  const resolution = options.appRoot;
  const served = resolution.kind === 'served';

  if (resolution.kind === 'served') {
    const assets = join(resolution.root, 'assets') + sep;
    await app.register(fastifyStatic, {
      root: resolution.root,
      allowedPath: (pathName) => !isReservedPath(pathName),
      dotfiles: 'ignore',
      cacheControl: false,
      setHeaders: (reply, path) => {
        void reply.header(
          'cache-control',
          path.startsWith(assets) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const fallback =
      served &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      !isReservedPath(request.url) &&
      // A missing hashed asset is a stale page asking for an old build; HTML would not help it.
      !routedPath(request.url).startsWith(ASSETS_PREFIX);
    if (!fallback) return sendNotFound(reply);
    // @fastify/static answers a missing file with callNotFound, which inside
    // the not-found handler is Fastify's plain-text 404. For this one reply it
    // is the envelope instead: index.html is gone (a rebuild in progress).
    reply.callNotFound = () => {
      request.log.warn(
        { event: 'app.shell-missing', appRoot: resolution.root },
        'The built app has no index.html; rebuild it (pnpm build) or check appRoot',
      );
      sendNotFound(reply);
    };
    return reply.sendFile('index.html');
  });
}
