// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * A small PNG chunk codec (ST3, A24): split a file into chunks, read its text
 * chunks, and insert ours, without touching the image data. Rule 7: the
 * backend's pixels are kept byte for byte, so metadata is added at the chunk
 * level and every other chunk is written back exactly as it was read.
 *
 * Written over `node:zlib` rather than png-chunks-extract and
 * png-chunks-encode, which the plan named: Node has had `zlib.crc32` since
 * 22.2, which was those packages' one real job, and what is left is a loop
 * over length, type, data and CRC. That is one dependency fewer for the
 * tarball (rule 8), and the text chunks needed their own code anyway, since
 * png-chunk-text writes only tEXt.
 *
 * Text chunks (PNG 1.2 §11.3.4, PNG 3rd edition §11.3.3):
 * - tEXt: Latin-1 keyword, NUL, Latin-1 text.
 * - zTXt: keyword, NUL, method (0), zlib data of Latin-1 text.
 * - iTXt: keyword, NUL, compression flag, method, language tag, NUL,
 *   translated keyword (UTF-8), NUL, text (UTF-8, zlib when flagged).
 *
 * Inflating is capped ({@link MAX_TEXT_BYTES}): a few kilobytes of zlib can
 * claim gigabytes, and these files come from backends and uploads.
 */

import { crc32, deflateSync, inflateSync } from 'node:zlib';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The most text one chunk may inflate to. Lantern's own chunk is a few tens of kilobytes. */
export const MAX_TEXT_BYTES = 8 * 1024 * 1024;

/** The keyword of Lantern's own chunk. */
export const LANTERN_KEYWORD = 'lantern';

/** A chunk as it appears in the file. `data` is a view into the input; copy it to keep it. */
export interface PngChunk {
  readonly type: string;
  readonly data: Buffer;
}

/** The file is not a PNG this codec can read; the message says why, without the bytes. */
export class PngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngError';
  }
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.equals(bytes.subarray(0, 8));
}

/**
 * Every chunk up to and including IEND, with lengths and CRCs checked.
 * Anything after IEND is dropped (it is not part of the image, and a file
 * with a trailer is still read), but the caller decides whether that matters:
 * see {@link trailingBytes}.
 *
 * @throws PngError for a file that is not a PNG, is truncated, has a bad CRC,
 *   or does not start with IHDR and end with IEND
 */
export function readChunks(input: Uint8Array): PngChunk[] {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!isPng(bytes)) throw new PngError('The file is not a PNG (its signature is wrong).');

  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  for (;;) {
    if (offset + 12 > bytes.length) throw new PngError('The PNG is truncated.');
    const length = bytes.readUInt32BE(offset);
    if (length > 0x7fffffff) throw new PngError('A PNG chunk claims an impossible length.');
    const end = offset + 12 + length;
    if (end > bytes.length) throw new PngError('The PNG is truncated.');
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    if (!typeBytes.every((byte) => isLetter(byte))) {
      throw new PngError('A PNG chunk has a type that is not four letters.');
    }
    const type = typeBytes.toString('latin1');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expected = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(data, crc32(typeBytes)) !== expected) {
      throw new PngError(`The PNG's ${type} chunk is damaged (its CRC does not match).`);
    }
    if (chunks.length === 0 && type !== 'IHDR') {
      throw new PngError('The PNG does not start with an IHDR chunk.');
    }
    chunks.push({ type, data });
    offset = end;
    if (type === 'IEND') break;
  }
  return chunks;
}

/** How many bytes follow IEND; 0 for a well-formed file. */
export function trailingBytes(input: Uint8Array): number {
  return input.byteLength - encodedLength(readChunks(input));
}

function encodedLength(chunks: readonly PngChunk[]): number {
  return chunks.reduce((total, chunk) => total + 12 + chunk.data.length, PNG_SIGNATURE.length);
}

