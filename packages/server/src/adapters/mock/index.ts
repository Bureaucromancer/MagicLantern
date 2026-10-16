// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/** The mock backend kind (EN2, D6), shown only with `LANTERN_DEV=1`. */

export { MOCK_ROUTE_ID, mockRouteDescriptor } from './descriptor.js';
export {
  drawMockImage,
  MOCK_GENERATOR,
  MOCK_MODEL_IDENTITY,
  MockAdapter,
  type MockOptions,
  type MockWire,
} from './mock.js';
export { isMockProfile, MOCK_PROFILES, type MockProfile, type MockSettings } from './profiles.js';
