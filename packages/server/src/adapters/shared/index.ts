// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/** What every adapter and manager may import besides the schema (rule 9). */

export {
  errorText,
  HttpStatusError,
  joinUrl,
  request,
  requestOk,
  retryAfterSeconds,
  type FetchLike,
  type RequestOptions,
} from './http.js';
export { encodePng } from './png-encode.js';
export { MAX_PNG_TEXT_BYTES, readPngText, type PngTextEntry } from './png-text.js';
export * from './types.js';
export {
  assetPlaceholder,
  fillPlaceholders,
  isAssetPlaceholder,
  placeholderIds,
  type AssetPlaceholder,
} from './wire.js';