function isLetter(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

/** The file again: signature, then each chunk with its length and a fresh CRC. */
export function writeChunks(chunks: readonly PngChunk[]): Buffer {
  const out = Buffer.allocUnsafe(encodedLength(chunks));
  PNG_SIGNATURE.copy(out, 0);
  let offset = PNG_SIGNATURE.length;
  for (const chunk of chunks) {
    const type = Buffer.from(chunk.type, 'latin1');
    if (type.length !== 4 || !type.every((byte) => isLetter(byte))) {
      throw new PngError(`"${chunk.type}" is not a PNG chunk type.`);
    }
    out.writeUInt32BE(chunk.data.length, offset);
    type.copy(out, offset + 4);
    chunk.data.copy(out, offset + 8);
    out.writeUInt32BE(crc32(chunk.data, crc32(type)), offset + 8 + chunk.data.length);
    offset += 12 + chunk.data.length;
  }
  return out;
}

/** Width and height from IHDR. */
export function pngSize(chunks: readonly PngChunk[]): { width: number; height: number } {
  const header = chunks[0];
  if (header?.type !== 'IHDR' || header.data.length !== 13) {
    throw new PngError('The PNG has no valid IHDR chunk.');
  }
  const width = header.data.readUInt32BE(0);
  const height = header.data.readUInt32BE(4);
  if (width === 0 || height === 0) throw new PngError('The PNG has no pixels.');
  return { width, height };
}

/** Frames, from an APNG's acTL chunk; null for a still PNG. */
export function pngFrames(chunks: readonly PngChunk[]): number | null {
  const control = chunks.find((chunk) => chunk.type === 'acTL');
  if (control === undefined || control.data.length < 8) return null;
  const frames = control.data.readUInt32BE(0);
  return frames > 1 ? frames : null;
}

// ---------------------------------------------------------------------------
// Text chunks
// ---------------------------------------------------------------------------

/** One text chunk, decoded. */
export interface PngText {
  readonly type: 'tEXt' | 'zTXt' | 'iTXt';
  readonly keyword: string;
  readonly text: string;
  /** iTXt only. */
  readonly language?: string;
  readonly translatedKeyword?: string;
}

const TEXT_TYPES = new Set(['tEXt', 'zTXt', 'iTXt']);

function inflateCapped(data: Uint8Array, keyword: string): Buffer {
  try {
    return inflateSync(data, { maxOutputLength: MAX_TEXT_BYTES });
  } catch (error) {
    if (
      error instanceof RangeError ||
      (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
    ) {
      throw new PngError(
        `The PNG's "${keyword}" text inflates to more than ${String(MAX_TEXT_BYTES)} bytes.`,
      );
    }
    throw new PngError(`The PNG's "${keyword}" text is not valid zlib data.`);
  }
}

/** The index of the first NUL at or after `from`, or a thrown error naming what was being read. */
function nulAt(data: Buffer, from: number, what: string): number {
  const at = data.indexOf(0, from);
  if (at === -1) throw new PngError(`A PNG text chunk has no NUL after its ${what}.`);
  return at;
}

/**
 * Decodes one text chunk.
 *
 * @throws PngError for a malformed chunk or one that inflates past the cap
 */
export function decodeText(chunk: PngChunk): PngText {
  const { data } = chunk;
  const type = chunk.type;
  if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt') {
    throw new PngError(`A ${type} chunk is not a text chunk.`);
  }
  const keywordEnd = nulAt(data, 0, 'keyword');
  const keyword = data.subarray(0, keywordEnd).toString('latin1');

  if (type === 'tEXt') {
    return { type, keyword, text: data.subarray(keywordEnd + 1).toString('latin1') };
  }
  if (type === 'zTXt') {
    if (data[keywordEnd + 1] !== 0) throw new PngError('A zTXt chunk names an unknown method.');
    return {
      type,
      keyword,
      text: inflateCapped(data.subarray(keywordEnd + 2), keyword).toString('latin1'),
    };
  }

  const compressed = data[keywordEnd + 1];
  const method = data[keywordEnd + 2];
  if ((compressed !== 0 && compressed !== 1) || method !== 0) {
    throw new PngError('An iTXt chunk has an unknown compression flag or method.');
  }
  const languageEnd = nulAt(data, keywordEnd + 3, 'language tag');
  const translatedEnd = nulAt(data, languageEnd + 1, 'translated keyword');
  const body = data.subarray(translatedEnd + 1);
  return {
    type,
    keyword,
    language: data.subarray(keywordEnd + 3, languageEnd).toString('latin1'),
    translatedKeyword: data.subarray(languageEnd + 1, translatedEnd).toString('utf8'),
    text: (compressed === 1 ? inflateCapped(body, keyword) : body).toString('utf8'),
  };
}

/**
 * Every text chunk that decodes, in file order. One that does not (damaged,
 * or over the inflate cap) is reported in `skipped` by keyword where it has
 * one, and the rest are still read: a backend's odd chunk must not cost the
 * output.
 */
export function readTexts(chunks: readonly PngChunk[]): {
  texts: PngText[];
  skipped: string[];
} {
  const texts: PngText[] = [];
  const skipped: string[] = [];
  for (const chunk of chunks) {
    if (!TEXT_TYPES.has(chunk.type)) continue;
    try {
      texts.push(decodeText(chunk));
    } catch (error) {
      const end = chunk.data.indexOf(0);
      skipped.push(
        end > 0
          ? chunk.data.subarray(0, end).toString('latin1')
          : error instanceof Error
            ? error.message
            : chunk.type,
      );
    }
  }
  return { texts, skipped };
}

/** PNG keywords: 1 to 79 printable Latin-1 characters, no leading, trailing or double spaces. */
function assertKeyword(keyword: string): void {
  const valid =
    keyword.length >= 1 &&
    keyword.length <= 79 &&
    /^[\x20-\x7e\xa1-\xff]+$/.test(keyword) &&
    !keyword.startsWith(' ') &&
    !keyword.endsWith(' ') &&
    !keyword.includes('  ');
  if (!valid) throw new PngError(`"${keyword}" is not a valid PNG text keyword.`);
}

/** Whether every character is Latin-1 and none is a NUL (which tEXt cannot carry). */
export function isLatin1(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0 || code > 0xff) return false;
  }
  return true;
}

