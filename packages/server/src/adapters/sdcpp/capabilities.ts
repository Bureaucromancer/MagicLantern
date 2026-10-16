// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * sd-server's `GET /sdcpp/v1/capabilities` document, read tolerantly (SD1).
 *
 * The mode-aware fields (`supported_modes`, `defaults_by_mode`,
 * `features_by_mode`) are the interface; the top-level `defaults` and
 * `features` are deprecated mirrors of the current mode and are read only
 * when the mode-aware ones are missing. Features are detected, never
 * inferred from a version (there is no version endpoint): a missing flag is
 * an absent capability. Unknown fields are ignored, so a newer build's
 * additions change nothing until the mapping learns them.
 *
 * Values the server reports as `null` (`eta`, `flow_shift`, `img_cfg`) mean
 * "the model decides", and `"default"` for a sampler or scheduler means the
 * same: neither becomes a descriptor default.
 */

import type { ModelIdentity } from '../shared/types.js';

/** The capabilities, as the adapter uses them. */
export interface SdcppCapabilities {
  /** The main model file. sd-server reports only this one, not its VAE or encoders (L4). */
  readonly model: { readonly name: string; readonly stem: string; readonly path: string };
  /** Native modes: `img_gen`, `vid_gen`. */
  readonly supportedModes: readonly string[];
  /** `defaults_by_mode.img_gen`: the server's defaults, from its command line. */
  readonly imgDefaults: Readonly<Record<string, unknown>> | null;
  /** `features_by_mode.img_gen`: which request fields the server reads. */
  readonly imgFeatures: Readonly<Record<string, boolean>>;
  readonly imgOutputFormats: readonly string[];
  readonly samplers: readonly string[];
  readonly schedulers: readonly string[];
  /** LoRA files under the server's LoRA directory; `path` is what a request names. */
  readonly loras: readonly { readonly name: string; readonly path: string }[];
  /** Hires upscalers, built-in and model-backed, by the name a request uses. */
  readonly upscalers: readonly string[];
  /** Preview modes (`none`, `proj`, `tae`, `vae`); empty on builds without native previews. */
  readonly previewModes: readonly string[];
  readonly limits: {
    readonly minWidth: number;
    readonly maxWidth: number;
    readonly minHeight: number;
    readonly maxHeight: number;
    readonly maxBatchCount: number;
    readonly maxQueueSize: number | null;
  };
}

/** The document is not one sd-server's capabilities route would answer. */
export class CapabilitiesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilitiesError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function integer(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function booleans(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
    ),
  );
}

/**
 * Reads a capabilities document.
 *
 * @throws CapabilitiesError when it has no model or no image mode can be read from it
 */
export function parseCapabilities(document: unknown): SdcppCapabilities {
  if (!isRecord(document)) throw new CapabilitiesError('The capabilities are not a JSON object.');
  const model = document['model'];
  if (!isRecord(model) || typeof model['path'] !== 'string') {
    throw new CapabilitiesError('The capabilities name no model.');
  }

  const byMode = (key: string): Record<string, unknown> | undefined => {
    const map = document[key];
    return isRecord(map) && isRecord(map['img_gen']) ? map['img_gen'] : undefined;
  };
  const currentIsImage =
    document['current_mode'] === 'img_gen' || document['current_mode'] === undefined;
  const declared = strings(document['supported_modes']);
  const imgDefaults =
    byMode('defaults_by_mode') ??
    (currentIsImage && isRecord(document['defaults']) ? document['defaults'] : null);
  const supportedModes = declared.length > 0 ? declared : imgDefaults === null ? [] : ['img_gen'];

  const featuresMap = document['features_by_mode'];
  const imgFeatures = isRecord(featuresMap)
    ? booleans(featuresMap['img_gen'])
    : currentIsImage
      ? booleans(document['features'])
      : {};

  const formatsMap = document['output_formats_by_mode'];
  const imgOutputFormats = isRecord(formatsMap)
    ? strings(formatsMap['img_gen'])
    : strings(document['output_formats']);

  const limits = isRecord(document['limits']) ? document['limits'] : {};
  const loras = Array.isArray(document['loras'])
    ? document['loras'].flatMap((entry: unknown) =>
        isRecord(entry) && typeof entry['path'] === 'string' && entry['path'].length > 0
          ? [
              {
                name: typeof entry['name'] === 'string' ? entry['name'] : entry['path'],
                path: entry['path'],
              },
            ]
          : [],
      )
    : [];
  const upscalers = Array.isArray(document['upscalers'])
    ? document['upscalers'].flatMap((entry: unknown) =>
        isRecord(entry) && typeof entry['name'] === 'string' ? [entry['name']] : [],
      )
    : [];

  return {
    model: {
      name: typeof model['name'] === 'string' ? model['name'] : '',
      stem: typeof model['stem'] === 'string' ? model['stem'] : '',
      path: model['path'],
    },
    supportedModes,
    imgDefaults,
    imgFeatures,
    imgOutputFormats,
    samplers: strings(document['samplers']),
    schedulers: strings(document['schedulers']),
    loras,
    upscalers,
    previewModes: strings(document['preview_modes']),
    limits: {
      minWidth: integer(limits['min_width'], 64),
      maxWidth: integer(limits['max_width'], 4096),
      minHeight: integer(limits['min_height'], 64),
      maxHeight: integer(limits['max_height'], 4096),
      maxBatchCount: integer(limits['max_batch_count'], 8),
      maxQueueSize: typeof limits['max_queue_size'] === 'number' ? limits['max_queue_size'] : null,
    },
  };
}

/**
 * The model's identity (L4): the file the server reports. Null when it
 * reports none (a server started without a model path).
 */
export function identityOf(capabilities: SdcppCapabilities): ModelIdentity | null {
  const { path, stem } = capabilities.model;
  if (path === '') return null;
  return { kind: 'file', path, stem };
}

/** Whether the server serves image modes at all. */
export function servesImages(capabilities: SdcppCapabilities): boolean {
  return capabilities.supportedModes.includes('img_gen') && capabilities.imgDefaults !== null;
}

/**
 * A value at a dotted path in the image defaults, or undefined. `null` and
 * non-finite numbers are undefined too: the model decides them.
 */
export function defaultAt(capabilities: SdcppCapabilities, path: string): unknown {
  let node: unknown = capabilities.imgDefaults;
  for (const segment of path.split('.')) {
    if (!isRecord(node)) return undefined;
    node = node[segment];
  }
  if (node === null) return undefined;
  if (typeof node === 'number' && !Number.isFinite(node)) return undefined;
  return node;
}
