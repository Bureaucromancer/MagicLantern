// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The lint rules that encode architecture, factored out of `eslint.config.js`
 * so the fixture tests in `tools/lint-fixtures/` exercise these exact objects.
 * A rule loosened here then turns a test red, instead of a hand-copied
 * approximation going on passing.
 *
 * The path-dependent rules take root prefixes so the tests can point them at a
 * fixture tree. Everything else is path-independent.
 */

import { builtinModules } from 'node:module';

// ---------------------------------------------------------------------------
// Licence header
// ---------------------------------------------------------------------------

/** The header every JS/TS source file carries, followed by one blank line. */
export const SPDX_CONTENT =
  'SPDX-License-Identifier: MIT\nCopyright (C) {year} Magic Lantern contributors';

/** Fixed, not the current year: a file written later still carries this header exactly. */
export const COPYRIGHT_YEAR = '2026';

export const headerRule = {
  'headers/header-format': [
    'error',
    {
      source: 'string',
      style: 'line',
      content: SPDX_CONTENT,
      variables: { year: COPYRIGHT_YEAR },
      trailingNewlines: 2,
    },
  ],
};

// ---------------------------------------------------------------------------
// Imports: the filesystem, Node built-ins and package names
// ---------------------------------------------------------------------------

const FS_MODULES = [
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'graceful-fs',
  'write-file-atomic',
];

const FS_MESSAGE =
  'Filesystem access lives in packages/server/src/store, src/config and src/cli ' +
  '(plus build scripts, tools and tests). Request-time code reaches the disk ' +
  'through the store, so there is one place to audit paths.';

/**
 * Bare built-in names (`fs`, `path/posix`). Prefix-only modules such as
 * `node:sqlite` and internal `_`-names are covered by the `node:*` pattern.
 */
const BARE_BUILTINS = builtinModules.filter(
  (name) => !name.startsWith('_') && !name.startsWith('node:'),
);

/**
 * Packages that also run in browsers, so no Node built-ins. Exported so the
 * real config and the fixture config cannot disagree about the set.
 *
 * @type {ReadonlySet<'schema' | 'client' | 'react' | 'server' | 'app'>}
 */
export const BROWSER_PACKAGES = new Set(['schema', 'client', 'react', 'app']);

const BROWSER_MESSAGE =
  `Node built-in in a package that also runs in browsers (${[...BROWSER_PACKAGES].join(', ')}). ` +
  'Keep it platform-neutral, or move the code to the server.';

/**
 * Builds the `no-restricted-imports` value. ESLint configures a rule once per
 * config object, and a later block *replaces* earlier options rather than
 * merging them, so every exemption has to rebuild the whole value here,
 * package bans included.
 *
 * @param {{ allowFs?: boolean, browser?: boolean, bannedPackages?: { name: string, message: string }[] }} options
 */
export function restrictedImports({ allowFs = false, browser = false, bannedPackages = [] } = {}) {
  /** @type {Map<string, { name: string, message: string }>} */
  const paths = new Map();
  /** @type {{ group: string[], message: string }[]} */
  const patterns = [];

  if (!allowFs) {
    for (const name of FS_MODULES) paths.set(name, { name, message: FS_MESSAGE });
  }

  if (browser) {
    // The browser ban is stricter than the fs ban and replaces its message for
    // the names they share: in these packages no built-in is acceptable.
    for (const name of BARE_BUILTINS) paths.set(name, { name, message: BROWSER_MESSAGE });
    patterns.push({ group: ['node:*'], message: BROWSER_MESSAGE });
  }

  for (const banned of bannedPackages) {
    paths.set(banned.name, banned);
    // `paths` compares exact names, so `pkg/deep` would slip past it; the glob
    // form catches subpath imports even when export maps would not.
    patterns.push({ group: [`${banned.name}/*`], message: banned.message });
  }

  const value = { paths: [...paths.values()] };
  return ['error', patterns.length === 0 ? value : { ...value, patterns }];
}

// ---------------------------------------------------------------------------
// UI source: tokens, logical direction, and no backend names
// ---------------------------------------------------------------------------