/**
 * An iTXt chunk, zlib-compressed when `compress` is set (Lantern's own chunk
 * always is), with no language tag or translated keyword.
 */
export function iTXtChunk(keyword: string, text: string, compress: boolean): PngChunk {
  assertKeyword(keyword);
  const body = Buffer.from(text, 'utf8');
  return {
    type: 'iTXt',
    data: Buffer.concat([
      Buffer.from(keyword, 'latin1'),
      // NUL, compression flag, method 0, empty language tag's NUL, empty translated keyword's NUL.
      Buffer.from([0, compress ? 1 : 0, 0, 0, 0]),
      compress ? deflateSync(body, { level: 9 }) : body,
    ]),
  };
}

/**
 * A text chunk the way A1111 writes `parameters` (A24): tEXt when the text is
 * Latin-1, else uncompressed iTXt, since tEXt cannot carry anything else.
 */
export function textChunk(keyword: string, text: string): PngChunk {
  if (!isLatin1(text)) return iTXtChunk(keyword, text, false);
  assertKeyword(keyword);
  return {
    type: 'tEXt',
    data: Buffer.concat([
      Buffer.from(keyword, 'latin1'),
      Buffer.from([0]),
      Buffer.from(text, 'latin1'),
    ]),
  };
}

/** Whether a chunk is a text chunk with this keyword (read without inflating). */
export function hasKeyword(chunk: PngChunk, keyword: string): boolean {
  if (!TEXT_TYPES.has(chunk.type)) return false;
  const end = chunk.data.indexOf(0);
  return end !== -1 && chunk.data.subarray(0, end).toString('latin1') === keyword;
}

/**
 * The file with `added` placed before the first IDAT, where readers that stop
 * early still find them, and any earlier text chunk with the same keyword
 * removed, so a file holds one `lantern` chunk. Every other chunk, IDAT
 * included, is kept byte for byte (rule 7).
 */
export function withTextChunks(input: Uint8Array, added: readonly PngChunk[]): Buffer {
  const chunks = readChunks(input);
  const replaced = new Set(
    added.map((chunk) => {
      const end = chunk.data.indexOf(0);
      return chunk.data.subarray(0, end).toString('latin1');
    }),
  );
  const kept = chunks.filter(
    (chunk) => ![...replaced].some((keyword) => hasKeyword(chunk, keyword)),
  );
  const firstData = kept.findIndex((chunk) => chunk.type === 'IDAT');
  if (firstData === -1) throw new PngError('The PNG has no image data.');
  return writeChunks([...kept.slice(0, firstData), ...added, ...kept.slice(firstData)]);
}
