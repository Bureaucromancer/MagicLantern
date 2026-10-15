// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Web-page attack defences (SK7, A29), as one guard run on every request
 * including static files and not-found answers: a root `onRequest` hook, and
 * app.ts's `frameworkErrors` handler for the requests the router refuses
 * before any hook runs (a malformed percent-escape in the path).
 *
 * - **Headers** on every answer, refusals included: `nosniff`, `DENY` framing,
 *   and `Cache-Control: no-store` (static.ts replaces it for app files), so a
 *   shared cache never replays a cookie-gated answer to another client.
 * - **Host** allowlist, from the raw `headers.host` hostname (trustProxy off),
 *   which stops DNS rebinding: loopback names, the bind host if specific; when
 *   bound to a wildcard also every local interface address, `os.hostname()`
 *   and `<hostname>.local`; plus `allowedHosts`. Refused: 403 `forbidden-host`.
 * - **Origin**, when present (`null` counts as foreign), must be
 *   `http(s)://<allowed host>:<listen port>` (or the default-port form) or in
 *   `allowedOrigins`. Absent is allowed unless `Sec-Fetch-Site: cross-site`.
 *   Refused: 403 `forbidden-origin`.
 * - **JSON only**: POST/PUT/PATCH/DELETE with a body must be
 *   `application/json` (415); bodiless requests pass. A text/plain POST is a
 *   CORS "simple request" that no preflight stops, so this is what keeps a
 *   cross-site form from reaching a handler. The one exception is a route
 *   marked `config: { multipart: true }` (uploads), which takes
 *   `multipart/form-data` instead. That is a simple request too, so for it
 *   the Origin check above is the defence: browsers send Origin on every
 *   cross-site POST, and a foreign one is refused before the body is read.
 *
 * Also the loopback guard's predicates, which the serve command applies
 * before anything listens.
 */

import { isIP } from 'node:net';
import { hostname as osHostname, networkInterfaces } from 'node:os';

import { ErrorCodes, type AuthMode } from '@bureaucromancer/lantern-schema';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ResolvedConfig } from '../config/schema.js';
import { sendError } from './errors.js';
import type { LanternApp } from './types.js';

/** The machine's own names, for a wildcard bind. A seam so tests need no real interfaces. */
export interface MachineNames {
  hostname(): string;
  interfaceAddresses(): readonly string[];
}

export const OS_MACHINE: MachineNames = {
  hostname: () => osHostname(),
  interfaceAddresses: () =>
    Object.values(networkInterfaces()).flatMap((list) =>
      (list ?? []).map((entry) => entry.address),
    ),
};

export interface SecurityOptions {
  readonly config: Pick<ResolvedConfig, 'host' | 'allowedHosts' | 'allowedOrigins'>;
  /** The port actually bound, which allowed Origins must carry. Superseded by the listening socket's. */
  readonly listenPort: number;
  readonly machine?: MachineNames;
}

/** 127.0.0.0/8 as an IPv4-mapped IPv6 address, canonical form (`::ffff:127.0.0.1` → `::ffff:7f00:1`). */
const MAPPED_LOOPBACK = /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/;

/**
 * The one definition of "is this bind loopback": `localhost`, `::1` and
 * 127.0.0.0/8, however an address is spelled (`[::1]`, `0:0:0:0:0:0:0:1`,
 * `::ffff:127.0.0.1`). Wildcards (`0.0.0.0`, `::`) and names are not: a name
 * may resolve anywhere, so it counts as exposed.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = normalizeHostname(host);
  if (bare === 'localhost' || bare === '::1' || MAPPED_LOOPBACK.test(bare)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** Binds that listen on every interface (`::ffff:0.0.0.0` is every IPv4 one). */
export function isWildcardHost(host: string): boolean {
  const bare = normalizeHostname(host);
  return bare === '0.0.0.0' || bare === '::' || bare === '::ffff:0:0' || bare === '';
}

/**
 * Lowercase, brackets and one trailing dot removed, and an IPv6 address in its
 * canonical form so that every spelling of one address compares equal:
 * `[::1]` and `0:0:0:0:0:0:0:1` → `::1`, `::0` → `::`, `LocalHost.` → `localhost`.
 */
export function normalizeHostname(name: string): string {
  let bare = name.trim().toLowerCase();
  if (bare.startsWith('[') && bare.endsWith(']')) bare = bare.slice(1, -1);
  if (bare.endsWith('.')) bare = bare.slice(0, -1);
  if (isIP(bare) === 6) {
    try {
      // The WHATWG serialisation: compressed, lowercase, IPv4 tails in hex.
      bare = new URL(`http://[${bare}]`).hostname.slice(1, -1);
    } catch {
      // A zone id (`fe80::1%en0`) is no URL host; it stays as written.
    }
  }
  return bare;
}

