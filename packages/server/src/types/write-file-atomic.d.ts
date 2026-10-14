// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * `write-file-atomic@8` ships no types, and the DefinitelyTyped package is
 * pinned to v4, whose signatures no longer match. Hand-written instead,
 * declaring only the surface store/atomic.ts calls; check the implementation
 * before adding to it rather than guessing.
 */
declare module 'write-file-atomic' {
  interface Options {
    /** Mode for the temp file, applied with chmod (so the umask does not narrow it). */
    mode?: number | undefined;
    chown?: { uid: number; gid: number } | false | undefined;
    encoding?: BufferEncoding | undefined;
    /** Defaults to true. Turning it off trades durability for speed. */
    fsync?: boolean | undefined;
    tmpfileCreated?: ((tmpfile: string) => void) | undefined;
  }

  function writeFileAtomic(
    filename: string,
    data: string | NodeJS.ArrayBufferView,
    options?: Options,
  ): Promise<void>;

  export = writeFileAtomic;
}
