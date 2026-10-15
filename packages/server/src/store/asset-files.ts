// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * A library's files: the content-addressed assets, their thumbnails, and the
 * spool of results waiting to be ingested (plan, "Asset store").
 *
 * ```
 * assets/ab/cd/<sha256>.<ext>      the asset, named by the hash of its bytes
 * cache/thumbs/ab/<sha256>.webp    its thumbnail, rebuilt when missing
 * incoming/<job id>/               a finished job's results before ingest (A17)
 * ```
 *
 * Writes are atomic and durable: a temporary file in the same directory,
 * fsync, rename, then fsync of the directory, so a crash leaves the old state
 * or the new one and never a short file under an asset's name. Assets are
 * written before the row that records them, so a crash in between leaves an
 * orphan file, never a row without bytes; {@link sweepLibraryFiles} removes
 * orphans at the next start.
 *
 * Not through write-file-atomic (atomic.ts), which preserves an existing
 * file's mode and owner and skips the directory fsync: an asset never
 * replaces a file, and its rename must survive a power cut, because the
 * database row written next says the bytes exist.
 */

import { randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';

import { ASSET_ID_PATTERN } from '@bureaucromancer/lantern-schema';

import { EXTENSIONS } from './media.js';
import type { LibraryPaths } from './paths.js';

const ASSET_ID = new RegExp(ASSET_ID_PATTERN);

/** Temporary files start with this, so the sweep can tell them from anything else. */
const TEMP_PREFIX = '.tmp-';

/** `<sha256>.<ext>`, the only names under assets/ that are assets. */
const ASSET_NAME = /^([0-9a-f]{64})\.([a-z0-9]+)$/;
const THUMB_NAME = /^([0-9a-f]{64})\.webp$/;

function assertAssetId(id: string): void {
  if (!ASSET_ID.test(id)) throw new TypeError(`Not an asset id: "${id}".`);
}

function extensionOf(mediaType: string): string {
  const extension = EXTENSIONS[mediaType];
  if (extension === undefined) throw new TypeError(`No file extension for ${mediaType}.`);
  return extension;
}

/** Where an asset's bytes live: two levels of fan-out by its first four hex digits. */
export function assetPath(paths: LibraryPaths, id: string, mediaType: string): string {
  assertAssetId(id);
  return join(paths.assets, id.slice(0, 2), id.slice(2, 4), `${id}.${extensionOf(mediaType)}`);
}

/** Where an asset's thumbnail lives. */
export function thumbnailPath(paths: LibraryPaths, id: string): string {
  assertAssetId(id);
  return join(paths.thumbs, id.slice(0, 2), `${id}.webp`);
}

/** Where a job's results are spooled before they are ingested (A17). */
export function spoolPath(paths: LibraryPaths, jobId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) throw new TypeError(`Not a job id: "${jobId}".`);
  return join(paths.incoming, jobId);
}

/** Fsyncs a directory, so a rename in it survives a power cut. Windows cannot open one; it is skipped there. */
async function syncDirectory(path: string): Promise<void> {
  if (platform() === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Writes a file atomically and durably. With `ifAbsent`, an existing file of
 * the same size is left alone and the answer is false: under a content
 * address it already holds these bytes. One of another size is a damaged
 * copy and is replaced.
 */
export async function writeDurably(
  path: string,
  bytes: Uint8Array,
  options: { readonly ifAbsent?: boolean } = {},
): Promise<boolean> {
  if (options.ifAbsent === true) {
    const existing = await sizeOf(path);
    if (existing === bytes.byteLength) return false;
  }
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temp = join(directory, `${TEMP_PREFIX}${randomBytes(6).toString('hex')}`);
  const handle = await open(temp, 'wx');
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await syncDirectory(directory);
  return true;
}

/** A file's bytes, or null when it is not there. */
export async function readIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** A file's size, or null when it is not there. */
export async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function listDirectory(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** The total size of the regular files under a directory; 0 when it is not there. */
export async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await listDirectory(path)) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(child);
    else if (entry.isFile()) total += (await sizeOf(child)) ?? 0;
  }
  return total;
}

/** What the sweep needs to know about the library's rows. */
export interface SweepFacts {
  /** The bytes state of each asset with a row. */
  readonly assets: ReadonlyMap<string, string>;
  /** Whether a job's results were already ingested, so its spool is stale. */
  readonly jobIngested: (jobId: string) => boolean;
}

/** What one sweep removed, for the log. */
export interface SweepReport {
  readonly tempFiles: number;
  /** Asset files with no row, or whose row says the bytes were deleted. */
  readonly orphanAssets: number;
  readonly orphanThumbnails: number;
  /** Spool folders of jobs whose results are already in the library. */
  readonly staleSpools: number;
}

/**
 * The startup sweep (A23): removes temporary files left by interrupted
 * writes, asset files no row accounts for (a crash between writing the file
 * and committing its row, or between trashing the row and removing the file),
 * thumbnails of assets whose bytes are gone, and spool folders of jobs already
 * ingested. Runs before the library serves anything, so nothing is mid-write.
 * Files it does not recognise are left alone.
 */
export async function sweepLibraryFiles(
  paths: LibraryPaths,
  facts: SweepFacts,
): Promise<SweepReport> {
  let tempFiles = 0;
  let orphanAssets = 0;
  let orphanThumbnails = 0;
  let staleSpools = 0;

  const present = (id: string): boolean => facts.assets.get(id) === 'present';

  for (const first of await listDirectory(paths.assets)) {
    if (!first.isDirectory()) continue;
    for (const second of await listDirectory(join(paths.assets, first.name))) {
      if (!second.isDirectory()) continue;
      const directory = join(paths.assets, first.name, second.name);
      for (const entry of await listDirectory(directory)) {
        if (!entry.isFile()) continue;
        if (entry.name.startsWith(TEMP_PREFIX)) {
          await rm(join(directory, entry.name), { force: true });
          tempFiles += 1;
          continue;
        }
        const id = ASSET_NAME.exec(entry.name)?.[1];
        if (id !== undefined && !present(id)) {
          await rm(join(directory, entry.name), { force: true });
          orphanAssets += 1;
        }
      }
    }
  }

  for (const shard of await listDirectory(paths.thumbs)) {
    if (!shard.isDirectory()) continue;
    const directory = join(paths.thumbs, shard.name);
    for (const entry of await listDirectory(directory)) {
      if (!entry.isFile()) continue;
      const temp = entry.name.startsWith(TEMP_PREFIX);
      const id = THUMB_NAME.exec(entry.name)?.[1];
      if (temp || (id !== undefined && !present(id))) {
        await rm(join(directory, entry.name), { force: true });
        if (temp) tempFiles += 1;
        else orphanThumbnails += 1;
      }
    }
  }

  for (const entry of await listDirectory(paths.incoming)) {
    if (!entry.isDirectory() || !facts.jobIngested(entry.name)) continue;
    await rm(join(paths.incoming, entry.name), { recursive: true, force: true });
    staleSpools += 1;
  }

  return { tempFiles, orphanAssets, orphanThumbnails, staleSpools };
}
