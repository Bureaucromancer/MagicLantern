// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `lantern serve` in-process, over a real loopback socket, with the store
 * replaced by a recorder: what is under test is the command's own order of
 * operations (config, guard, lock, stores, app, listen, shutdown), not the
 * databases. main.test.ts runs the real thing as a child process.
 */

import { EventEmitter } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loggerOptions } from '../../logging.js';
import type { InstallStore } from '../../store/types.js';
import { captureLog, tempRoot, testConfig } from '../../test-app.js';
import { UsageError, type CommandContext, type SignalSource } from '../args.js';
import { createServeCommand, logStartup, type ServeOptions, type ServeStore } from './serve.js';

/** Whether this machine can bind ::1 at all (some CI containers have no IPv6). */
const IPV6_LOOPBACK = await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once('error', () => {
    resolve(false);
  });
  probe.listen(0, '::1', () => {
    probe.close(() => {
      resolve(true);
    });
  });
});

let root: string;

beforeEach(async () => {
  root = await tempRoot('lantern-serve-');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Records every store call in order. */
function recordingStore(events: string[], overrides: Partial<ServeStore> = {}): ServeStore {
  return {
    acquireInstanceLock: () => {
      events.push('lock');
      return { release: () => events.push('release lock') };
    },
    readMachineBootId: () => Promise.resolve('boot-id'),
    openInstallStore: (_dataDir, { boot, log }) => {
      events.push(`open install as ${boot.processId.slice(0, 5)}`);
      log.info('Opened the install database.', { schemaVersion: 1 });
      const install: InstallStore = {
        db: undefined as unknown as InstallStore['db'],
        schemaVersion: 1,
        heartbeat: () => events.push('heartbeat'),
        close: () => events.push('close install'),
      };
      return Promise.resolve(install);
    },
    openLibraryRegistry: () => {
      events.push('open libraries');
      return Promise.resolve({
        list: () => [],
        get: () => undefined,
        close: () => events.push('close libraries'),
      });
    },
    ...overrides,
  };
}

interface Running {
  readonly done: Promise<number>;
  readonly lines: Record<string, unknown>[];
  readonly stderr: string[];
  readonly signals: TestSignals;
  /** The first log record with this event, waiting for it if needed. */
  line(event: string): Promise<Record<string, unknown>>;
}

/** Signals the test emits; `kill` records the force quit instead of sending anything. */
type TestSignals = EventEmitter &
  SignalSource & { readonly killed: [pid: number, signal: 'SIGINT' | 'SIGTERM'][] };

function testSignals(): TestSignals {
  const killed: TestSignals['killed'] = [];
  return Object.assign(new EventEmitter(), {
    killed,
    kill: (pid: number, signal: 'SIGINT' | 'SIGTERM') => killed.push([pid, signal]),
  });
}

function start(
  env: Record<string, string>,
  store: ServeStore,
  options: Omit<ServeOptions, 'store'> = {},
): Running {
  const lines: Record<string, unknown>[] = [];
  const stderr: string[] = [];
  let pending = '';
  const stdout = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      pending += chunk.toString();
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      for (const part of parts) lines.push(JSON.parse(part) as Record<string, unknown>);
      callback();
    },
  });
  const signals = testSignals();
  const context: CommandContext = {
    args: {
      command: 'serve',
      configPath: join(root, 'lantern.json'),
      dataDir: join(root, 'data'),
      clear: false,
    },
    env: { LANTERN_PORT: '0', ...env },
    pid: 4242,
    platform: process.platform,
    homedir: root,
    cwd: root,
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stdout,
    stderr: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        stderr.push(chunk.toString());
        callback();
      },
    }),
    signals,
  };
  const done = createServeCommand({
    store,
    closeBackstopMs: 1_000,
    // Whether the workspace happens to have a built app must not change these tests.
    detectedAppRoot: join(root, 'no-app-here'),
    ...options,
  })(context);
  return {
    done,
    lines,
    stderr,
    signals,
    async line(event) {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const found = lines.find((record) => record['event'] === event);
        if (found !== undefined) return found;
        if (Date.now() > deadline)
          throw new Error(
            `no ${event} line; saw ${lines.map((r) => String(r['event'])).join(', ')}`,
          );
        await Promise.race([
          done.then(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 10)),
        ]);
      }
    },
  };
}

