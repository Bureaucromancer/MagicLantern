// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Starts the built daemon for end-to-end tests: `lantern serve` from
 * packages/server/dist, serving packages/app/dist, on a loopback port it picks
 * itself, with a fresh data directory and config file that are removed
 * afterwards. Nothing from the developer's own setup reaches it: LANTERN_*
 * variables are dropped and the config is passed explicitly.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SERVER_MAIN = join(REPO, 'packages', 'server', 'dist', 'main.js');
const APP_ROOT = join(REPO, 'packages', 'app', 'dist');

/** Generous: a cold start migrates a new install database and creates the first library. */
const STARTUP_TIMEOUT_MS = 20_000;
/** One /healthz probe. Bounded, so a probe that hangs cannot outlive the startup deadline. */
const PROBE_TIMEOUT_MS = 1_000;
/** The daemon's own shutdown backstop is 10 s; past that it is stuck. */
const STOP_TIMEOUT_MS = 12_000;

/**
 * Long enough for a start that fails at its deadline and then stops the daemon,
 * so the harness's own error, with the daemon's output, is what a run reports.
 * For a Playwright fixture's `timeout`, which otherwise shares the test's.
 */
export const DAEMON_FIXTURE_TIMEOUT_MS =
  STARTUP_TIMEOUT_MS + PROBE_TIMEOUT_MS + STOP_TIMEOUT_MS + 5_000;

export interface Daemon {
  /** e.g. `http://127.0.0.1:53124`. */
  readonly url: string;
  /** Everything the daemon has printed so far, for a failure report. */
  output(): string;
  /** Stops the daemon and removes its data directory. Safe to call twice. */
  stop(): Promise<void>;
}

/**
 * The address the daemon announced in its `listening` log line, once it has
 * printed it. The daemon binds port 0 and reports what it got, so no port is
 * chosen here and then lost to another process before the daemon binds it.
 */
function announcedAddress(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // Not a log line, or the last one only partly written.
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const { event, address } = entry as Record<string, unknown>;
    if (event === 'listening' && typeof address === 'string') return address;
  }
  return undefined;
}

/** This process's environment minus LANTERN_*, so a developer's password or data dir cannot leak in. */
function daemonEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('LANTERN_')),
  );
}

export async function startDaemon(): Promise<Daemon> {
  for (const [path, what] of [
    [SERVER_MAIN, 'the daemon'],
    [join(APP_ROOT, 'index.html'), 'the app'],
  ] as const) {
    if (!existsSync(path)) {
      throw new Error(`${path} does not exist. Build ${what} first: pnpm build.`);
    }
  }

  const root = await realpath(await mkdtemp(join(tmpdir(), 'lantern-e2e-')));
  const dataDir = join(root, 'data');
  const configPath = join(root, 'lantern.json');
  await mkdir(dataDir);
  await writeFile(
    configPath,
    `${JSON.stringify({ host: '127.0.0.1', port: 0, appRoot: APP_ROOT, log: { level: 'info' } }, null, 2)}\n`,
  );

  const child = spawn(
    process.execPath,
    [SERVER_MAIN, 'serve', '--data', dataDir, '--config', configPath],
    { cwd: REPO, env: daemonEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    output += text;
    stdout += text;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
  const running = (): boolean => child.exitCode === null && child.signalCode === null;

  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopped ??= (async () => {
      if (running()) {
        child.kill('SIGTERM');
        const backstop = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
        await exited;
        clearTimeout(backstop);
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    })());

  let url: string | undefined;
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  try {
    for (;;) {
      if (!running()) {
        throw new Error(`The daemon exited before it answered /healthz. Its output:\n${output}`);
      }
      url ??= announcedAddress(stdout);
      if (url !== undefined) {
        try {
          const response = await fetch(`${url}/healthz`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          await response.body?.cancel();
          if (response.ok) break;
        } catch {
          // Not answering yet, or this probe timed out; the deadline decides.
        }
      }
      if (Date.now() > deadline) {
        throw new Error(
          `The daemon did not answer /healthz within ${String(STARTUP_TIMEOUT_MS)} ms. Its output:\n${output}`,
        );
      }
      await delay(100);
    }
  } catch (failure) {
    await stop();
    throw failure;
  }

  return { url, output: () => output, stop };
}
