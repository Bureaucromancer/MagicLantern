// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Measuring a request's inputs for the resolver, so the init image gives the
 * output size where the mode takes it from there (A4): the asset's stored
 * size, cut down to its crop by the same rounding rule the crop itself is
 * cut with (A7), so the derived size is exactly the derived asset's.
 */

import { cropPixels, type LibraryRegistry } from '../../store/index.js';
import type { InputSizer } from '../resolver/index.js';

/**
 * Sizes inputs from a library, or from any other library holding the asset
 * (it is copied in at submit, A22).
 *
 * @param libraries every library
 * @param libraryId the library the request is for
 */
export function inputSizer(libraries: LibraryRegistry, libraryId: string): InputSizer {
  return (input) => {
    const own = libraries.library(libraryId)?.getAsset(input.asset_id);
    const record =
      own ??
      libraries
        .list()
        .map((entry) => libraries.library(entry.id)?.getAsset(input.asset_id))
        .find((found) => found !== undefined);
    if (record?.width === null || record?.height === null || record === undefined) return undefined;
    const size = { width: record.width, height: record.height };
    if (input.crop === undefined) return size;
    const cropped = cropPixels(input.crop, size);
    return { width: cropped.width, height: cropped.height };
  };
}
