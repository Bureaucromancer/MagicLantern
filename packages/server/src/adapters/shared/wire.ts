// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Asset placeholders in wire requests (A15): `prepare` writes
 * `{"$asset": "<sha256>"}` where image bytes go, so `job_payloads.wire` stays
 * small; the engine fills each with the asset's bytes as base64 at submit.
 */

import { ASSET_ID_PATTERN } from '@bureaucromancer/lantern-schema';

const ASSET_ID = new RegExp(ASSET_ID_PATTERN);

export interface AssetPlaceholder {
  readonly $asset: string;
}

export function assetPlaceholder(assetId: string): AssetPlaceholder {
  if (!ASSET_ID.test(assetId)) throw new TypeError(`Not an asset id: "${assetId}".`);
  return { $asset: assetId };
}

/** Whether a value is a placeholder: an object with exactly the one `$asset` key. */
export function isAssetPlaceholder(value: unknown): value is AssetPlaceholder {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const id = (value as Record<string, unknown>)['$asset'];
  return keys.length === 1 && typeof id === 'string' && ASSET_ID.test(id);
}

/** Every asset id a wire request names, once each, in the order first met. */
export function placeholderIds(wire: unknown): string[] {
  const ids: string[] = [];
  const visit = (value: unknown): void => {
    if (isAssetPlaceholder(value)) {
      if (!ids.includes(value.$asset)) ids.push(value.$asset);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(wire);
  return ids;
}

/** A copy of the wire request with each placeholder replaced by its asset's bytes, base64. */
export function fillPlaceholders(wire: unknown, bytesOf: (assetId: string) => Uint8Array): unknown {
  const fill = (value: unknown): unknown => {
    if (isAssetPlaceholder(value)) return Buffer.from(bytesOf(value.$asset)).toString('base64');
    if (Array.isArray(value)) return value.map(fill);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item)]));
    }
    return value;
  };
  return fill(wire);
}
