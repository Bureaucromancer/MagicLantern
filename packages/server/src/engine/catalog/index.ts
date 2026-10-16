// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/** The model catalog seam, which the backend registry implements, and the development model. */

export {
  type CatalogEntry,
  catalogEntry,
  type CatalogModel,
  type CatalogRoute,
  InMemoryModelCatalog,
  type ModelCatalog,
  profileLayerFor,
} from './catalog.js';
export {
  DEV_BACKEND_ID,
  DEV_BASE_URL,
  devBackend,
  DEV_BACKEND_NAME,
  devFixedModel,
  devMockProfile,
  devModel,
  DEV_MODEL,
  DEV_MODEL_ID,
  DEV_MODEL_NAME,
  DEV_ROUTE_DESCRIPTOR,
  DEV_ROUTE_ID,
  isDevMode,
  startupModelCatalog,
} from './dev.js';
