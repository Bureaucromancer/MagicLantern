// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  consoleStoreLog,
  deferredStoreLog,
  loggerOptions,
  storeLogFrom,
  type LogDestination,
} from './logging.js';

function collect(): LogDestination & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write(line) {
      lines.push(line);
    },
  };
}

describe('loggerOptions', () => {
  it('is the level alone, or the level and a destination', () => {
    expect(loggerOptions('info')).toEqual({ level: 'info' });
    const destination = collect();
    expect(loggerOptions('warn', destination)).toEqual({ level: 'warn', stream: destination });
  });
});

describe('storeLogFrom', () => {
  it('writes JSON lines at the matching level through the daemon logger', async () => {
    const destination = collect();
    const app = Fastify({ logger: loggerOptions('info', destination) });
    const log = storeLogFrom(app.log);

    log.info('Opened the install database.', { version: 1 });
    log.warn('Library is read-only.');
    log.error('Library is unavailable.', { id: 'lib_x' });
    await app.close();

    const records = destination.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map(({ level, msg }) => [level, msg])).toEqual([
      [30, 'Opened the install database.'],
      [40, 'Library is read-only.'],
      [50, 'Library is unavailable.'],
    ]);
    expect(records[0]).toMatchObject({ version: 1 });
    expect(records[2]).toMatchObject({ id: 'lib_x' });
  });

  it('respects the level', async () => {
    const destination = collect();
    const app = Fastify({ logger: loggerOptions('warn', destination) });
    storeLogFrom(app.log).info('Not shown.');
    await app.close();
    expect(destination.lines).toEqual([]);
  });
});

describe('consoleStoreLog', () => {
  it('prints one sentence per line, with fields as JSON', () => {
    const output = collect();
    const log = consoleStoreLog(output);
    log.info('Migrated lantern.db from version 0 to 1.');
    log.warn('Library "Archive" is read-only.', { reason: 'newer' });
    log.error('Library "Old" is unavailable.', {});
    expect(output.lines).toEqual([
      'Migrated lantern.db from version 0 to 1.\n',
      'Warning: Library "Archive" is read-only. {"reason":"newer"}\n',
      'Error: Library "Old" is unavailable.\n',
    ]);
  });
});

describe('deferredStoreLog', () => {
  it('holds lines until a logger is attached, then forwards everything in order', () => {
    const output = collect();
    const log = deferredStoreLog();
    log.info('Opened lantern.db.', { schemaVersion: 1 });
    log.warn('Library "Archive" is read-only.');
    expect(output.lines).toEqual([]);

    log.attach(consoleStoreLog(output));
    log.error('Library "Old" is unavailable.');
    expect(output.lines).toEqual([
      'Opened lantern.db. {"schemaVersion":1}\n',
      'Warning: Library "Archive" is read-only.\n',
      'Error: Library "Old" is unavailable.\n',
    ]);
  });

  it('hands back held lines once, for a start that failed before the logger existed', () => {
    const output = collect();
    const log = deferredStoreLog();
    log.info('Opened lantern.db.');
    log.drain(consoleStoreLog(output));
    log.drain(consoleStoreLog(output));
    expect(output.lines).toEqual(['Opened lantern.db.\n']);
  });
});