function portOf(record: Record<string, unknown>): number {
  return Number(new URL(String(record['address'])).port);
}

describe('lantern serve', () => {
  it('starts in the contract’s order, answers, and stops on SIGTERM with 0', async () => {
    const events: string[] = [];
    const running = start({}, recordingStore(events));
    const listening = await running.line('listening');
    const port = portOf(listening);
    expect(listening['msg']).toBe(
      `Lantern ${String(listening['version'])} is listening on http://127.0.0.1:${String(port)}`,
    );

    const health = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    running.signals.emit('SIGTERM');
    expect(await running.done).toBe(0);
    expect(events).toEqual([
      'lock',
      'open install as proc_',
      'open libraries',
      'close libraries',
      'close install',
      'release lock',
    ]);
    await expect(fetch(`http://127.0.0.1:${String(port)}/healthz`)).rejects.toThrow();
    expect(running.lines.at(-1)).toMatchObject({ event: 'stopped', msg: 'Stopped' });
  });

  it('serves the development model catalog only with LANTERN_DEV=1, and says so', async () => {
    const dev = start({ LANTERN_DEV: '1' }, recordingStore([]));
    expect(await dev.line('dev-mode')).toMatchObject({ level: 40, models: ['mdl_dev_sdxl'] });
    dev.signals.emit('SIGTERM');
    expect(await dev.done).toBe(0);

    const plain = start({}, recordingStore([]));
    await plain.line('listening');
    plain.signals.emit('SIGTERM');
    expect(await plain.done).toBe(0);
    expect(plain.lines.some((record) => record['event'] === 'dev-mode')).toBe(false);
  });

  it('stops once however many signals arrive', async () => {
    const events: string[] = [];
    const running = start({}, recordingStore(events));
    await running.line('listening');
    running.signals.emit('SIGINT');
    running.signals.emit('SIGTERM');
    expect(await running.done).toBe(0);
    expect(events.filter((event) => event === 'release lock')).toHaveLength(1);
    expect(running.lines.filter((line) => line['event'] === 'shutdown')).toHaveLength(1);
  });

  describe('a repeated signal during shutdown', () => {
    // A runner in the terminal's process group (`pnpm start`, `tsx watch`)
    // relays Ctrl-C, so the daemon gets it twice. With no handler left, the
    // copy would get the default action and kill it before the stores close.
    it('keeps the handlers installed, and ignores a copy that arrives with the first', async () => {
      const events: string[] = [];
      const running = start({}, recordingStore(events));
      await running.line('listening');
      running.signals.emit('SIGINT');
      expect(running.signals.listenerCount('SIGINT')).toBe(1);
      expect(running.signals.listenerCount('SIGTERM')).toBe(1);
      running.signals.emit('SIGINT');
      running.signals.emit('SIGTERM');
      expect(await running.done).toBe(0);
      expect(running.signals.killed).toEqual([]);
      expect(events.filter((event) => event === 'close install')).toHaveLength(1);
      expect(running.lines.at(-1)).toMatchObject({ event: 'stopped' });
      // Removed once the stop is over, so nothing outlives the command.
      expect(running.signals.listenerCount('SIGINT')).toBe(0);
      expect(running.signals.listenerCount('SIGTERM')).toBe(0);
    });

    it('takes a later SIGINT as a second Ctrl-C, and quits', async () => {
      const running = start({}, recordingStore([]), { signalRepeatGraceMs: 0 });
      await running.line('listening');
      running.signals.emit('SIGINT');
      running.signals.emit('SIGINT');
      // Re-raised with the handlers gone, so the default action ends the process.
      expect(running.signals.killed).toEqual([[4242, 'SIGINT']]);
      expect(running.signals.listenerCount('SIGINT')).toBe(0);
      expect(await running.line('shutdown.forced')).toMatchObject({ level: 40 });
      await running.done;
    });

    it('ignores a later SIGTERM, keeping the exit code the first signal set', async () => {
      const running = start({}, recordingStore([]), { signalRepeatGraceMs: 0 });
      await running.line('listening');
      running.signals.emit('SIGTERM');
      running.signals.emit('SIGTERM');
      expect(await running.done).toBe(0);
      expect(running.signals.killed).toEqual([]);
      expect(running.lines.find((line) => line['event'] === 'shutdown.repeated')).toMatchObject({
        level: 30,
        signal: 'SIGTERM',
      });
    });
  });

  it('logs store lines from before the logger existed, through the logger', async () => {
    const running = start({}, recordingStore([]));
    await running.line('listening');
    expect(
      running.lines.find((line) => line['msg'] === 'Opened the install database.'),
    ).toMatchObject({
      level: 30,
      schemaVersion: 1,
    });
    running.signals.emit('SIGTERM');
    await running.done;
  });

  it('refreshes the lease heartbeat until it stops', async () => {
    const events: string[] = [];
    const running = start({}, recordingStore(events), { heartbeatMs: 20 });
    await running.line('listening');
    await new Promise((resolve) => setTimeout(resolve, 100));
    running.signals.emit('SIGTERM');
    await running.done;
    const beats = events.filter((event) => event === 'heartbeat').length;
    expect(beats).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events.filter((event) => event === 'heartbeat')).toHaveLength(beats);
  });

  // listen() would look the bracketed form up as a name and fail, after the
  // data directory was already set up, blaming an address of this machine.
  it.skipIf(!IPV6_LOOPBACK)('listens on an IPv6 loopback written in brackets', async () => {
    const running = start({ LANTERN_HOST: '[::1]' }, recordingStore([]));
    const listening = await running.line('listening');
    const port = portOf(listening);
    expect(listening['address']).toBe(`http://[::1]:${String(port)}`);
    expect((await fetch(`http://[::1]:${String(port)}/healthz`)).status).toBe(200);
    running.signals.emit('SIGTERM');
    expect(await running.done).toBe(0);
  });

  it('accepts its own Origin on the port it actually bound', async () => {
    const running = start({}, recordingStore([]));
    const port = portOf(await running.line('listening'));
    const own = await fetch(`http://127.0.0.1:${String(port)}/api/v1/session`, {
      headers: { origin: `http://127.0.0.1:${String(port)}` },
    });
    expect(own.status).toBe(200);
    const configured = await fetch(`http://127.0.0.1:${String(port)}/api/v1/session`, {
      headers: { origin: 'http://127.0.0.1:7600' },
    });
    expect(configured.status).toBe(403);
    running.signals.emit('SIGTERM');
    await running.done;
  });

  describe('the open line', () => {
    it('sends a development run to Vite when the app is not built', async () => {
      const running = start({}, recordingStore([]));
      const open = await running.line('open');
      expect(open['open']).toBe('http://localhost:5173');
      expect(open['msg']).toContain('pnpm dev');
      expect(open['msg']).toContain('http://localhost:5173');
      running.signals.emit('SIGTERM');
      await running.done;
    });

    it("sends a built install to the daemon's own address, which serves the app", async () => {
      const app = join(root, 'app');
      await mkdir(app);
      await writeFile(join(app, 'index.html'), '<!doctype html><title>Lantern</title>');
      const running = start({ LANTERN_APP_ROOT: app }, recordingStore([]));
      const port = portOf(await running.line('listening'));
      const open = await running.line('open');
      expect(open['open']).toBe(`http://127.0.0.1:${String(port)}`);
      const page = await fetch(`http://127.0.0.1:${String(port)}/l/anything/generate`);
      expect(await page.text()).toContain('<title>Lantern</title>');
      running.signals.emit('SIGTERM');
      await running.done;
    });

    // `pnpm dev` after any `pnpm build`: the detected build is stale and has
    // no hot reload, so the line must not send the developer only to it.
    it('names Vite too when a development run serves a build it found', async () => {
      const app = join(root, 'built');
      await mkdir(app);
      await writeFile(join(app, 'index.html'), '<!doctype html><title>Lantern</title>');
      const running = start(
        { LANTERN_ALLOWED_ORIGINS: 'http://localhost:5173' },
        recordingStore([]),
        {
          detectedAppRoot: app,
        },
      );
      const port = portOf(await running.line('listening'));
      const open = await running.line('open');
      expect(open).toMatchObject({
        open: `http://127.0.0.1:${String(port)}`,
        dev: 'http://localhost:5173',
      });
      expect(open['msg']).toBe(
        `Open http://localhost:5173 (\`pnpm dev\`) for the app as you edit it; http://127.0.0.1:${String(port)} serves the build from the last \`pnpm build\``,
      );
      running.signals.emit('SIGTERM');
      await running.done;
    });

    it('names only the daemon when an install serves the build it found', async () => {
      const app = join(root, 'built');
      await mkdir(app);
      await writeFile(join(app, 'index.html'), '<!doctype html><title>Lantern</title>');
      const running = start({}, recordingStore([]), { detectedAppRoot: app });
      const port = portOf(await running.line('listening'));
      const open = await running.line('open');
      expect(open['msg']).toBe(`Open http://127.0.0.1:${String(port)} in a browser to use Lantern`);
      expect(open['dev']).toBeUndefined();
      running.signals.emit('SIGTERM');
      await running.done;
    });
  });

  describe('lease heartbeat', () => {
    // Opening libraries can snapshot and migrate them; a lease left stale
    // meanwhile lets a daemon on another host (beyond the OS lock) take it.
    it('beats while the libraries are still opening', async () => {
      const events: string[] = [];
      const store = recordingStore(events, {
        openLibraryRegistry: async () => {
          events.push('open libraries');
          await new Promise((resolve) => setTimeout(resolve, 150));
          events.push('libraries opened');
          return {
            list: () => [],
            get: () => undefined,
            close: () => events.push('close libraries'),
          };
        },
      });
      const running = start({}, store, { heartbeatMs: 20 });
      await running.line('listening');
      const during = events.slice(
        events.indexOf('open libraries'),
        events.indexOf('libraries opened'),
      );
      expect(during.filter((event) => event === 'heartbeat').length).toBeGreaterThan(0);
      running.signals.emit('SIGTERM');
      await running.done;
      // Stopped before the libraries close: app, heartbeat, libraries, install, lock.
      expect(events.slice(events.indexOf('close libraries'))).toEqual([
        'close libraries',
        'close install',
        'release lock',
      ]);
    });

    it('stops beating when the start fails after the lease is taken', async () => {
      const events: string[] = [];
      const store = recordingStore(events, {
        openLibraryRegistry: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          throw new Error('library.db is newer than this build');
        },
      });
      const running = start({}, store, { heartbeatMs: 10 });
      await expect(running.done).rejects.toThrow('newer than this build');
      const beats = events.filter((event) => event === 'heartbeat').length;
      expect(beats).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events.filter((event) => event === 'heartbeat')).toHaveLength(beats);
    });
  });

  it('says which environment variables overrode the file', async () => {
    await writeFile(
      join(root, 'lantern.json'),
      JSON.stringify({ port: 1, log: { level: 'info' } }),
    );
    const running = start({ LANTERN_LOG_LEVEL: 'info' }, recordingStore([]));
    const line = await running.line('config.environment-overrode-file');
    expect(line['msg']).toBe(
      'The environment overrode the config file for: LANTERN_PORT, LANTERN_LOG_LEVEL',
    );
    running.signals.emit('SIGTERM');
    await running.done;
  });

  describe('refusing to start', () => {
    it('refuses a non-loopback bind with no password before touching anything', async () => {
      const events: string[] = [];
      const running = start({ LANTERN_HOST: '0.0.0.0' }, recordingStore(events));
      const error = await running.done.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toContain('Refusing to listen on 0.0.0.0');
      expect(events).toEqual([]);
    });

    it('refuses password mode with no password', async () => {
      const events: string[] = [];
      const running = start({ LANTERN_AUTH_MODE: 'password' }, recordingStore(events));
      await expect(running.done).rejects.toThrow('lantern set-password');
      expect(events).toEqual([]);
    });

    it('refuses an app root with no build before touching anything', async () => {
      const events: string[] = [];
      const running = start({ LANTERN_APP_ROOT: root }, recordingStore(events));
      await expect(running.done).rejects.toThrow(/^LANTERN_APP_ROOT is not valid/);
      expect(events).toEqual([]);
    });

    it('says a port is taken in one sentence, and closes what it opened', async () => {
      const blocker: Server = createServer();
      await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
      const address = blocker.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      try {
        const events: string[] = [];
        const running = start({ LANTERN_PORT: String(port) }, recordingStore(events));
        const error = await running.done.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(UsageError);
        expect((error as Error).message).toBe(
          `Port ${String(port)} on 127.0.0.1 is already in use. Stop whatever holds it, or choose another port (port in lantern.json, or LANTERN_PORT).`,
        );
        expect(events).toEqual([
          'lock',
          'open install as proc_',
          'open libraries',
          'close libraries',
          'close install',
          'release lock',
        ]);
      } finally {
        await new Promise((resolve) => blocker.close(resolve));
      }
    });

    it('releases the lock when a store fails to open, and prints what the store said', async () => {
      const events: string[] = [];
      const store = recordingStore(events, {
        openLibraryRegistry: () => Promise.reject(new Error('library.db is newer than this build')),
      });
      const running = start({}, store);
      await expect(running.done).rejects.toThrow('newer than this build');
      expect(events).toEqual(['lock', 'open install as proc_', 'close install', 'release lock']);
      expect(running.stderr.join('')).toContain('Opened the install database.');
    });
  });
});