/** The hostname a raw Host header names, or null when it is missing or malformed. */
export function hostnameOfHostHeader(header: string | undefined): string | null {
  if (header === undefined || header === '') return null;
  let host: string;
  let rest: string;
  if (header.startsWith('[')) {
    const close = header.indexOf(']');
    if (close === -1) return null;
    host = header.slice(0, close + 1);
    rest = header.slice(close + 1);
  } else {
    const colon = header.indexOf(':');
    host = colon === -1 ? header : header.slice(0, colon);
    rest = colon === -1 ? '' : header.slice(colon);
  }
  if (rest !== '' && !/^:\d{1,5}$/.test(rest)) return null;
  const bare = normalizeHostname(host);
  return bare === '' ? null : bare;
}

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '::1'];

/** Every hostname this daemon answers to (lowercase, unbracketed). */
export function allowedHostnames(
  config: SecurityOptions['config'],
  machine: MachineNames,
): Set<string> {
  const names = new Set(LOOPBACK_NAMES);
  if (isWildcardHost(config.host)) {
    for (const address of machine.interfaceAddresses()) names.add(normalizeHostname(address));
    const own = normalizeHostname(machine.hostname());
    if (own !== '') {
      names.add(own);
      // macOS reports `name.local` while other systems report `name`; accept both spellings.
      names.add(own.endsWith('.local') ? own.slice(0, -'.local'.length) : `${own}.local`);
    }
  } else {
    names.add(normalizeHostname(config.host));
  }
  for (const extra of config.allowedHosts) names.add(normalizeHostname(extra));
  return names;
}

function hostInUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

/** Same-origin pages on each allowed host and port, plus `allowedOrigins`, lowercased. */
export function allowedOriginSet(
  hosts: Iterable<string>,
  port: number,
  extra: readonly string[],
): Set<string> {
  const origins = new Set<string>();
  for (const host of hosts) {
    const name = hostInUrl(host);
    origins.add(`http://${name}:${String(port)}`);
    origins.add(`https://${name}:${String(port)}`);
    // A browser omits the scheme's default port from the Origin it sends.
    if (port === 80) origins.add(`http://${name}`);
    if (port === 443) origins.add(`https://${name}`);
  }
  for (const origin of extra) origins.add(origin.toLowerCase().replace(/\/$/, ''));
  return origins;
}

/** Methods that never change anything and so carry no body we parse. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

/** Whether a request has a body, by Fastify's own rule (content-length or chunked). */
export function hasBody(headers: FastifyRequest['headers']): boolean {
  const length = headers['content-length'];
  return headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
}

function mediaTypeOf(header: string | undefined): string | null {
  if (header === undefined) return null;
  const [mediaType = ''] = header.split(';');
  return mediaType.trim().toLowerCase();
}

/** `application/json`, with or without parameters; nothing else (no `+json` suffixes). */
export function isJsonContentType(header: string | undefined): boolean {
  return mediaTypeOf(header) === 'application/json';
}

/** `multipart/form-data`, with its boundary parameter. */
export function isMultipartContentType(header: string | undefined): boolean {
  return mediaTypeOf(header) === 'multipart/form-data';
}

/** Whether the route the request reached takes uploads (`config: { multipart: true }`). */
function takesMultipart(request: FastifyRequest): boolean {
  return (request.routeOptions.config as { multipart?: boolean } | undefined)?.multipart === true;
}

/**
 * A cross-site top-level navigation: a link to Lantern from another site. It
 * cannot change anything (GET), its response is not readable by the linking
 * page, and the SameSite=Strict cookie is not sent, so refusing it would only
 * break links from dashboards and chat. Frames are not navigations of this kind.
 */
function isTopLevelNavigation(request: FastifyRequest): boolean {
  return (
    (request.method === 'GET' || request.method === 'HEAD') &&
    request.headers['sec-fetch-mode'] === 'navigate' &&
    request.headers['sec-fetch-dest'] === 'document'
  );
}

/** How often a wildcard bind re-reads interface addresses after an unknown Host (DHCP changes). */
const MACHINE_REFRESH_MS = 10_000;

/**
 * The checks every request passes, as one function: it marks the answer with
 * the security headers, then refuses a foreign Host or Origin or a non-JSON
 * body by sending the envelope and returning the reply. `undefined` means the
 * request may go on.
 */
export type SecurityGuard = (
  request: FastifyRequest,
  reply: FastifyReply,
) => FastifyReply | undefined;

