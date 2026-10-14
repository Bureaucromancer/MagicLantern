// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Browser source must not typecheck against Node's ambient globals.
 *
 * The lint ban on Node built-ins matches import specifiers only, and
 * typescript-eslint turns `no-undef` off, so `process`, `Buffer` or `__dirname`
 * in a browser package is caught by nothing but the compiler, and only when the
 * package's build project leaves Node's types out. That depends on more than
 * the project's own `types`: any file in the same program that pulls Node's
 * types in (a `vite.config.ts` importing vite does) declares them for every
 * file. So this compiles each browser package's build project as `tsc` would,
 * plus one in-memory probe in its `src`, and requires every Node-only global in
 * the probe to be an unknown name. Nothing is written to disk.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every package whose `src` runs in browsers (eslint.rules.js, BROWSER_PACKAGES). */
const BROWSER_PACKAGES = ['schema', 'client', 'react', 'app'] as const;

/** Globals Node declares and browsers do not. Each throws a ReferenceError in a page. */
const NODE_GLOBALS = ['process', 'Buffer', '__dirname', '__filename', 'require'] as const;

const PROBE_SOURCE = [
  ...NODE_GLOBALS.map((name, index) => `export const probe${String(index)} = () => ${name};`),
  '',
].join('\n');

function configError(diagnostic: ts.Diagnostic): never {
  throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

/** The names the compiler reports as unknown in a probe added to `pkg`'s build project. */
function unknownNamesInProbe(pkg: string): string[] {
  const configPath = join(ROOT, 'packages', pkg, 'tsconfig.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: configError,
  });
  if (parsed === undefined) throw new Error(`Cannot read ${configPath}.`);
  const firstError = parsed.errors[0];
  if (firstError !== undefined) configError(firstError);

  // Type-checking only: none of the build project's emit or incremental settings.
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    composite: false,
    incremental: false,
    declaration: false,
    declarationMap: false,
    emitDeclarationOnly: false,
    sourceMap: false,
  };
  delete options.tsBuildInfoFile;

  const probePath = join(ROOT, 'packages', pkg, 'src', 'node-globals-probe.ts');
  const host = ts.createCompilerHost(options);
  const { fileExists, getSourceFile, readFile } = host;
  host.fileExists = (path) => path === probePath || fileExists.call(host, path);
  host.readFile = (path) => (path === probePath ? PROBE_SOURCE : readFile.call(host, path));
  host.getSourceFile = (path, language, ...rest) =>
    path === probePath
      ? ts.createSourceFile(path, PROBE_SOURCE, language)
      : getSourceFile.call(host, path, language, ...rest);

  const program = ts.createProgram({
    rootNames: [...parsed.fileNames, probePath],
    options,
    host,
  });
  const probe = program.getSourceFile(probePath);
  if (probe === undefined) throw new Error(`The probe is not in ${pkg}'s program.`);

  return program
    .getSemanticDiagnostics(probe)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    .map((message) => /^Cannot find name '([^']+)'/.exec(message)?.[1])
    .filter((name): name is string => name !== undefined);
}

describe('browser packages', () => {
  it.each(BROWSER_PACKAGES)(
    'typecheck %s source without Node globals, so using one fails `pnpm typecheck`',
    (pkg) => {
      expect(unknownNamesInProbe(pkg).sort()).toEqual([...NODE_GLOBALS].sort());
    },
    60_000,
  );
});