/**
 * Physical-direction Tailwind utilities, each of which has a logical
 * equivalent (ms/me, ps/pe, start/end, border-s/e, rounded-s/e, text-start/end).
 * Stylelint cannot see utility classes, so this is the JSX half of the
 * logical-properties rule. `left`/`right` need a Tailwind-shaped suffix so
 * ordinary English and SQL in strings do not match.
 */
const PHYSICAL_UTILITY_PATTERN = String.raw`(?:^|\s)(?:[\w[\]-]+:)*-?(?:(?:left|right)-(?:\d|px|full|auto|\[|\()[^\s]*|(?:ml|mr|pl|pr|scroll-ml|scroll-mr|scroll-pl|scroll-pr)-[^\s]+|(?:border-l|border-r|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br)(?:-[^\s]*)?|text-left|text-right|float-left|float-right|clear-left|clear-right)(?:\s|$)`;

const PHYSICAL_MESSAGE =
  'Physical-direction utility. Use the logical equivalent (ms/me, ps/pe, start/end, ' +
  'border-s/border-e, rounded-s/rounded-e, text-start/text-end); lantern-react ' +
  'renders inside StoryEngine, which enforces the same rule.';

/**
 * A Tailwind palette scale (`bg-slate-800`). The palette lives in the app's
 * index.css as semantic tokens; a scale named at a call site is a surface that
 * stays light when the dark theme redefines the tokens.
 */
const PALETTE_PATTERN = String.raw`(?:^|\s)(?:[\w[\]-]+:)*-?(?:bg|text|border|ring|outline|decoration|divide|from|via|to|accent|caret|placeholder|shadow|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+(?:\/\d+)?(?:\s|$)`;

const PALETTE_MESSAGE =
  'Tailwind palette scale in a component. Use a semantic token defined in ' +
  'packages/app/src/index.css (and add one if none says what you mean).';

const DARK_VARIANT_MESSAGE =
  'A `dark:` variant. The dark theme redefines tokens rather than adding variants, ' +
  'so a component that needs one is missing a token.';

/** Rule 3: the UI never names a backend. CI greps for the same words. */
const BACKEND_NAME_PATTERN = String.raw`sdcpp|sd\.cpp|comfy|sdapi`;

const BACKEND_NAME_MESSAGE =
  'The UI never names a backend (rule 3). Render from descriptors and the JSON ' +
  'Schema the server supplies instead.';

/**
 * Builds the `no-restricted-syntax` value for UI source (app and react).
 * Like `restrictedImports`, one call builds the whole value.
 */
export function restrictedUiSyntax() {
  return [
    'error',
    { selector: `Literal[value=/${PHYSICAL_UTILITY_PATTERN}/]`, message: PHYSICAL_MESSAGE },
    {
      selector: `TemplateElement[value.raw=/${PHYSICAL_UTILITY_PATTERN}/]`,
      message: PHYSICAL_MESSAGE,
    },
    { selector: `Literal[value=/${PALETTE_PATTERN}/]`, message: PALETTE_MESSAGE },
    { selector: `TemplateElement[value.raw=/${PALETTE_PATTERN}/]`, message: PALETTE_MESSAGE },
    { selector: String.raw`Literal[value=/(?:^|\s)dark:/]`, message: DARK_VARIANT_MESSAGE },
    {
      selector: String.raw`TemplateElement[value.raw=/(?:^|\s)dark:/]`,
      message: DARK_VARIANT_MESSAGE,
    },
    { selector: `Literal[value=/${BACKEND_NAME_PATTERN}/i]`, message: BACKEND_NAME_MESSAGE },
    {
      selector: `TemplateElement[value.raw=/${BACKEND_NAME_PATTERN}/i]`,
      message: BACKEND_NAME_MESSAGE,
    },
    { selector: `JSXText[value=/${BACKEND_NAME_PATTERN}/i]`, message: BACKEND_NAME_MESSAGE },
    { selector: `Identifier[name=/${BACKEND_NAME_PATTERN}/i]`, message: BACKEND_NAME_MESSAGE },
  ];
}

// ---------------------------------------------------------------------------
// The architectural boundary graph
// ---------------------------------------------------------------------------

