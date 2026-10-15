// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Where things live: the platform's default config and data directories, and
 * the layout inside a data directory.
 *
 * The defaults are pure functions of (env, platform, home directory), never of
 * `process`, so tests can ask what Windows would do from a Mac. Each uses the
 * target platform's path flavour for the same reason.
 *
 * ```
 * <data>/
 *   lantern.lock          instance lock (SQLite exclusive lock; never opened with fs)
 *   lantern.db            install database
 *   secrets.json          0600: session key and password record
 *   backups/              snapshots of lantern.db
 *   libraries/<lib id>/
 *     library.json        { id, name, schema, min_reader, created_at }
 *     library.db
 *     backups/            snapshots of library.db
 *     assets/ab/cd/<sha256>.<ext>   content-addressed assets
 *     incoming/<job id>/  results spooled before ingest (A17)
 *     cache/thumbs/ab/<sha256>.webp rebuildable thumbnails
 * ```
 */

import { isAbsolute, join, posix, resolve, sep, win32 } from 'node:path';

import { LIBRARY_ID_PATTERN } from '@bureaucromancer/lantern-schema';

/** The parts of the environment a default depends on, passed in rather than read. */
export interface PlatformContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  /** The user's home directory (`os.homedir()` in the entry point). */
  readonly homedir: string;
}

export const CONFIG_FILE_NAME = 'lantern.json';

