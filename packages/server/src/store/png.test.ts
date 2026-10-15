// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  decodeText,
  hasKeyword,
  isLatin1,
  iTXtChunk,
  MAX_TEXT_BYTES,
  PngError,
  pngFrames,
  pngSize,
  readChunks,
  readTexts,
  textChunk,
  trailingBytes,
  withTextChunks,
  writeChunks,
  type PngChunk,
} from './png.js';
import { makePng } from './test-images.js';

function chunk(type: string, data: Buffer): PngChunk {
  return { type, data };
}

function zTXt(keyword: string, inflated: Buffer): PngChunk {
  return chunk(
    'zTXt',
    Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0, 0]), deflateSync(inflated)]),
  );
}

describe('readChunks and writeChunks', () => {
  it('round-trip a file byte for byte', () => {
    const png = makePng(16, 9, { texts: { parameters: 'a cat' } });
    expect(writeChunks(readChunks(png)).equals(png)).toBe(true);
  });

  it('read IHDR first and IEND last, and the size from IHDR', () => {
    const chunks = readChunks(makePng(16, 9));
    expect(chunks[0]?.type).toBe('IHDR');
    expect(chunks.at(-1)?.type).toBe('IEND');
    expect(pngSize(chunks)).toEqual({ width: 16, height: 9 });
    expect(pngFrames(chunks)).toBeNull();
  });

  it('refuse a file that is not a PNG', () => {
    expect(() => readChunks(Buffer.from('GIF89a……'))).toThrow(PngError);
  });

  it('refuse a truncated file', () => {
    const png = makePng();
    expect(() => readChunks(png.subarray(0, png.length - 5))).toThrow(/truncated/);
  });

  it('refuse a chunk whose CRC does not match', () => {
    const png = Buffer.from(makePng());
    // A byte inside IHDR's data.
    png[16] = (png[16] ?? 0) ^ 0xff;
    expect(() => readChunks(png)).toThrow(/IHDR chunk is damaged/);
  });

  it('read a file with bytes after IEND, and say how many', () => {
    const png = Buffer.concat([makePng(), Buffer.from('trailer')]);
    expect(readChunks(png).at(-1)?.type).toBe('IEND');
    expect(trailingBytes(png)).toBe(7);
  });

  it('refuse to write a chunk type that is not four letters', () => {
    expect(() => writeChunks([chunk('IDAT1', Buffer.alloc(0))])).toThrow(PngError);
  });
});

describe('text chunks', () => {
  it('decode tEXt as Latin-1', () => {
    expect(decodeText(textChunk('Comment', 'café'))).toEqual({
      type: 'tEXt',
      keyword: 'Comment',
      text: 'café',
    });
  });

  it('write text that is not Latin-1 as uncompressed iTXt (A24)', () => {
    const written = textChunk('parameters', 'a 猫, (masterpiece:1.2)');
    expect(written.type).toBe('iTXt');
    expect(decodeText(written).text).toBe('a 猫, (masterpiece:1.2)');
    expect(isLatin1('a 猫')).toBe(false);
    expect(isLatin1('naïve')).toBe(true);
  });

  it('decode zTXt', () => {
    expect(decodeText(zTXt('Comment', Buffer.from('zipped'))).text).toBe('zipped');
  });

  it('decode compressed and uncompressed iTXt as UTF-8', () => {
    for (const compress of [true, false]) {
      const written = iTXtChunk('lantern', '{"prompt":"猫"}', compress);
      expect(decodeText(written)).toEqual({
        type: 'iTXt',
        keyword: 'lantern',
        language: '',
        translatedKeyword: '',
        text: '{"prompt":"猫"}',
      });
    }
  });

  it('cap what one chunk may inflate to', () => {
    const bomb = zTXt('bomb', Buffer.alloc(MAX_TEXT_BYTES + 1, 0x41));
    // Kilobytes on disk, past the cap when inflated.
    expect(bomb.data.length).toBeLessThan(64 * 1024);
    expect(() => decodeText(bomb)).toThrow(/more than/);
  });

  it('read every text chunk that decodes and skip the rest by keyword', () => {
    const chunks = [
      ...readChunks(makePng()),
      textChunk('parameters', 'steps: 20'),
      zTXt('bomb', Buffer.alloc(MAX_TEXT_BYTES + 1)),
    ];
    const { texts, skipped } = readTexts(chunks);
    expect(texts.map((text) => [text.keyword, text.text])).toEqual([['parameters', 'steps: 20']]);
    expect(skipped).toEqual(['bomb']);
  });

  it('refuse keywords PNG does not allow', () => {
    for (const keyword of ['', ' lead', 'trail ', 'two  spaces', 'x'.repeat(80), 'tab\t']) {
      expect(() => textChunk(keyword, 'text'), JSON.stringify(keyword)).toThrow(PngError);
    }
  });
});

describe('withTextChunks', () => {
  const backend = makePng(12, 12, { texts: { parameters: 'a cat\nSteps: 20' } });
  const added = iTXtChunk('lantern', '{"job_id":"job_1"}', true);

  it('puts the chunk before the first IDAT and keeps every other chunk byte for byte (rule 7)', () => {
    const before = readChunks(backend);
    const after = readChunks(withTextChunks(backend, [added]));
    const firstData = after.findIndex((item) => item.type === 'IDAT');
    expect(after[firstData - 1]).toEqual(added);
    expect(after.filter((item) => item !== after[firstData - 1])).toEqual(before);
  });

  it('replaces an earlier chunk with the same keyword, so a file holds one', () => {
    const once = withTextChunks(backend, [added]);
    const twice = withTextChunks(once, [iTXtChunk('lantern', '{"job_id":"job_2"}', true)]);
    const lantern = readChunks(twice).filter((item) => hasKeyword(item, 'lantern'));
    expect(lantern.map((item) => decodeText(item).text)).toEqual(['{"job_id":"job_2"}']);
  });

  it('writes valid CRCs (every one is checked on read)', () => {
    expect(() => readChunks(withTextChunks(backend, [added]))).not.toThrow();
  });

  it('refuses a PNG with no image data', () => {
    const noData = writeChunks(readChunks(makePng()).filter((item) => item.type !== 'IDAT'));
    expect(() => withTextChunks(noData, [added])).toThrow(/no image data/);
  });
});