describe('logStartup', () => {
  it('warns on a trusted-network start with the fact in the sentence', async () => {
    const log = captureLog();
    const app = Fastify({ logger: loggerOptions('info', log) });
    logStartup(
      app.log,
      testConfig(root, { host: '0.0.0.0', auth: { trustNetwork: true } }),
      {
        secrets: { sessionKey: 'k'.repeat(43) },
        mode: 'none',
        exposureWarning:
          'Listening on 0.0.0.0 with no password because auth.trustNetwork is set: anyone who can reach this port can use Lantern.',
        envPassword: null,
      },
      { kind: 'api-only', looked: '/x' },
    );
    await app.close();
    const warning = log.records.find((record) => record['event'] === 'auth.trust-network');
    expect(warning).toMatchObject({
      level: 40,
      msg: 'Listening on 0.0.0.0 with no password because auth.trustNetwork is set: anyone who can reach this port can use Lantern.',
    });
  });

  it('names unknown keys and the defaults in prose', async () => {
    const log = captureLog();
    const app = Fastify({ logger: loggerOptions('info', log) });
    const config = testConfig(root);
    logStartup(
      app.log,
      { ...config, provenance: { ...config.provenance, unknownKeys: ['backends', 'auth.proxy'] } },
      {
        secrets: { sessionKey: 'k'.repeat(43) },
        mode: 'none',
        exposureWarning: null,
        envPassword: 'stored',
      },
      { kind: 'served', root: '/srv/app', detected: false },
    );
    await app.close();
    const messages = log.records.map((record) => record['msg']);
    expect(messages).toContain(`No config file at ${config.provenance.path}; using the defaults`);
    expect(messages).toContain(
      'The config has keys this version does not know, which do nothing: backends, auth.proxy',
    );
    expect(messages).toContain('Auth mode: none');
    expect(messages).toContain('Serving the app from /srv/app');
    expect(messages.some((message) => String(message).includes('LANTERN_PASSWORD'))).toBe(true);
  });
});
