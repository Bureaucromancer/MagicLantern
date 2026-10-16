// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/** The resolver: canonical request and model in, effective request, field report and route out. */

export {
  fillDefaults,
  fillExtensionDefaults,
  type FillLayers,
  type FillOptions,
  type FillResult,
  routeNarrowing,
  SIZE_GIVING_ROLES,
  snapSize,
} from './fill.js';
export { fieldOfPointer, type Leaf, requestLeaves, valueAt } from './leaves.js';
export { buildFieldReport, profileWarnings } from './report.js';
export { anotherRoute, type RerunSource, reproduce, reroll } from './rerun.js';
export {
  createResolver,
  type FinaliseOptions,
  type Resolver,
  type ResolverOptions,
  type SeedPolicy,
} from './resolver.js';
export { suggestValue } from './suggest.js';
export type * from './types.js';
