// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The few things about CI that no product test would notice breaking: a step
 * order the boundary rule depends on, a script renamed in package.json but not
 * in the workflow (which fails only in CI), and the OpenAPI drift check's
 * plumbing. Read as text: a YAML parser at the root to read one file we write
 * is the worse trade, so the scan below throws when it cannot find what it
 * looks for rather than comparing against nothing.
 */

function repoText(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

/** Each step's `run:` value in order, comments dropped; a block scalar reads as its first line. */
function workflowRuns(): string[] {
  const lines = repoText('.github/workflows/ci.yml').split('\n');
  const runs: string[] = [];
  lines.forEach((line, index) => {
    const match = /^\s*(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (match === null) return;
    const value = (match[1] ?? '').trim();
    runs.push(value === '|' ? (lines[index + 1] ?? '').trim() : value);
  });
  if (runs.length === 0) throw new Error('ci.yml has no `run:` steps; has it been restructured?');
  return runs;
}

/** The position of the step running `command`, failing when there is none. */
function stepIndex(runs: readonly string[], command: string): number {
  const index = runs.indexOf(command);
  expect(index, `ci.yml runs \`${command}\``).toBeGreaterThan(-1);
  return index;
}

const rootScripts = (JSON.parse(repoText('package.json')) as { scripts: Record<string, string> })
  .scripts;

describe('CI', () => {
  const runs = workflowRuns();

  it('installs from the lockfile as committed', () => {
    stepIndex(runs, 'pnpm install --frozen-lockfile');
  });

  it('runs only scripts package.json defines', () => {
    const scripts = runs
      .map((run) => /^pnpm ([\w:-]+)$/.exec(run)?.[1])
      .filter((name): name is string => name !== undefined);

    expect(scripts.length).toBeGreaterThan(0);
    for (const name of scripts) expect(Object.keys(rootScripts), name).toContain(name);
  });

  it('typechecks (which builds dist) before linting, so the boundary rule can resolve imports', () => {
    expect(stepIndex(runs, 'pnpm typecheck')).toBeLessThan(stepIndex(runs, 'pnpm lint'));
  });

  it('tests and checks the OpenAPI spec after building', () => {
    const build = stepIndex(runs, 'pnpm build');
    expect(stepIndex(runs, 'pnpm test')).toBeGreaterThan(build);
    expect(stepIndex(runs, 'pnpm openapi:check')).toBeGreaterThan(build);
    expect(stepIndex(runs, 'pnpm test:e2e')).toBeGreaterThan(build);
  });

  it('greps the UI source for backend names', () => {
    const workflow = repoText('.github/workflows/ci.yml');
    const grep = /grep -\w+ '([^']+)' packages\/app\/src packages\/react\/src/.exec(workflow);
    expect(grep, 'the backend-name grep over app and react source').not.toBeNull();

    const pattern = new RegExp(grep![1]!, 'i');
    for (const name of ['sdcpp', 'sd.cpp', 'ComfyUI', 'sdapi'])
      expect(pattern.test(name), name).toBe(true);
    expect(pattern.test('generate')).toBe(false);
  });
});

describe('the OpenAPI drift check', () => {
  const SPEC = 'packages/server/openapi.json';

  it('emits the spec as part of the build', () => {
    expect(rootScripts['build']).toMatch(
      /tsc -b && pnpm --filter @bureaucromancer\/lantern-server emit-openapi/,
    );
  });

  describe('re-emits, then fails unless the spec is committed as emitted', () => {
    // A plain diff compares the tree with the index, and a spec that was never
    // committed is in neither, so it would pass: the script needs a step for
    // that case, and that step must not write to the index (an intent-to-add
    // entry left behind makes every later `git stash` fail). So the git steps
    // run here, in a scratch repository, against each state the spec can be in.
    const steps = (rootScripts['openapi:check'] ?? '').split(' && ');
    const gitSteps = steps.slice(1).join(' && ');

    // No user or system config: a signing or hook setting must not decide the result.
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'ci-shape',
      GIT_AUTHOR_EMAIL: 'ci-shape@example.invalid',
      GIT_COMMITTER_NAME: 'ci-shape',
      GIT_COMMITTER_EMAIL: 'ci-shape@example.invalid',
    };

    let repo = '';
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo, env: gitEnv, encoding: 'utf8' });
    const writeSpec = (text: string): void => {
      writeFileSync(join(repo, SPEC), text);
    };
    /**
     * The check's exit status, run after the spec has been emitted.
     *
     * Through the platform's shell (`shell: true`: /bin/sh, or cmd.exe on
     * Windows) rather than `sh` by name, which Windows has on PATH only inside
     * Git Bash: from PowerShell or cmd the spawn failed, the status was null,
     * and the two cases expecting failure passed without running a step. What
     * runs the script for real is neither shell but pnpm's emulator
     * (`shellEmulator` in pnpm-workspace.yaml); all three chain `&&` on exit
     * status, which is the only shell syntax the git steps use.
     */
    const check = (): number => {
      const result = spawnSync(gitSteps, { shell: true, cwd: repo, env: gitEnv, stdio: 'ignore' });
      if (result.error !== undefined) throw result.error;
      return result.status ?? -1;
    };

    beforeEach(() => {
      repo = mkdtempSync(join(tmpdir(), 'lantern-openapi-check-'));
      git('init', '--quiet');
      mkdirSync(join(repo, 'packages/server'), { recursive: true });
      writeFileSync(join(repo, 'README.md'), 'x\n');
      git('add', 'README.md');
      git('commit', '--quiet', '-m', 'init');
    });

    afterEach(() => {
      rmSync(repo, { recursive: true, force: true });
    });

    it('emits first, then runs only git steps', () => {
      expect(steps[0]).toBe('pnpm --filter @bureaucromancer/lantern-server emit-openapi');
      expect(steps.slice(1).length).toBeGreaterThan(0);
      for (const step of steps.slice(1)) expect(step).toMatch(/^git /);
    });

    it('fails for a spec that was never committed, and leaves the index alone', () => {
      writeSpec('{}\n');

      expect(check()).not.toBe(0);
      expect(git('status', '--porcelain', '--', SPEC)).toBe(`?? ${SPEC}\n`);
      expect(git('diff', '--cached', '--name-only')).toBe('');
    });

    it('passes when the emitted spec matches the committed one', () => {
      writeSpec('{}\n');
      git('add', SPEC);
      git('commit', '--quiet', '-m', 'spec');

      expect(check()).toBe(0);
    });

    it('fails when the emitted spec differs from the committed one', () => {
      writeSpec('{}\n');
      git('add', SPEC);
      git('commit', '--quiet', '-m', 'spec');
      writeSpec('{"paths":{}}\n');

      expect(check()).not.toBe(0);
      expect(git('diff', '--cached', '--name-only')).toBe('');
    });
  });

  it('runs the emitter on the built server', () => {
    const server = JSON.parse(repoText('packages/server/package.json')) as {
      scripts: Record<string, string>;
    };

    expect(server.scripts['emit-openapi']).toBe('node scripts/emit-openapi.ts');
    expect(repoText('packages/server/scripts/emit-openapi.ts')).toMatch(/import\('\.\.\/dist\//);
  });

  it('keeps the formatter off the generated file, whose bytes the emitter owns', () => {
    expect(repoText('.prettierignore').split('\n')).toContain(SPEC);
  });
});