const BOUNDARY_MESSAGE =
  'Architectural boundary violated. The graph (plan, repository layout): ' +
  'schema → schema; client → schema; react → schema; app → react, client, schema; ' +
  'server → schema. Inside the server, adapters and managers may import only the ' +
  'schema and src/adapters/shared (rule 9).';

/** @param {string} type */
const from = (type) => ({ element: { type } });

/** @param {string[]} types */
const to = (types) => ({ to: { element: { types: { anyOf: types } } } });

/**
 * The package graph as eslint-plugin-boundaries settings and rules.
 *
 * Each element is a folder (`partialMatch: false` keeps folder semantics: the
 * element is the matched folder and every file under it, `dist` included,
 * belongs to it). Imports between files of one element are internal and not
 * checked, which is what lets an adapter import its own files but not another
 * adapter's: each adapter and manager folder is its own element.
 *
 * Takes several roots because the fixture tests need two: the fixture files
 * live under the fixture tree, but their imports resolve through pnpm's
 * symlinks into the real packages. An import whose target matches no element is
 * "unknown" and silently allowed, which is why the name bans below exist too.
 *
 * @param {string | string[]} prefixes path prefixes the packages live under, no trailing slash
 */
export function boundariesGraph(prefixes) {
  const roots = Array.isArray(prefixes) ? prefixes : [prefixes];

  /** @param {string} suffix */
  const pattern = (suffix) => roots.map((root) => `${root}/${suffix}`);

  /**
   * @param {string} type
   * @param {string} suffix
   */
  const element = (type, suffix) => ({ type, pattern: pattern(suffix), partialMatch: false });

  return {
    settings: {
      'boundaries/include': pattern('**/*'),
      // Order matters: the server's sub-elements come before `server`, and
      // adapters/shared before the per-adapter pattern that would also match it.
      'boundaries/elements': [
        element('server-adapter-shared', 'server/src/adapters/shared'),
        element('server-adapter', 'server/src/adapters/*'),
        // Files directly under adapters/ belong to no adapter, so they get the
        // adapter rules rather than falling through to `server`.
        element('server-adapter', 'server/src/adapters'),
        element('server-manager', 'server/src/managers/*'),
        element('server-manager', 'server/src/managers'),
        element('schema', 'schema'),
        element('client', 'client'),
        element('react', 'react'),
        element('app', 'app'),
        element('server', 'server'),
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          message: BOUNDARY_MESSAGE,
          policies: [
            { from: from('schema'), allow: to(['schema']) },
            { from: from('client'), allow: to(['client', 'schema']) },
            { from: from('react'), allow: to(['react', 'schema']) },
            { from: from('app'), allow: to(['app', 'react', 'client', 'schema']) },
            {
              from: from('server'),
              allow: to([
                'server',
                'schema',
                'server-adapter',
                'server-adapter-shared',
                'server-manager',
              ]),
            },
            { from: from('server-adapter'), allow: to(['schema', 'server-adapter-shared']) },
            { from: from('server-manager'), allow: to(['schema', 'server-adapter-shared']) },
            { from: from('server-adapter-shared'), allow: to(['schema']) },
          ],
        },
      ],
    },
  };
}

const SCOPE = '@bureaucromancer';

/**
 * The second, dumber layer: the same graph as a ban on package names, which
 * needs no resolver. The boundary rule depends on `@bureaucromancer/*`
 * resolving through pnpm's symlinks into built `dist` folders, and a boundary
 * rule that silently stops matching is worse than none.
 */
export const forbiddenPackages = {
  schema: ['client', 'react', 'server', 'app'],
  client: ['react', 'server', 'app'],
  react: ['client', 'server', 'app'],
  app: ['server'],
  server: ['client', 'react', 'app'],
};

/** @param {keyof typeof forbiddenPackages} pkg */
export function bannedPackagesFor(pkg) {
  return forbiddenPackages[pkg].map((target) => {
    const name = `${SCOPE}/lantern-${target}`;
    return { name, message: `${pkg} may not import ${name} (plan, repository layout).` };
  });
}
