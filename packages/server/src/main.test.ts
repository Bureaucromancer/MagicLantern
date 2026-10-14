// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The `lantern` executable as a person runs it: argv, stdin, exit codes, and
 * whether it started a server at all. A real child process, because none of
 * those are the same thing in-process.
 *
 * The child gets an explicit environment, never this process's: a variable
 * leaking in from the machine running the tests is how a suite goes red on CI
 * only.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tempRoot } from './test-app.js';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = join(PACKAGE_DIR, 'src', 'main.ts');
const VERSION = (
  JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { version: string }
).version;

let root: string;
let dataDir: string;
let configPath: string;

beforeEach(async () => {
  root = await tempRoot('lantern-cli-');
  dataDir = join(root, 'data');
  configPath = join(root, 'lantern.json');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { HOME: root, ...extra };
  for (const name of ['PATH', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function spawnLantern(
  argv: string[],
  env: Record<string, string> = {},
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['--import', 'tsx', ENTRY, ...argv], {
    cwd: PACKAGE_DIR,
    env: childEnv(env),
    stdio: 'pipe',
  });
}

interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs to completion, feeding stdin; anything still running after 10 s is a failure. */
async function run(
  argv: string[],
  options: { env?: Record<string, string>; stdin?: string } = {},
): Promise<Result> {
  const child = spawnLantern(argv, options.env);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin.end(options.stdin ?? '');
  return await new Promise<Result>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`lantern ${argv.join(' ')} did not exit:\n${stdout}\n${stderr}`));
    }, 10_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Starts serve and waits for the listening line; returns the child and its port. */
async function serve(
  argv: string[],
  env: Record<string, string> = {},
): Promise<{
  child: ChildProcessWithoutNullStreams;
  port: number;
  lines: Record<string, unknown>[];
}> {
  const child = spawnLantern(['serve', ...argv], { LANTERN_PORT: '0', ...env });
  const lines: Record<string, unknown>[] = [];
  let pending = '';
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`no listening line:\n${stderr}`));
    }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      for (const part of parts) {
        const line = JSON.parse(part) as Record<string, unknown>;
        lines.push(line);
        if (line['event'] === 'listening') {
          clearTimeout(timer);
          resolve(Number(new URL(String(line['address'])).port));
        }
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${String(code)} before listening:\n${stderr}`));
    });
  });
  return { child, port, lines };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits for a condition, polling; a failure after 10 s. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await delay(10);
  }
}

function exited(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.on('exit', resolve);
  });
}

/** A usage error is one sentence: no stack frames. */
function expectNoStack(stderr: string): void {
  expect(stderr).not.toMatch(/^\s+at /m);
}

describe('lantern --help and --version', () => {
  it('prints usage and exits 0', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: lantern [command] [options]');
    expect(result.stdout).toContain('set-password');
  });

  it('prints the version and exits 0', async () => {
    const result = await run(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${VERSION}\n`);
  });
});

describe('a bad command line', () => {
  it.each([
    [['--data', 'a', '--data', 'b'], '--data was given more than once.'],
    [['serve', '--data'], '--data needs a value.'],
    [['--data', '--config', 'x'], '--data needs a value.'],
    [['launch'], 'Unknown command "launch". Run `lantern --help` for usage.'],
  ])('refuses %j in one sentence, without starting', async (argv, message) => {
    const result = await run(argv);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`${message}\n`);
    expect(result.stdout).toBe('');
  });
});

