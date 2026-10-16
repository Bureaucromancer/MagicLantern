// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/** The sd.cpp native backend kind (Phase 5): one sd-server instance, one route. */

export { AUTO_PREVIEW, SdcppAdapter, type SdcppAdapterOptions } from './adapter.js';
export {
  CapabilitiesError,
  defaultAt,
  identityOf,
  parseCapabilities,
  servesImages,
  type SdcppCapabilities,
} from './capabilities.js';
export {
  canonicalName,
  describeCapabilities,
  extensionSchema,
  nativeName,
  SDCPP_KIND,
  SDCPP_MAX_STEPS,
  type DescribeOptions,
} from './describe.js';
export { prepareImgGen, type PrepareOptions } from './prepare.js';
export {
  generatorOf,
  parseSdcppSection,
  readImageMetadata,
  resultOf,
  statusOf,
  type SdcppJobData,
} from './results.js';
export {
  readSdcppSettings,
  SDCPP_DEFAULT_SETTINGS,
  SDCPP_PREVIEWS,
  SDCPP_SETTINGS_SCHEMA,
  type SdcppPreview,
  type SdcppSettings,
} from './settings.js';
