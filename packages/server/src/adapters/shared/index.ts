// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/** What every adapter may import besides the schema (rule 9). */

export { encodePng } from './png-encode.js';
export * from './types.js';
export {
  assetPlaceholder,
  fillPlaceholders,
  isAssetPlaceholder,
  placeholderIds,
  type AssetPlaceholder,
} from './wire.js';
