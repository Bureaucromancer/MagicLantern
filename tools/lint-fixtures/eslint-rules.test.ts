// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';

import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

import { bannedPackagesFor, forbiddenPackages } from '../../eslint.rules.js';

import { FIXTURE_ROOT, fixtureConfig, fixtureConfigRootedAt, PACKAGES } from './fixture-config.js';

/**
 * Proves the lint rules in `eslint.rules.js` do what the plan says, against
 * fixtures: each boundary edge allowed or forbidden, through both layers (the
 * resolved-path boundary rule and the package-name ban), plus the rules that
 * travel with them.
 *
 * The negative cases matter as much as the positive ones. A rule that fires on
 * everything is as useless as one that fires on nothing, and the failure that
 * actually happens, a resolver silently matching nothing, looks exactly like a
 * clean run.
 */

type Pkg = (typeof PACKAGES)[number];

const SCOPE = '@bureaucromancer';

/** The plan's package graph (repository layout), stated here independently of the rules under test. */
const ALLOWED: Record<Pkg, readonly Pkg[]> = {
  schema: [],
  client: ['schema'],
  react: ['schema'],
  app: ['react', 'client', 'schema'],
  server: ['schema'],
};

/** Packages with a built entry point; the app is a Vite app with none, so its name never resolves. */
const RESOLVABLE: readonly Pkg[] = ['schema', 'client', 'react', 'server'];

const HEADER =
  '// SPDX-License-Identifier: MIT\n// Copyright (C) 2026 Magic Lantern contributors\n\n';

const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: fixtureConfig,
  ignore: false,
  cwd: process.cwd(),
});

interface Report {
  readonly rule: string;
  readonly message: string;
}

function reportsOf(result: ESLint.LintResult | undefined, what: string): Report[] {
  if (result === undefined) throw new Error(`No lint result for ${what}; is the path right?`);
  const fatal = result.messages.find((message) => message.fatal === true);
  if (fatal !== undefined) throw new Error(`${what} failed to parse: ${fatal.message}`);
  return result.messages.map((m) => ({ rule: m.ruleId ?? '<no rule>', message: m.message }));
}

/** Reports for a fixture file on disk, relative to the fixture root. */
async function reportsIn(fixture: string): Promise<Report[]> {
  const [result] = await eslint.lintFiles([`${FIXTURE_ROOT}/${fixture}`]);
  return reportsOf(result, fixture);
}

async function rulesFiredIn(fixture: string): Promise<string[]> {
  return (await reportsIn(fixture)).map((report) => report.rule);
}

/**
 * Rule ids reported for a one-import probe linted as if it lived at `at`
 * (relative to the fixture root). The probe need not exist on disk: ESLint
 * resolves its imports from that path, and the targets do exist.
 */
async function rulesFiredByImport(at: string, specifier: string): Promise<string[]> {
  const code = `${HEADER}import * as imported from '${specifier}';\n\nexport const used = imported;\n`;
  const [result] = await eslint.lintText(code, { filePath: `${FIXTURE_ROOT}/${at}` });
  return reportsOf(result, `${at} importing ${specifier}`).map((report) => report.rule);
}

/** `no-restricted-syntax` holds several rules in one slot; the message tells them apart. */
async function syntaxReportsMatching(fixture: string, pattern: RegExp): Promise<string[]> {
  return (await reportsIn(fixture))
    .filter((report) => report.rule === 'no-restricted-syntax' && pattern.test(report.message))
    .map((report) => report.message);
}

/** Every ordered pair of distinct packages, with whether the plan allows the edge. */
const EDGES = PACKAGES.flatMap((from) =>
  PACKAGES.filter((to) => to !== from).map((to) => ({
    from,
    to,
    allowed: ALLOWED[from].includes(to),
  })),
);

