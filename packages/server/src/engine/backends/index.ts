// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/** The backend registry (Phase 5): backends, models and routes, kinds, and autodetect. */

export { detectBackends, type DetectOptions } from './detect.js';
export { GENERIC_FAMILY, guessFamily, trustworthy } from './guess.js';
export {
  createBackendKinds,
  kindInfo,
  LEMONADE_DEFINITION,
  PROBE_TIMEOUT_MS,
  SDCPP_DEFINITION,
  type BackendKindDefinition,
  type BackendKinds,
  type KindBuildOptions,
  type ProbedModel,
  type ProbeResult,
} from './kinds.js';
export {
  BackendConfigError,
  BackendRegistry,
  CREATE_WAIT_MS,
  defaultResourceGroup,
  DESCRIBE_EVERY_MS,
  HEALTH_POLL_MS,
  MANAGER_POLL_MS,
  normaliseBaseUrl,
  routeHealth,
  STARTUP_WAIT_MS,
  type BackendRegistryOptions,
  type BackendView,
  type ConfigBackend,
  type CreateOutcome,
  type FixedModel,
  type ModelPatchOutcome,
  type ModelRouteView,
  type ModelView,
} from './registry.js';