export function createSecurityGuard(options: SecurityOptions): SecurityGuard {
  const { config } = options;
  const machine = options.machine ?? OS_MACHINE;
  const wildcard = isWildcardHost(config.host);

  let hosts = allowedHostnames(config, machine);
  let hostsReadAt = Date.now();
  let origins: { port: number; hosts: Set<string>; set: Set<string> } | null = null;

  const hostAllowed = (name: string): boolean => {
    if (hosts.has(name)) return true;
    if (!wildcard || Date.now() - hostsReadAt < MACHINE_REFRESH_MS) return false;
    hosts = allowedHostnames(config, machine);
    hostsReadAt = Date.now();
    return hosts.has(name);
  };

  // The socket's port once listening (config may say 0); the option before (inject).
  const currentPort = (request: FastifyRequest): number => {
    const address = request.server.server.address();
    return typeof address === 'object' && address !== null ? address.port : options.listenPort;
  };

  const originAllowed = (origin: string, port: number): boolean => {
    if (origins?.port !== port || origins.hosts !== hosts) {
      origins = { port, hosts, set: allowedOriginSet(hosts, port, config.allowedOrigins) };
    }
    return origins.set.has(origin.toLowerCase());
  };

  return (request, reply) => {
    // Set first so refusals carry them too: no MIME sniffing, no framing of
    // the app by another page (older browsers send no Sec-Fetch-Dest), and no
    // storing by any cache. @fastify/static's setHeaders replaces the last for
    // app files, which have their own policy (static.ts).
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('x-frame-options', 'DENY');
    void reply.header('cache-control', 'no-store');

    const hostname = hostnameOfHostHeader(request.headers.host);
    if (hostname === null || !hostAllowed(hostname)) {
      request.log.warn(
        { event: 'request.forbidden-host', host: request.headers.host },
        'Refused a request for a host name Lantern does not answer to; add it to allowedHosts if it is yours',
      );
      return sendError(
        reply,
        403,
        ErrorCodes.forbiddenHost,
        'Lantern does not answer to this host name. Add it to allowedHosts if you reach Lantern through it.',
      );
    }

    const origin = request.headers.origin;
    const foreign =
      origin === undefined
        ? request.headers['sec-fetch-site'] === 'cross-site' && !isTopLevelNavigation(request)
        : !originAllowed(origin, currentPort(request));
    if (foreign) {
      request.log.warn(
        { event: 'request.forbidden-origin', origin: origin ?? null },
        'Refused a request from another web page; add its origin to allowedOrigins if it should be allowed',
      );
      return sendError(
        reply,
        403,
        ErrorCodes.forbiddenOrigin,
        'Requests from this web page are not allowed. Add its origin to allowedOrigins if they should be.',
      );
    }

    if (!SAFE_METHODS.has(request.method) && hasBody(request.headers)) {
      const contentType = request.headers['content-type'];
      if (takesMultipart(request)) {
        if (!isMultipartContentType(contentType)) {
          return sendError(
            reply,
            415,
            ErrorCodes.unsupportedMediaType,
            'The body must be multipart/form-data.',
          );
        }
      } else if (!isJsonContentType(contentType)) {
        return sendError(
          reply,
          415,
          ErrorCodes.unsupportedMediaType,
          'The body must be application/json.',
        );
      }
    }
    return undefined;
  };
}

/** The guard as a root `onRequest` hook, so it runs before every route, plugin hook and the not-found handler. */
export function registerSecurityHooks(app: LanternApp, guard: SecurityGuard): void {
  app.addHook('onRequest', async (request, reply) => guard(request, reply));
}

/** What the loopback guard decides about a bind, before anything listens. */
export type ExposureVerdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'refuse'; readonly message: string }
  | { readonly kind: 'warn'; readonly message: string };

/**
 * The loopback guard (SK7): a bind beyond loopback with auth mode none is
 * refused unless `auth.trustNetwork`, which then warns on every start with
 * the fact in the sentence itself (a person scanning logs reads messages, not
 * fields).
 */
export function checkExposure(input: {
  readonly host: string;
  readonly mode: AuthMode;
  readonly trustNetwork: boolean;
}): ExposureVerdict {
  const { host, mode, trustNetwork } = input;
  if (isLoopbackHost(host) || mode === 'password') return { kind: 'ok' };

  if (trustNetwork) {
    return {
      kind: 'warn',
      message: `Listening on ${host} with no password because auth.trustNetwork is set: anyone who can reach this port can use Lantern.`,
    };
  }

  const name = isIP(normalizeHostname(host)) === 0 && !isWildcardHost(host);
  return {
    kind: 'refuse',
    message:
      `Refusing to listen on ${host}${name ? ' (a host name counts as beyond this machine)' : ''}: ` +
      'it is reachable beyond this machine and auth mode is none, so anyone who can reach the port could use Lantern. ' +
      'Set a password with `lantern set-password`, bind to 127.0.0.1, or set auth.trustNetwork ' +
      '(LANTERN_TRUST_NETWORK=1) on a network you trust.',
  };
}
