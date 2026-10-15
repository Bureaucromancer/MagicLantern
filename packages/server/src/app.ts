// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Builds the Fastify app without listening, so tests use `app.inject()` and
 * the OpenAPI emitter builds it with stub services.
 *
 * Order matters and is fixed here: the validator compiler and parsers, the
 * error handling, the in-flight tracking shutdown waits on, the security
 * hooks (every request, static files included), the refusal of requests that
 * arrive while shutting down, the cookie and multipart parsers, then the
 * OpenAPI plugin *before* any route, then `/healthz`, then the API plugin
 * under `/api/v1` with its auth gate, then the built app and the not-found
 * handler last. Requests the router refuses before any hook runs go through
 * the same security guard in `frameworkErrors`.
 *
 * Nothing here reads `services` or `config.dataDir`: only handlers do, at
 * request time.
 */

import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { API_V1_PREFIX, ErrorCodes } from '@bureaucromancer/lantern-schema';
import Fastify, { type FastifyServerOptions } from 'fastify';

import { resolveAppRoot, type AppRootResolution } from './config/app-root.js';
import type { ResolvedConfig } from './config/schema.js';
import { createValidator } from './validation/ajv.js';
import { registerAuthGate } from './http/auth.js';
import {
  answerClientError,
  answerFrameworkError,
  registerErrorHandling,
  sendError,
} from './http/errors.js';
import { registerOpenApi } from './http/openapi.js';
import { createSecurityGuard, registerSecurityHooks, type MachineNames } from './http/security.js';
import { registerStaticApp } from './http/static.js';
import type { LanternApp } from './http/types.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerApiRoutes } from './routes/index.js';
import type { AppServices } from './services.js';

export interface AppOptions {
  readonly config: ResolvedConfig;
  /** The port actually bound (config `port` may be 0), which allowed Origins carry. */
  readonly listenPort: number;
  /** Fastify's logger option; logging.ts `loggerOptions` builds it. Off when omitted. */
  readonly logger?: FastifyServerOptions['logger'];
  /** The built app to serve, when already resolved; otherwise resolved from `config.appRoot`. */
  readonly appRoot?: AppRootResolution;
  /** The machine's names for a wildcard bind's Host allowlist; the OS's by default. */
  readonly machine?: MachineNames;
}

/** A JSON body far beyond anything the API takes; uploads have their own (`limits.maxUploadMb`). */
const BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * How long a client has to send a whole request (headers and body); then 408
 * and the connection is closed. Fastify's default of 0 means no limit, which
 * lets a peer hold connections open with a body it never finishes, and nothing
 * (no reverse proxy) sits in front of the daemon to impose one. It times only
 * the request's arrival, never a handler or a response, and leaves room for a
 * large upload on slow Wi-Fi. Node checks it every 30 s, so a stalled request
 * is cut within about this plus 30 s.
 */
export const REQUEST_TIMEOUT_MS = 60_000;

export async function buildApp(services: AppServices, options: AppOptions): Promise<LanternApp> {
  const { config } = options;
  const guard = createSecurityGuard({
    config,
    listenPort: options.listenPort,
    ...(options.machine === undefined ? {} : { machine: options.machine }),
  });
  const app = Fastify({
    logger: options.logger ?? false,
    // Host and Origin checks read the raw headers; a proxy mode arrives at 0.2.
    trustProxy: false,
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    // The router's own refusals (a malformed escape in the path) are answered
    // before any hook runs, so the security guard runs here as well.
    frameworkErrors: (error, request, reply) => {
      if (guard(request, reply) === undefined) answerFrameworkError(error, request, reply);
    },
    clientErrorHandler: answerClientError,
    // Fastify's own answer to a request that arrives while closing skips every
    // hook and is not the envelope; refuseWhileClosing answers it instead.
    return503OnClosing: false,
  }).withTypeProvider<TypeBoxTypeProvider>();
  app.decorate('services', services);

  // One Ajv for every route: Fastify's own would strip unknown fields, fill
  // defaults and coerce types (rule 5).
  const validator = createValidator();
  app.setValidatorCompiler(({ schema }) => validator.compile(schema));
  // A cross-site text/plain POST needs no preflight; with no parser it gets 415.
  app.removeContentTypeParser('text/plain');

  registerErrorHandling(app);
  const inFlight = trackInFlight(app);
  registerSecurityHooks(app, guard);
  refuseWhileClosing(app, inFlight);
  // No secret: the session cookie is signed by hand (auth/session.ts).
  await app.register(fastifyCookie);
  // The multipart/form-data parser, for uploads. Every route but those marked
  // `multipart` refuses that type in the security guard before it is parsed;
  // the upload route sets its own limits per request.
  await app.register(fastifyMultipart, { throwFileSizeLimit: true });

  await registerOpenApi(app);

  registerHealthRoutes(app);
  await app.register(
    (api, _pluginOptions, done) => {
      registerAuthGate(api);
      registerApiRoutes(api, { maxUploadMb: config.limits.maxUploadMb });
      done();
    },
    { prefix: API_V1_PREFIX },
  );

  const appRoot = options.appRoot ?? resolveAppRoot(config.appRoot);
  await registerStaticApp(app, { appRoot });

  return app;
}