/** An empty variable is unset: compose forwards an unset host variable as ''. */
function envValue(env: PlatformContext['env'], name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * The XDG base directory spec says a relative value is invalid and must be
 * ignored, which also stops a stray `XDG_DATA_HOME=data` from scattering files
 * relative to whatever directory the daemon was started in.
 */
function xdgDir(env: PlatformContext['env'], name: string): string | undefined {
  const value = envValue(env, name);
  return value !== undefined && posix.isAbsolute(value) ? value : undefined;
}

/**
 * The default `lantern.json` path:
 * Linux and other Unixes `$XDG_CONFIG_HOME/lantern/lantern.json` or
 * `~/.config/lantern/lantern.json`; macOS
 * `~/Library/Application Support/Lantern/lantern.json`; Windows
 * `%APPDATA%\Lantern\lantern.json`.
 */
export function defaultConfigPath(context: PlatformContext): string {
  const { env, platform, homedir } = context;
  switch (platform) {
    case 'darwin':
      return posix.join(homedir, 'Library', 'Application Support', 'Lantern', CONFIG_FILE_NAME);
    case 'win32':
      return win32.join(
        envValue(env, 'APPDATA') ?? win32.join(homedir, 'AppData', 'Roaming'),
        'Lantern',
        CONFIG_FILE_NAME,
      );
    default:
      return posix.join(
        xdgDir(env, 'XDG_CONFIG_HOME') ?? posix.join(homedir, '.config'),
        'lantern',
        CONFIG_FILE_NAME,
      );
  }
}

/**
 * The default data directory (used when `dataDir` is null):
 * Linux and other Unixes `$XDG_DATA_HOME/lantern` or `~/.local/share/lantern`;
 * macOS `~/Library/Application Support/Lantern`; Windows `%LOCALAPPDATA%\Lantern`
 * (local rather than roaming: databases and images must not sync with a profile).
 */
export function defaultDataDir(context: PlatformContext): string {
  const { env, platform, homedir } = context;
  switch (platform) {
    case 'darwin':
      return posix.join(homedir, 'Library', 'Application Support', 'Lantern');
    case 'win32':
      return win32.join(
        envValue(env, 'LOCALAPPDATA') ?? win32.join(homedir, 'AppData', 'Local'),
        'Lantern',
      );
    default:
      return posix.join(
        xdgDir(env, 'XDG_DATA_HOME') ?? posix.join(homedir, '.local', 'share'),
        'lantern',
      );
  }
}

/** Names inside a data directory. */
export const DATA_LAYOUT = {
  lock: 'lantern.lock',
  installDb: 'lantern.db',
  secrets: 'secrets.json',
  backups: 'backups',
  libraries: 'libraries',
  libraryManifest: 'library.json',
  libraryDb: 'library.db',
  libraryAssets: 'assets',
  libraryIncoming: 'incoming',
  libraryCache: 'cache',
  libraryThumbs: 'cache/thumbs',
} as const;

export interface DataPaths {
  readonly root: string;
  readonly lock: string;
  readonly installDb: string;
  readonly secrets: string;
  readonly backups: string;
  readonly libraries: string;
}

/** The fixed paths of a data directory, which must already be absolute. */
export function dataPaths(dataDir: string): DataPaths {
  if (!isAbsolute(dataDir)) {
    throw new TypeError(`The data directory must be an absolute path; got "${dataDir}".`);
  }
  return {
    root: dataDir,
    lock: join(dataDir, DATA_LAYOUT.lock),
    installDb: join(dataDir, DATA_LAYOUT.installDb),
    secrets: join(dataDir, DATA_LAYOUT.secrets),
    backups: join(dataDir, DATA_LAYOUT.backups),
    libraries: join(dataDir, DATA_LAYOUT.libraries),
  };
}

const LIBRARY_ID = new RegExp(LIBRARY_ID_PATTERN);

/**
 * Where a new library's folder goes, relative to the data directory and always
 * with `/` separators: the form stored in the install database (A21), so a
 * data directory can move between machines. The id is checked first, so a
 * malformed one can never name a path.
 */
export function libraryRelativePath(id: string): string {
  if (!LIBRARY_ID.test(id)) throw new TypeError(`Not a library id: "${id}".`);
  return `${DATA_LAYOUT.libraries}/${id}`;
}

export interface LibraryPaths {
  readonly root: string;
  readonly manifest: string;
  readonly db: string;
  readonly backups: string;
  readonly assets: string;
  readonly incoming: string;
  readonly cache: string;
  readonly thumbs: string;
}

/**
 * Resolves a stored relative library path against the data directory. The
 * stored value came from a database a person can edit, so it is held to the
 * same rules as input: relative, `/`-separated, no `.` or `..` segments, and
 * the result must stay inside the data directory.
 */
export function libraryPaths(dataDir: string, relativePath: string): LibraryPaths {
  const segments = relativePath.split('/');
  const unsafe =
    relativePath === '' ||
    relativePath.includes('\\') ||
    posix.isAbsolute(relativePath) ||
    win32.isAbsolute(relativePath) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..');
  if (unsafe) {
    throw new TypeError(`Not a safe library path inside the data directory: "${relativePath}".`);
  }

  const { root: dataRoot } = dataPaths(dataDir);
  const root = resolve(dataRoot, ...segments);
  if (!root.startsWith(dataRoot.endsWith(sep) ? dataRoot : dataRoot + sep)) {
    throw new TypeError(`Library path escapes the data directory: "${relativePath}".`);
  }

  return libraryPathsAt(root);
}

/**
 * The layout of a library folder at an absolute path that is not a
 * registered library's, such as a backup being written. Registered folders
 * go through {@link libraryPaths}, which checks the stored path first.
 */
export function libraryPathsAt(root: string): LibraryPaths {
  if (!isAbsolute(root)) throw new TypeError(`A library folder must be absolute; got "${root}".`);
  return {
    root,
    manifest: join(root, DATA_LAYOUT.libraryManifest),
    db: join(root, DATA_LAYOUT.libraryDb),
    backups: join(root, DATA_LAYOUT.backups),
    assets: join(root, DATA_LAYOUT.libraryAssets),
    incoming: join(root, DATA_LAYOUT.libraryIncoming),
    cache: join(root, DATA_LAYOUT.libraryCache),
    thumbs: join(root, ...DATA_LAYOUT.libraryThumbs.split('/')),
  };
}
