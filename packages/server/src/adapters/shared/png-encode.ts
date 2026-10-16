// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * A minimal PNG encoder for adapters that draw their own images (the mock):
 * RGBA8, no filtering, one IDAT, optional uncompressed iTXt chunks. Built
 * on `node:zlib` alone so an adapter needs nothing outside this folder
 * (rule 9), and so the same pixels give the same bytes on every platform.
 */

import { crc32, deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(data, crc32(head.subarray(4))), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Encodes RGBA8 pixels as a PNG.
 *
 * @param rgba width × height × 4 bytes, row by row
 * @param texts keyword → text, written as uncompressed UTF-8 iTXt before the image data
 */
export function encodePng(
  rgba: Uint8Array,
  width: number,
  height: number,
  texts: Readonly<Record<string, string>> = {},
): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new RangeError(
      `Expected ${String(width * height * 4)} bytes of RGBA, got ${String(rgba.length)}.`,
    );
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  // compression, filter and interlace methods are all 0.

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    // Filter type 0 (none) leads each row.
    Buffer.from(rgba.buffer, rgba.byteOffset + row * stride, stride).copy(
      raw,
      row * (stride + 1) + 1,
    );
  }

  const textChunks = Object.entries(texts).map(([keyword, text]) =>
    chunk(
      'iTXt',
      Buffer.concat([
        Buffer.from(keyword, 'latin1'),
        Buffer.from([0, 0, 0, 0, 0]),
        Buffer.from(text, 'utf8'),
      ]),
    ),
  );
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    ...textChunks,
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
