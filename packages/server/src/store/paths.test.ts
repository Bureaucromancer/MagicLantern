// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DATA_LAYOUT,
  dataPaths,
  defaultConfigPath,
  defaultDataDir,
  libraryPaths,
  libraryRelativePath,
  type PlatformContext,
} from './paths.js';

const linux = (env: PlatformContext['env'] = {}): PlatformContext => ({
  env,
  platform: 'linux',
  homedir: '/home/ada',
});

const mac: PlatformContext = { env: {}, platform: 'darwin', homedir: '/Users/ada' };

const windows = (env: PlatformContext['env'] = {}): PlatformContext => ({
  env,
  platform: 'win32',
  homedir: 'C:\\Users\\ada',
});

describe('defaultConfigPath', () => {
  it('follows XDG on Linux', () => {
    expect(defaultConfigPath(linux())).toBe('/home/ada/.config/lantern/lantern.json');
    expect(defaultConfigPath(linux({ XDG_CONFIG_HOME: '/srv/conf' }))).toBe(
      '/srv/conf/lantern/lantern.json',
    );
  });

  it('ignores an empty or relative XDG_CONFIG_HOME, as the spec says', () => {
    expect(defaultConfigPath(linux({ XDG_CONFIG_HOME: '' }))).toBe(
      '/home/ada/.config/lantern/lantern.json',
    );
    expect(defaultConfigPath(linux({ XDG_CONFIG_HOME: 'conf' }))).toBe(
      '/home/ada/.config/lantern/lantern.json',
    );
  });

  it('treats other Unixes like Linux', () => {
    expect(defaultConfigPath({ ...linux(), platform: 'freebsd' })).toBe(
      '/home/ada/.config/lantern/lantern.json',
    );
  });

  it('uses Application Support on macOS, whatever XDG says', () => {
    expect(defaultConfigPath(mac)).toBe(
      '/Users/ada/Library/Application Support/Lantern/lantern.json',
    );
    expect(defaultConfigPath({ ...mac, env: { XDG_CONFIG_HOME: '/x' } })).toBe(
      '/Users/ada/Library/Application Support/Lantern/lantern.json',
    );
  });

  it('uses APPDATA on Windows, falling back to the roaming profile', () => {
    expect(defaultConfigPath(windows({ APPDATA: 'D:\\Profiles\\ada\\Roaming' }))).toBe(
      'D:\\Profiles\\ada\\Roaming\\Lantern\\lantern.json',
    );
    expect(defaultConfigPath(windows())).toBe(
      'C:\\Users\\ada\\AppData\\Roaming\\Lantern\\lantern.json',
    );
  });
});

describe('defaultDataDir', () => {
  it('follows XDG on Linux', () => {
    expect(defaultDataDir(linux())).toBe('/home/ada/.local/share/lantern');
    expect(defaultDataDir(linux({ XDG_DATA_HOME: '/data' }))).toBe('/data/lantern');
    expect(defaultDataDir(linux({ XDG_DATA_HOME: 'relative' }))).toBe(
      '/home/ada/.local/share/lantern',
    );
  });

  it('uses Application Support on macOS', () => {
    expect(defaultDataDir(mac)).toBe('/Users/ada/Library/Application Support/Lantern');
  });

  it('uses the local (not roaming) profile on Windows', () => {
    expect(defaultDataDir(windows({ LOCALAPPDATA: 'D:\\Local' }))).toBe('D:\\Local\\Lantern');
    expect(defaultDataDir(windows({ LOCALAPPDATA: '' }))).toBe(
      'C:\\Users\\ada\\AppData\\Local\\Lantern',
    );
  });
});

describe('dataPaths', () => {
  const root = resolve('/srv/lantern');

  it('names the fixed files of a data directory', () => {
    expect(dataPaths(root)).toEqual({
      root,
      lock: join(root, 'lantern.lock'),
      installDb: join(root, 'lantern.db'),
      secrets: join(root, 'secrets.json'),
      backups: join(root, 'backups'),
      libraries: join(root, 'libraries'),
    });
  });

  it('refuses a relative data directory', () => {
    expect(() => dataPaths('data')).toThrow(TypeError);
  });
});

describe('library paths', () => {
  const root = resolve('/srv/lantern');
  const id = 'lib_01JA2B3C4D5E6F7G8H9JKMNPQR';

  it('stores a new library relative to the data directory, with / separators', () => {
    expect(libraryRelativePath(id)).toBe(`libraries/${id}`);
  });

  it('refuses an id that is not a library id', () => {
    expect(() => libraryRelativePath('../escape')).toThrow(TypeError);
    expect(() => libraryRelativePath(`${id}/../x`)).toThrow(TypeError);
  });

  it('resolves a stored path to the library files', () => {
    const libRoot = join(root, 'libraries', id);
    expect(libraryPaths(root, `libraries/${id}`)).toEqual({
      root: libRoot,
      manifest: join(libRoot, DATA_LAYOUT.libraryManifest),
      db: join(libRoot, DATA_LAYOUT.libraryDb),
      backups: join(libRoot, 'backups'),
    });
  });

  it.each([
    ['empty', ''],
    ['parent segment', '../outside'],
    ['nested parent segment', 'libraries/../../outside'],
    ['dot segment', './libraries/x'],
    ['empty segment', 'libraries//x'],
    ['absolute POSIX', '/etc/lantern'],
    ['absolute Windows', 'C:\\lantern'],
    ['backslashes', 'libraries\\x'],
  ])('refuses a stored path that is %s', (_label, stored) => {
    expect(() => libraryPaths(root, stored)).toThrow(TypeError);
  });
});
