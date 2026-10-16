// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The sd.cpp backend kind's settings: what the capabilities document cannot
 * say. The JSON Schema here is what `GET /backend-kinds` serves for the add
 * form (A26); {@link readSdcppSettings} holds a settings object to it.
 */

/** Preview modes sd-server knows; `auto` asks for `proj` where the build has previews. */
export const SDCPP_PREVIEWS = ['auto', 'none', 'proj', 'tae', 'vae'] as const;
export type SdcppPreview = (typeof SDCPP_PREVIEWS)[number];

export interface SdcppSettings {
  /** Which preview to ask for, where the build has native previews; `none` turns progress off. */
  readonly preview: SdcppPreview;
  /** The instance was started with a ControlNet (`--control-net`); capabilities cannot say. */
  readonly controlNet: boolean;
  /** The instance was started with an IP-Adapter; capabilities cannot say. */
  readonly ipAdapter: boolean;
  /** Milliseconds before a status, cancel or capabilities request is abandoned. */
  readonly timeoutMs: number;
  /** Milliseconds before a submit (images inline as base64) is abandoned. */
  readonly submitTimeoutMs: number;
}

export const SDCPP_DEFAULT_SETTINGS: SdcppSettings = {
  preview: 'auto',
  controlNet: false,
  ipAdapter: false,
  timeoutMs: 15_000,
  submitTimeoutMs: 120_000,
};

/** The settings' JSON Schema, for the add form. */
export const SDCPP_SETTINGS_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    preview: {
      type: 'string',
      enum: [...SDCPP_PREVIEWS],
      default: SDCPP_DEFAULT_SETTINGS.preview,
      title: 'Preview',
      description:
        'Which preview to ask for, on builds with native previews: they are what reports step progress. `auto` asks for `proj`, the cheapest; `none` shows an elapsed timer instead.',
    },
    controlNet: {
      type: 'boolean',
      default: false,
      title: 'Has a ControlNet',
      description:
        'The instance was started with `--control-net`. sd-server cannot report it, and ignores control images without one.',
    },
    ipAdapter: {
      type: 'boolean',
      default: false,
      title: 'Has an IP-Adapter',
      description:
        'The instance was started with an IP-Adapter. sd-server cannot report it, and ignores IP-Adapter images without one.',
    },
    timeoutMs: {
      type: 'integer',
      minimum: 1000,
      maximum: 600_000,
      default: SDCPP_DEFAULT_SETTINGS.timeoutMs,
      title: 'Request timeout (ms)',
    },
    submitTimeoutMs: {
      type: 'integer',
      minimum: 1000,
      maximum: 600_000,
      default: SDCPP_DEFAULT_SETTINGS.submitTimeoutMs,
      title: 'Submit timeout (ms)',
    },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timeout(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1000 || value > 600_000) {
    throw new TypeError(`${name} must be an integer from 1000 to 600000.`);
  }
  return value;
}

/**
 * Settings with their defaults applied.
 *
 * @throws TypeError naming the first setting that is wrong
 */
export function readSdcppSettings(settings: unknown): SdcppSettings {
  if (!isRecord(settings)) throw new TypeError('The sd.cpp settings must be an object.');
  for (const key of Object.keys(settings)) {
    if (!(key in SDCPP_DEFAULT_SETTINGS)) throw new TypeError(`Unknown sd.cpp setting: ${key}.`);
  }
  const { preview, controlNet, ipAdapter } = settings;
  if (preview !== undefined && !SDCPP_PREVIEWS.includes(preview as SdcppPreview)) {
    throw new TypeError(`preview must be one of ${SDCPP_PREVIEWS.join(', ')}.`);
  }
  for (const [name, value] of [
    ['controlNet', controlNet],
    ['ipAdapter', ipAdapter],
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new TypeError(`${name} must be true or false.`);
    }
  }
  return {
    preview: (preview as SdcppPreview | undefined) ?? SDCPP_DEFAULT_SETTINGS.preview,
    controlNet: (controlNet as boolean | undefined) ?? false,
    ipAdapter: (ipAdapter as boolean | undefined) ?? false,
    timeoutMs: timeout(settings['timeoutMs'], 'timeoutMs', SDCPP_DEFAULT_SETTINGS.timeoutMs),
    submitTimeoutMs: timeout(
      settings['submitTimeoutMs'],
      'submitTimeoutMs',
      SDCPP_DEFAULT_SETTINGS.submitTimeoutMs,
    ),
  };
}