describe('the package boundaries', () => {
  // The boundary rule classifies an import by its *resolved* path, and the
  // workspace packages resolve through their built entry points into dist. On
  // an unbuilt workspace every import resolves to nothing, is classified
  // unknown, and is allowed: a clean run that means the opposite of what it
  // looks like. Fail loudly instead.
  beforeAll(() => {
    const require = createRequire(join(process.cwd(), FIXTURE_ROOT, 'packages/app/src/probe.ts'));
    for (const pkg of RESOLVABLE) {
      try {
        require.resolve(`${SCOPE}/lantern-${pkg}`);
      } catch {
        throw new Error(
          `Cannot resolve ${SCOPE}/lantern-${pkg} from the fixture tree. Run \`pnpm typecheck\` ` +
            '(or `tsc -b`) first: the boundary rule resolves imports through each ' +
            "package's built entry point, so an unbuilt workspace makes it silently pass.",
        );
      }
    }
  });

  it('cover all twenty edges, six of them allowed', () => {
    expect(EDGES).toHaveLength(20);
    expect(EDGES.filter((edge) => edge.allowed)).toHaveLength(6);
  });

  it('ban by name exactly the packages the graph forbids', () => {
    for (const from of PACKAGES) {
      const forbidden = PACKAGES.filter((to) => to !== from && !ALLOWED[from].includes(to));
      expect([...forbiddenPackages[from]].sort(), from).toEqual([...forbidden].sort());
    }
  });

  describe.each(EDGES)('$from → $to', ({ from, to, allowed }) => {
    // The boundary rule alone: a relative path into another package's folder
    // has no package name for the ban to see.
    it(allowed ? 'is allowed by path' : 'is refused by path', async () => {
      const fired = await rulesFiredByImport(
        `packages/${from}/src/probe.ts`,
        `../../${to}/src/target.js`,
      );

      expect(fired.includes('boundaries/dependencies')).toBe(!allowed);
      expect(fired).not.toContain('no-restricted-imports');
    });

    it(allowed ? 'is allowed by name' : 'is refused by name', async () => {
      const fired = await rulesFiredByImport(
        `packages/${from}/src/probe.ts`,
        `${SCOPE}/lantern-${to}`,
      );

      expect(fired.includes('no-restricted-imports')).toBe(!allowed);
      // By name the import resolves through pnpm's symlinks into the *real*
      // package's dist, so this is the boundary rule matching the second root
      // and the whole package rather than src (both gotchas at once).
      expect(fired.includes('boundaries/dependencies')).toBe(!allowed && RESOLVABLE.includes(to));
    });
  });

  it.each(PACKAGES)('let %s import its own files', async (pkg) => {
    expect(await rulesFiredByImport(`packages/${pkg}/src/probe.ts`, './target.js')).toEqual([]);
  });

  it('resolve a package name into the real package’s dist, which the element must cover', () => {
    const require = createRequire(
      join(process.cwd(), FIXTURE_ROOT, 'packages/client/src/probe.ts'),
    );
    const resolved = relative(process.cwd(), require.resolve(`${SCOPE}/lantern-server`));

    expect(resolved.split(sep).join('/')).toBe('packages/server/dist/index.js');
  });

  it('miss a name import when the graph is rooted only at the fixture tree', async () => {
    // Why the fixture config passes both roots: the import resolves outside the
    // fixture tree, so a graph that only knows the fixture tree calls it unknown.
    const narrow = new ESLint({
      overrideConfigFile: true,
      overrideConfig: fixtureConfigRootedAt([`${FIXTURE_ROOT}/packages`]),
      ignore: false,
      cwd: process.cwd(),
    });
    const code = `${HEADER}import * as server from '${SCOPE}/lantern-server';\n\nexport const used = server;\n`;
    const [result] = await narrow.lintText(code, {
      filePath: `${FIXTURE_ROOT}/packages/client/src/probe.ts`,
    });
    const fired = reportsOf(result, 'the narrow graph').map((report) => report.rule);

    expect(fired).not.toContain('boundaries/dependencies');
    // The name ban still holds, which is what the second layer is for.
    expect(fired).toContain('no-restricted-imports');
  });

  it('refuse a deep import of a forbidden package by name', async () => {
    expect(await rulesFiredIn('packages/client/src/imports-server-subpath.ts')).toContain(
      'no-restricted-imports',
    );
  });

  it('say which package may not import which', async () => {
    const reports = await reportsIn('packages/client/src/imports-server-subpath.ts');
    const [ban] = bannedPackagesFor('client').filter((b) => b.name.endsWith('-server'));

    expect(reports.some((report) => report.message.includes(ban!.message))).toBe(true);
  });
});

