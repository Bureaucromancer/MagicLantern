// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Images for the store's tests, drawn rather than checked in: deterministic
 * pixels from a seed, encoded by pngjs (pure JavaScript, so the bytes are the
 * same on every platform), plus sharp for the other formats.
 */

import { PNG, type ColorType } from 'pngjs';
import sharp from 'sharp';

import { textChunk, withTextChunks } from './png.js';

/** A deterministic RGBA pattern. */
export function pixels(width: number, height: number, seed = 1): Buffer {
  const data = Buffer.alloc(width * height * 4);
  let state = seed >>> 0 || 1;
  for (let index = 0; index < data.length; index += 4) {
    // xorshift32: cheap, and the same everywhere.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    data[index] = state & 0xff;
    data[index + 1] = (state >>> 8) & 0xff;
    data[index + 2] = (state >>> 16) & 0xff;
    data[index + 3] = 0xff;
  }
  return data;
}

export interface PngOptions {
  readonly seed?: number;
  /** pngjs colour type: 6 RGBA (default), 2 RGB. */
  readonly colorType?: ColorType;
  /** Text chunks a backend would write, e.g. `{ parameters: '…' }`. */
  readonly texts?: Readonly<Record<string, string>>;
}

/** A PNG, as a backend might return it. */
export function makePng(width = 8, height = 8, options: PngOptions = {}): Buffer {
  const png = new PNG({ width, height, colorType: options.colorType ?? 6 });
  pixels(width, height, options.seed).copy(png.data);
  const encoded = PNG.sync.write(png, { colorType: options.colorType ?? 6 });
  const texts = Object.entries(options.texts ?? {});
  return texts.length === 0
    ? encoded
    : withTextChunks(
        encoded,
        texts.map(([keyword, text]) => textChunk(keyword, text)),
      );
}

/** The same pixels in another format. */
export async function makeImage(
  format: 'jpeg' | 'webp' | 'gif' | 'avif' | 'tiff',
  width = 8,
  height = 8,
  seed = 1,
): Promise<Buffer> {
  return await sharp(pixels(width, height, seed), { raw: { width, height, channels: 4 } })
    .toFormat(format)
    .toBuffer();
}

export const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>',
);
