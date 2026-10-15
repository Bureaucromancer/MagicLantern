// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  cropPixels,
  cropToPng,
  ImageRefusedError,
  inspectImage,
  makeThumbnail,
  MAX_INPUT_PIXELS,
  THUMBNAIL_SIZE,
} from './media.js';
import { PIXEL_HASH_ALG, pngPixelHash } from './pixel-hash.js';
import { makeImage, makePng, pixels, SVG } from './test-images.js';

describe('inspectImage', () => {
  it.each([
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
    ['gif', 'image/gif'],
    ['avif', 'image/avif'],
  ] as const)('takes %s', async (format, mediaType) => {
    const bytes = format === 'png' ? makePng(10, 6) : await makeImage(format, 10, 6);
    expect(await inspectImage(bytes)).toEqual({ mediaType, width: 10, height: 6, frames: null });
  });

  it('counts the frames of an animation and gives the size of one', async () => {
    const frame = (seed: number) =>
      sharp(pixels(6, 4, seed), { raw: { width: 6, height: 4, channels: 4 } })
        .png()
        .toBuffer();
    const animated = await sharp([await frame(1), await frame(2), await frame(3)], {
      join: { animated: true },
    })
      .gif()
      .toBuffer();
    expect(await inspectImage(animated)).toEqual({
      mediaType: 'image/gif',
      width: 6,
      height: 4,
      frames: 3,
    });
  });

  it('refuses a vector image', async () => {
    await expect(inspectImage(SVG)).rejects.toThrow(/vector image/);
  });

  it('refuses formats Lantern does not take', async () => {
    await expect(inspectImage(await makeImage('tiff'))).rejects.toThrow(/does not take \(tiff\)/);
  });

  it('refuses what is not an image', async () => {
    await expect(inspectImage(Buffer.from('hello'))).rejects.toThrow(ImageRefusedError);
  });

  it('refuses a truncated file that only its header would pass', async () => {
    const jpeg = await makeImage('jpeg', 64, 64);
    await expect(inspectImage(jpeg.subarray(0, jpeg.length / 2))).rejects.toThrow(/damaged/);
  });

  it('refuses more pixels than the limit, before decoding them', async () => {
    const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 1;
    const huge = await sharp({
      create: { width: side, height: side, channels: 3, background: '#000' },
      limitInputPixels: false,
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await expect(inspectImage(huge)).rejects.toThrow(/more than/);
  }, 30_000);
});

describe('makeThumbnail', () => {
  it('fits the longer side to the thumbnail size, as WebP', async () => {
    const thumbnail = await makeThumbnail(makePng(800, 400));
    expect(await sharp(thumbnail).metadata()).toMatchObject({
      format: 'webp',
      width: THUMBNAIL_SIZE,
      height: THUMBNAIL_SIZE / 2,
    });
  });

  it('never enlarges a small image', async () => {
    const thumbnail = await makeThumbnail(makePng(20, 10));
    expect(await sharp(thumbnail).metadata()).toMatchObject({ width: 20, height: 10 });
  });
});

describe('crops (A7)', () => {
  it.each([
    // Edges round outwards: left and top down, right and bottom up.
    [
      { x: 0, y: 0, width: 1, height: 1 },
      { left: 0, top: 0, width: 10, height: 10 },
    ],
    [
      { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      { left: 2, top: 2, width: 6, height: 6 },
    ],
    [
      { x: 0.11, y: 0.19, width: 0.01, height: 0.01 },
      { left: 1, top: 1, width: 1, height: 1 },
    ],
    [
      { x: 0.99, y: 0.99, width: 0.01, height: 0.01 },
      { left: 9, top: 9, width: 1, height: 1 },
    ],
  ])('turn %o into whole pixels as %o', (rect, expected) => {
    expect(cropPixels(rect, { width: 10, height: 10 })).toEqual(expected);
  });

  it('cut exactly the source pixels, losslessly', async () => {
    const source = makePng(10, 10, { seed: 7 });
    const crop = await cropToPng(source, { x: 0.2, y: 0.3, width: 0.5, height: 0.4 });
    const { data, info } = await sharp(crop).raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 5, height: 4 });
    const all = pixels(10, 10, 7);
    const expected = Buffer.alloc(5 * 4 * 4);
    for (let row = 0; row < 4; row += 1) {
      all.copy(expected, row * 5 * 4, ((row + 3) * 10 + 2) * 4, ((row + 3) * 10 + 7) * 4);
    }
    expect(data.equals(expected)).toBe(true);
  });
});

describe('the pixel hash (A25)', () => {
  it('ignores metadata', () => {
    const plain = makePng(8, 8, { seed: 3 });
    const tagged = makePng(8, 8, { seed: 3, texts: { parameters: 'a cat' } });
    expect(plain.equals(tagged)).toBe(false);
    expect(pngPixelHash(tagged)).toBe(pngPixelHash(plain));
  });

  it('is the same for the same pixels in another PNG encoding', () => {
    const rgba = makePng(8, 8, { seed: 3 });
    const rgb = makePng(8, 8, { seed: 3, colorType: 2 });
    expect(rgb.equals(rgba)).toBe(false);
    // Opaque pixels: RGB expands to the same RGBA.
    expect(pngPixelHash(rgb)).toBe(pngPixelHash(rgba));
  });

  it('differs when a pixel differs, or the shape does', () => {
    expect(pngPixelHash(makePng(8, 8, { seed: 3 }))).not.toBe(
      pngPixelHash(makePng(8, 8, { seed: 4 })),
    );
    // Same 64 pixels, another shape.
    const square = makePng(8, 8, { seed: 3 });
    const wide = makePng(16, 4, { seed: 3 });
    expect(pngPixelHash(square)).not.toBe(pngPixelHash(wide));
  });

  it('is tagged with its algorithm', () => {
    expect(PIXEL_HASH_ALG).toMatch(/^sha256-rgba8-pngjs\/\d+$/);
  });
});
