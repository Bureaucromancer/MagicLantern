// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Reading a PNG's text chunks, for adapters that parse what a backend wrote
 * into its images (sd-server's `parameters`). Read-only and zlib-only, so it
 * stays inside this folder (rule 9); the store's codec does the writing.
 *
 * Text is decoded as the bytes allow rather than as the specification says:
 * tEXt is Latin-1 by the book, but sd-server writes its prompts there as
 * UTF-8, so a tEXt that is valid UTF-8 is read as UTF-8. Decompression is
 * capped, so a few bytes of zlib cannot become gigabytes.
 */

import { inflateSync } from 'node:zlib';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The most text one chunk may inflate to. */
export const MAX_PNG_TEXT_BYTES = 4 * 1024 * 1024;

export interface PngTextEntry {
  readonly type: 'tEXt' | 'zTXt' | 'iTXt';
  readonly keyword: string;
  readonly text: string;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 when the bytes are valid UTF-8, else Latin-1. */
function looseText(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    return Buffer.from(bytes).toString('latin1');
  }
}

function inflate(bytes: Uint8Array): Buffer {
  return inflateSync(bytes, { maxOutputLength: MAX_PNG_TEXT_BYTES });
}

function decode(type: PngTextEntry['type'], data: Buffer): PngTextEntry | null {
  const keywordEnd = data.indexOf(0);
  if (keywordEnd <= 0) return null;
  const keyword = data.subarray(0, keywordEnd).toString('latin1');
  if (type === 'tEXt') return { type, keyword, text: looseText(data.subarray(keywordEnd + 1)) };
  if (type === 'zTXt') {
    return { type, keyword, text: looseText(inflate(data.subarray(keywordEnd + 2))) };
  }
  // iTXt: keyword, NUL, compression flag, method, language, NUL, translated keyword, NUL, text.
  const compressed = data[keywordEnd + 1] === 1;
  const languageEnd = data.indexOf(0, keywordEnd + 3);
  if (languageEnd < 0) return null;
  const translatedEnd = data.indexOf(0, languageEnd + 1);
  if (translatedEnd < 0) return null;
  const body = data.subarray(translatedEnd + 1);
  return { type, keyword, text: (compressed ? inflate(body) : body).toString('utf8') };
}

/**
 * The text chunks of a PNG, in file order. Not a PNG, or a malformed one:
 * an empty list, never a throw, because metadata is a bonus.
 */
export function readPngText(bytes: Uint8Array): PngTextEntry[] {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (input.length < 8 || SIGNATURE.some((byte, i) => input[i] !== byte)) return [];
  const entries: PngTextEntry[] = [];
  let at = 8;
  while (at + 12 <= input.length) {
    const length = input.readUInt32BE(at);
    const type = input.subarray(at + 4, at + 8).toString('latin1');
    const end = at + 12 + length;
    if (end > input.length) break;
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      try {
        const entry = decode(type, input.subarray(at + 8, at + 8 + length));
        if (entry !== null) entries.push(entry);
      } catch {
        // A chunk that will not inflate is skipped, not fatal.
      }
    }
    if (type === 'IEND') break;
    at = end;
  }
  return entries;
}
