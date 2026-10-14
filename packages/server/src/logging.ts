// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Logging is Fastify's built-in pino, JSON only (pipe it through a formatter
 * if a terminal wants it pretty). Store code logs through the small
 * {@link StoreLog} interface so it works both inside the daemon and in CLI
 * commands that run without Fastify.
 */

import type { FastifyBaseLogger, FastifyServerOptions } from 'fastify';

import type { LogLevel } from './config/schema.js';
import type { StoreLog } from './store/index.js';

/** Where log lines go; tests pass a destination that collects them. */
export interface LogDestination {
  write(line: string): void;
}

/** Fastify's `logger` option for a level and, optionally, a destination. */
export function loggerOptions(
  level: LogLevel,
  destination?: LogDestination,
): NonNullable<FastifyServerOptions['logger']> {
  return destination === undefined ? { level } : { level, stream: destination };
}

/** Store logging through the daemon's logger, as structured pino lines. */
export function storeLogFrom(logger: FastifyBaseLogger): StoreLog {
  return {
    info: (message, fields) => {
      logger.info(fields ?? {}, message);
    },
    warn: (message, fields) => {
      logger.warn(fields ?? {}, message);
    },
    error: (message, fields) => {
      logger.error(fields ?? {}, message);
    },
  };
}

type StoreLevel = keyof StoreLog;

/** A store log that holds lines until the daemon's logger exists, then forwards to it. */
export interface DeferredStoreLog extends StoreLog {
  /** Replays held lines into `target`, then forwards everything to it. */
  attach(target: StoreLog): void;
  /** Hands back (and forgets) lines never attached, e.g. to print when startup fails first. */
  drain(target: StoreLog): void;
}

/**
 * The serve command opens the stores before it builds the app, and pino comes
 * with the app (it is Fastify's), so store lines from startup wait here and
 * come out through the same logger as everything else.
 */
export function deferredStoreLog(): DeferredStoreLog {
  let target: StoreLog | null = null;
  const held: [StoreLevel, string, Record<string, unknown> | undefined][] = [];
  const replay = (into: StoreLog): void => {
    for (const [level, message, fields] of held.splice(0)) into[level](message, fields);
  };
  const forward =
    (level: StoreLevel) =>
    (message: string, fields?: Record<string, unknown>): void => {
      if (target === null) held.push([level, message, fields]);
      else target[level](message, fields);
    };
  return {
    info: forward('info'),
    warn: forward('warn'),
    error: forward('error'),
    attach(next) {
      target = next;
      replay(next);
    },
    drain(into) {
      replay(into);
    },
  };
}

/**
 * Store logging for CLI commands (`lantern migrate`): one plain line per
 * message, for a person rather than a log pipeline. Fields follow as JSON.
 */
export function consoleStoreLog(output: LogDestination): StoreLog {
  const write = (prefix: string, message: string, fields?: Record<string, unknown>): void => {
    const detail =
      fields === undefined || Object.keys(fields).length === 0 ? '' : ` ${JSON.stringify(fields)}`;
    output.write(`${prefix}${message}${detail}\n`);
  };
  return {
    info: (message, fields) => {
      write('', message, fields);
    },
    warn: (message, fields) => {
      write('Warning: ', message, fields);
    },
    error: (message, fields) => {
      write('Error: ', message, fields);
    },
  };
}
