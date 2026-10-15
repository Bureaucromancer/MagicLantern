// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * What sharp does for the store (A27): tell what an image is, prove it
 * decodes, make its thumbnail, and cut crops. Hashing never goes through
 * sharp (pixel-hash.ts), and sharp never rewrites an asset's own bytes:
 * uploads are stored as sent and outputs as the backend made them.
 *
 * Every decode is bounded by {@link MAX_INPUT_PIXELS}, so a small file that
 * claims a huge canvas is refused before it is allocated.
 */

import sharp, { type Metadata } from 'sharp';

/**
 * The most pixels (of one frame) an image may have: 8192 × 8192. Sharp's own
 * default is about four times this; pngjs decodes to four bytes a pixel, and
 * this keeps that at 256 MB.
 */
export const MAX_INPUT_PIXELS = 8192 * 8192;

/** The thumbnails' longer side, in pixels. */
export const THUMBNAIL_SIZE = 384;

export const THUMBNAIL_MEDIA_TYPE = 'image/webp';

// The store decodes each file once or twice and never again; libvips'
// operation cache would only hold memory.
sharp.cache(false);

/** The raster formats Lantern takes, by sharp's name for them. */
const ACCEPTED: Readonly<Record<string, { mediaType: string; extension: string }>> = {
  png: { mediaType: 'image/png', extension: 'png' },
  jpeg: { mediaType: 'image/jpeg', extension: 'jpg' },
  webp: { mediaType: 'image/webp', extension: 'webp' },
  gif: { mediaType: 'image/gif', extension: 'gif' },
  // sharp reports AVIF as heif; anything else in a HEIF container is refused below.
  heif: { mediaType: 'image/avif', extension: 'avif' },
};

/** The file extension for each media type Lantern stores. */
export const EXTENSIONS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.values(ACCEPTED).map(({ mediaType, extension }) => [mediaType, extension]),
);

/** Why an image was refused, as an issue message for `/file`. */
export class ImageRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageRefusedError';
  }
}

export interface ImageFacts {
  readonly mediaType: string;
  readonly width: number;
  /** Of one frame. */
  readonly height: number;
  /** Frames in an animation; null for a still image. */
  readonly frames: number | null;
}

/**
 * What the bytes are, after proving the whole image decodes: the header alone
 * would pass a truncated file.
 *
 * @throws ImageRefusedError for anything that is not an accepted raster
 *   format, does not decode, or has more than {@link MAX_INPUT_PIXELS}
 */
export async function inspectImage(bytes: Uint8Array): Promise<ImageFacts> {
  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, { limitInputPixels: false }).metadata();
  } catch {
    throw new ImageRefusedError('is not an image Lantern can read');
  }
  const format = metadata.format;
  const accepted = ACCEPTED[format];
  if (accepted === undefined || (format === 'heif' && metadata.compression !== 'av1')) {
    throw new ImageRefusedError(
      `is ${format === 'svg' ? 'a vector image' : `in a format Lantern does not take (${format})`}; send PNG, JPEG, WebP, GIF or AVIF`,
    );
  }
  const width = metadata.width;
  const pages = metadata.pages ?? 1;
  const height = pages > 1 ? (metadata.pageHeight ?? metadata.height) : metadata.height;
  if (width * height > MAX_INPUT_PIXELS) {
    throw new ImageRefusedError(
      `has ${String(width)} × ${String(height)} pixels, more than the ${String(MAX_INPUT_PIXELS)} Lantern takes`,
    );
  }
  try {
    // Decodes every pixel of the first frame; a truncated or corrupt file fails here.
    await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).stats();
  } catch {
    throw new ImageRefusedError('is damaged: it does not decode');
  }
  return { mediaType: accepted.mediaType, width, height, frames: pages > 1 ? pages : null };
}

/**
 * The thumbnail: the first frame, turned upright by its EXIF orientation,
 * fitted inside {@link THUMBNAIL_SIZE} without enlarging, as WebP.
 */
export async function makeThumbnail(bytes: Uint8Array): Promise<Buffer> {
  return await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
    .autoOrient()
    .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}

/** A normalised rectangle (`SourceRect`). */
export interface NormalisedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The pixel rectangle a normalised crop covers, by one fixed rounding rule
 * (A7), so the same crop of the same image is always the same asset: the
 * left and top edges round down, the right and bottom edges round up, and
 * the result is clamped to the image and at least one pixel each way.
 */
export function cropPixels(
  rect: NormalisedRect,
  size: { readonly width: number; readonly height: number },
): { left: number; top: number; width: number; height: number } {
  const left = Math.min(Math.floor(rect.x * size.width), size.width - 1);
  const top = Math.min(Math.floor(rect.y * size.height), size.height - 1);
  const right = Math.min(Math.ceil((rect.x + rect.width) * size.width), size.width);
  const bottom = Math.min(Math.ceil((rect.y + rect.height) * size.height), size.height);
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

/**
 * A crop as a new PNG (lossless, so the crop is exactly the source's pixels).
 * The source is turned upright first, so the rectangle means what a person
 * saw when they drew it.
 */
export async function cropToPng(bytes: Uint8Array, rect: NormalisedRect): Promise<Buffer> {
  const { autoOrient: size } = await sharp(bytes, {
    limitInputPixels: MAX_INPUT_PIXELS,
  }).metadata();
  return await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
    .autoOrient()
    .extract(cropPixels(rect, size))
    .png({ compressionLevel: 9 })
    .toBuffer();
}
