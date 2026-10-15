// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The pixel hash (A25): what "identical" means when Reproduce compares an
 * output with the one it reproduces. Metadata differs between the two files
 * (the `lantern` chunk names the job), so the file hash cannot answer it.
 *
 * SHA-256 over the width and height as big-endian 32-bit integers, then the
 * RGBA8 rows, as pngjs decodes them: palette and grey expanded, 16-bit scaled
 * to 8, `tRNS` applied, and nothing else. No gamma and no colour management,
 * which is the point of a pure decoder: a sharp or libvips upgrade could
 * change what a managed decode produces, and with it every stored hash.
 *
 * The algorithm is stored beside each hash, so a future one can be added
 * without making old hashes lie.
 */

import { createHash } from 'node:crypto';

import { PNG } from 'pngjs';

/** The tag stored in `pixel_hash_alg` for hashes made here. */
export const PIXEL_HASH_ALG = 'sha256-rgba8-pngjs/1';

/**
 * The pixel hash of a PNG whose size has already been checked against the
 * pixel limit: decoding allocates four bytes a pixel.
 *
 * @throws Error when pngjs cannot decode the file
 */
export function pngPixelHash(bytes: Uint8Array): string {
  const image = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const header = Buffer.alloc(8);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  return createHash('sha256').update(header).update(image.data).digest('hex');
}