describe('bad configuration', () => {
  it('names the environment variable', async () => {
    const result = await run(['--config', configPath, '--data', dataDir], {
      env: { LANTERN_PORT: 'x' },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('the environment is not valid: LANTERN_PORT must be integer\n');
  });

  it('names the file and the key', async () => {
    await writeFile(configPath, JSON.stringify({ auth: { mode: 'open' } }));
    const result = await run(['--config', configPath, '--data', dataDir]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `${configPath} is not valid: auth.mode must be "none", "password" or null\n`,
    );
  });

  it('names a file that is not JSON', async () => {
    await writeFile(configPath, '{ "port": ');
    const result = await run(['--config', configPath, '--data', dataDir]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${configPath} is not valid: it is not JSON`);
    expectNoStack(result.stderr);
  });

  it('refuses a data directory it cannot use, in one sentence', async () => {
    await writeFile(join(root, 'a-file'), '');
    const result = await run(['--config', configPath, '--data', join(root, 'a-file', 'data')]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('cannot be created or written');
    expectNoStack(result.stderr);
  });
});

describe('the loopback guard', () => {
  it('refuses a wildcard bind with no password, before touching the data directory', async () => {
    const result = await run(['--config', configPath, '--data', dataDir], {
      env: { LANTERN_HOST: '0.0.0.0' },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      /^Refusing to listen on 0\.0\.0\.0: it is reachable beyond this machine/,
    );
    expect(result.stdout).not.toContain('listening');
    expect(existsSync(dataDir)).toBe(false);
  });

  it('refuses password mode until a password is set', async () => {
    const result = await run(['--config', configPath, '--data', dataDir], {
      env: { LANTERN_AUTH_MODE: 'password' },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Run `lantern set-password`');
  });
});

describe('lantern serve', () => {
  it('serves, and stops on SIGTERM with 0', async () => {
    const { child, port, lines } = await serve(['--config', configPath, '--data', dataDir]);
    try {
      const health = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
      expect(await health.json()).toEqual({ status: 'ok' });
      const info = await fetch(`http://127.0.0.1:${String(port)}/api/v1/info`);
      expect(await info.json()).toEqual({ name: 'lantern', version: VERSION, apiVersion: 'v1' });
      expect(lines.some((line) => line['event'] === 'open')).toBe(true);
    } finally {
      if (process.platform === 'win32') child.kill();
      else child.kill('SIGTERM');
    }
    const code = await exited(child);
    // Windows has no SIGTERM handler path: kill() ends the process outright.
    if (process.platform !== 'win32') expect(code).toBe(0);
  });

  // Ctrl-C under `pnpm start` or `pnpm dev` reaches the daemon twice (the
  // terminal's and the runner's relay), and a supervisor may repeat SIGTERM.
  // Neither copy may kill it before the stores close and the lease is released.
  // Windows has no SIGTERM handler path: kill() ends the process outright.
  it.skipIf(process.platform === 'win32')(
    'finishes its shutdown when signals repeat while it is stopping',
    async () => {
      const { child, port, lines } = await serve(['--config', configPath, '--data', dataDir]);
      const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
      const seen = (key: string, value: string) => () => lines.some((line) => line[key] === value);
      // A request still being sent holds the shutdown open until it ends.
      const held = connect(port, '127.0.0.1');
      try {
        await new Promise((resolve) => held.once('connect', resolve));
        held.write(
          `POST /api/v1/session HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n` +
            'Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{"pass',
        );
        await until(seen('msg', 'incoming request'));

        child.kill('SIGTERM');
        await until(seen('event', 'shutdown'));
        child.kill('SIGTERM');
        await delay(10);
        child.kill('SIGINT');
        child.kill('SIGINT');
        await delay(100);
        expect(seen('event', 'stopped')()).toBe(false);
      } finally {
        held.destroy();
      }
      expect(await closed).toBe(0);
      expect(lines.at(-1)).toMatchObject({ event: 'stopped' });
    },
  );

  it('refuses a second daemon on the same data directory', async () => {
    const { child } = await serve(['--config', configPath, '--data', dataDir]);
    try {
      const second = await run(['--config', configPath, '--data', dataDir], {
        env: { LANTERN_PORT: '0' },
      });
      expect(second.code).toBe(1);
      expect(second.stderr).toContain(dataDir);
      expectNoStack(second.stderr);

      // set-password takes the same lock, so it cannot change the record under a running daemon.
      const setPassword = await run(['set-password', '--config', configPath, '--data', dataDir], {
        stdin: 'pw\n',
      });
      expect(setPassword.code).toBe(1);
    } finally {
      child.kill('SIGTERM');
      await exited(child);
    }
  });
});

describe('lantern set-password', () => {
  it('sets a password from a pipe, which the next serve then asks for', async () => {
    const result = await run(['set-password', '--config', configPath, '--data', dataDir], {
      stdin: 'hunter2\n',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Set the Lantern password');

    const { child, port } = await serve(['--config', configPath, '--data', dataDir]);
    try {
      const base = `http://127.0.0.1:${String(port)}`;
      expect((await fetch(`${base}/api/v1/info`)).status).toBe(401);
      const login = await fetch(`${base}/api/v1/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ password: 'hunter2' }),
      });
      expect(login.status).toBe(204);
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      expect((await fetch(`${base}/api/v1/info`, { headers: { cookie } })).status).toBe(200);
    } finally {
      child.kill('SIGTERM');
      await exited(child);
    }
  });

  // `docker exec -i` or a script may write the line and keep the pipe open;
  // the process must still end when its work is done, not at the 5 s backstop.
  it('exits promptly when the pipe stays open after the password', async () => {
    const child = spawnLantern(['set-password', '--config', configPath, '--data', dataDir]);
    let stdout = '';
    let saidAt = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (saidAt === 0 && stdout.includes('Set the Lantern password')) saidAt = Date.now();
    });
    // `close`, not `exit`: by then stdout has been read to the end.
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
    child.stdin.write('hunter2\n');
    try {
      expect(await closed).toBe(0);
      expect(saidAt).toBeGreaterThan(0);
      expect(Date.now() - saidAt).toBeLessThan(2_000);
    } finally {
      child.stdin.destroy();
      child.kill('SIGKILL');
    }
  });

  it('refuses a pipe that closes without a password', async () => {
    const result = await run(['set-password', '--config', configPath, '--data', dataDir], {
      stdin: '',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('No password was given. Nothing was changed.\n');
  });

  it('never takes the password as an argument', async () => {
    const result = await run(['set-password', 'hunter2', '--data', dataDir]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Too many arguments');
  });
});

describe('LANTERN_PASSWORD', () => {
  it('stores the password from the environment and starts in password mode', async () => {
    const { child, lines } = await serve(['--config', configPath, '--data', dataDir], {
      LANTERN_PASSWORD: 'from-env',
    });
    try {
      expect(lines.find((line) => line['event'] === 'auth.mode')).toMatchObject({
        mode: 'password',
      });
      expect(lines.some((line) => line['event'] === 'auth.env-password')).toBe(true);
    } finally {
      child.kill('SIGTERM');
      await exited(child);
    }
  });
});
