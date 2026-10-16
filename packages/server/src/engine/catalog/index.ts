// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/** The model catalog seam (replaced by the install database in Phase 5). */

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
  devMockProfile,
  devModel,
  DEV_MODEL,
  DEV_MODEL_ID,
  DEV_ROUTE_DESCRIPTOR,
  DEV_ROUTE_ID,
  isDevMode,
  startupModelCatalog,
} from './dev.js';