describe('the server’s adapters and managers (rule 9)', () => {
  const cases: [string, string, string, boolean][] = [
    // [description, probe location, import, allowed]
    ['an adapter → its own files', 'adapters/example/probe.ts', './target.js', true],
    ['an adapter → adapters/shared', 'adapters/example/probe.ts', '../shared/target.js', true],
    ['an adapter → another adapter', 'adapters/example/probe.ts', '../other/target.js', false],
    ['an adapter → the rest of the server', 'adapters/example/probe.ts', '../../target.js', false],
    ['an adapter → a manager', 'adapters/example/probe.ts', '../../managers/jobs/target.js', false],
    ['an adapter → the schema', 'adapters/example/probe.ts', `${SCOPE}/lantern-schema`, true],
    ['a file loose in adapters/ → the server', 'adapters/probe.ts', '../target.js', false],
    [
      'a file loose in adapters/ → adapters/shared',
      'adapters/probe.ts',
      './shared/target.js',
      true,
    ],
    ['adapters/shared → the server', 'adapters/shared/probe.ts', '../../target.js', false],
    ['adapters/shared → an adapter', 'adapters/shared/probe.ts', '../example/target.js', false],
    ['adapters/shared → the schema', 'adapters/shared/probe.ts', `${SCOPE}/lantern-schema`, true],
    [
      'a manager → adapters/shared',
      'managers/jobs/probe.ts',
      '../../adapters/shared/target.js',
      true,
    ],
    ['a manager → an adapter', 'managers/jobs/probe.ts', '../../adapters/example/target.js', false],
    ['a manager → another manager', 'managers/jobs/probe.ts', '../other/target.js', false],
    ['a manager → the rest of the server', 'managers/jobs/probe.ts', '../../target.js', false],
    ['the server → an adapter', 'probe.ts', './adapters/example/target.js', true],
    ['the server → adapters/shared', 'probe.ts', './adapters/shared/target.js', true],
    ['the server → a manager', 'probe.ts', './managers/jobs/target.js', true],
  ];

  it.each(cases)('%s', async (_label, at, specifier, allowed) => {
    const fired = await rulesFiredByImport(`packages/server/src/${at}`, specifier);

    expect(fired.includes('boundaries/dependencies')).toBe(!allowed);
  });

  it('refuse a forbidden package by name from inside an adapter too', async () => {
    const fired = await rulesFiredByImport(
      'packages/server/src/adapters/example/probe.ts',
      `${SCOPE}/lantern-client`,
    );

    expect(fired).toContain('no-restricted-imports');
    expect(fired).toContain('boundaries/dependencies');
  });
});

describe('Node built-ins and the filesystem', () => {
  it('refuses both spellings of a built-in in a package that runs in browsers', async () => {
    const reports = (await reportsIn('packages/schema/src/uses-node-builtins.ts')).filter(
      (report) => report.rule === 'no-restricted-imports',
    );

    expect(reports).toHaveLength(2);
    expect(reports[0]!.message).toMatch(/also runs in browsers/);
  });

  it('lets the server use them', async () => {
    expect(await rulesFiredIn('packages/server/src/uses-node-builtins.ts')).toEqual([]);
  });

  it('refuses the filesystem in ordinary server code', async () => {
    const reports = (await reportsIn('packages/server/src/uses-fs.ts')).filter(
      (report) => report.rule === 'no-restricted-imports',
    );

    expect(reports).toHaveLength(2);
    expect(reports[0]!.message).toMatch(/packages\/server\/src\/store/);
  });

  it('allows it in the store', async () => {
    expect(await rulesFiredIn('packages/server/src/store/uses-fs.ts')).toEqual([]);
  });
});

describe('the licence header', () => {
  it('is required', async () => {
    expect(await rulesFiredIn('packages/schema/src/no-header.ts')).toContain(
      'headers/header-format',
    );
  });

  it('is satisfied by the fixtures that carry it', async () => {
    expect(await rulesFiredIn('packages/schema/src/target.ts')).toEqual([]);
  });
});

describe('UI source (rule 3, tokens, logical direction)', () => {
  const BACKEND = /never names a backend/;
  const PHYSICAL = /Physical-direction utility/;
  const PALETTE = /Tailwind palette scale/;
  const DARK = /`dark:` variant/;

  it('refuses a backend name in every shape it arrives in', async () => {
    const fired = await syntaxReportsMatching('packages/app/src/names-a-backend.tsx', BACKEND);

    // Eight: `sdcppUrl` declared and used, `isComfy` declared and used, the
    // `'comfy'` literal, the template's `sdapi`, the `ComfyUI` string, and the
    // JSX text naming sd.cpp.
    expect(fired).toHaveLength(8);
  });

  it('is silent on a component that renders a descriptor', async () => {
    expect(await rulesFiredIn('packages/app/src/renders-a-descriptor.tsx')).toEqual([]);
  });

  it('leaves the server free to name backends', async () => {
    expect(await rulesFiredIn('packages/server/src/names-a-backend.ts')).toEqual([]);
  });

  it('refuses physical-direction utilities in every shape', async () => {
    const fired = await syntaxReportsMatching('packages/react/src/physical-utility.tsx', PHYSICAL);

    expect(fired).toHaveLength(3);
  });

  it('refuses palette scales and dark: variants', async () => {
    expect(
      await syntaxReportsMatching('packages/react/src/palette-scale.tsx', PALETTE),
    ).toHaveLength(2);
    expect(await syntaxReportsMatching('packages/react/src/palette-scale.tsx', DARK)).toHaveLength(
      1,
    );
  });

  it('is silent on logical utilities and semantic tokens', async () => {
    expect(await rulesFiredIn('packages/react/src/logical-utility.tsx')).toEqual([]);
  });
});