/** The requests an app is answering, across every server it listens with. */
interface InFlight {
  readonly requests: Set<IncomingMessage>;
  closing: boolean;
  /** Called whenever a request finishes, while shutdown waits. */
  onFinished: (() => void) | null;
}

const IN_FLIGHT = new WeakMap<LanternApp, InFlight>();

/**
 * Tracks the requests being answered, whichever server accepted them. A bind
 * to a name such as `localhost` gets one server per address it resolves to,
 * and `app.close()` and `app.server` reach only the first: without this,
 * shutdown would close the stores under a handler still running on another.
 *
 * A request is done once answered (`onResponse`) or once its client has gone
 * (`onRequestAbort`: nothing more will reach it), as a server's own close
 * counts a connection done. Hooks rather than a listener on each response,
 * which already carries several from Fastify and @fastify/static.
 *
 * Once closing, every answer carries `Connection: close`, so a keep-alive
 * socket ends with the request in flight on it rather than idling on.
 */
function trackInFlight(app: LanternApp): InFlight {
  const inFlight: InFlight = { requests: new Set(), closing: false, onFinished: null };
  IN_FLIGHT.set(app, inFlight);
  const finished = (raw: IncomingMessage): void => {
    if (inFlight.requests.delete(raw)) inFlight.onFinished?.();
  };
  app.addHook('onRequest', (request, _reply, next) => {
    inFlight.requests.add(request.raw);
    next();
  });
  app.addHook('onResponse', (request, _reply, next) => {
    finished(request.raw);
    next();
  });
  app.addHook('onRequestAbort', (request, next) => {
    finished(request.raw);
    next();
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    if (inFlight.closing) void reply.header('connection', 'close');
    return payload;
  });
  app.addHook('preClose', (done) => {
    inFlight.closing = true;
    done();
  });
  return inFlight;
}

/**
 * A request that reaches the router once shutdown has begun (one whose
 * headers were still arriving, or one on another server of a multi-address
 * bind, whose idle sockets Fastify leaves open) is turned away with 503 rather
 * than run against stores about to close. After the security guard, so the
 * answer carries its headers and a foreign Host still gets 403; the onSend
 * hook above adds `Connection: close`.
 */
function refuseWhileClosing(app: LanternApp, inFlight: InFlight): void {
  app.addHook('onRequest', async (_request, reply) => {
    if (!inFlight.closing) return undefined;
    return sendError(
      reply,
      503,
      ErrorCodes.unavailable,
      'Lantern is shutting down; try again once it is back.',
    );
  });
}

/**
 * How long shutdown waits for requests still being answered before it ends
 * their sockets: a restart that one slow request held open indefinitely is a
 * daemon that stays down.
 */
export const CLOSE_BACKSTOP_MS = 10_000;

/**
 * `app.close()`, then until every request in flight on any of its servers has
 * been answered, bounded: after the backstop, their connections are ended, not
 * waited on.
 */
export async function closeApp(app: LanternApp, backstopMs = CLOSE_BACKSTOP_MS): Promise<void> {
  const inFlight = IN_FLIGHT.get(app);
  let expired = false;
  const backstop = setTimeout(() => {
    expired = true;
    app.log.warn(
      { event: 'shutdown.backstop', afterMs: backstopMs },
      'Requests were still open when shutdown stopped waiting; ending their connections',
    );
    app.server.closeAllConnections();
    // Requests on the other servers of a multi-address bind, which app.server
    // does not reach. An injected request's socket is a stand-in without destroy.
    for (const request of inFlight?.requests ?? []) {
      (request.socket as Partial<Socket>).destroy?.();
    }
    inFlight?.onFinished?.();
  }, backstopMs);
  backstop.unref();
  try {
    await app.close();
    if (inFlight !== undefined) {
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (expired || inFlight.requests.size === 0) {
            inFlight.onFinished = null;
            resolve();
          }
        };
        inFlight.onFinished = check;
        check();
      });
    }
  } finally {
    clearTimeout(backstop);
  }
}
