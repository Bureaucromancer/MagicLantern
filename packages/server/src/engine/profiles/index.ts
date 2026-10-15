// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/** Model profiles: the built-in set, loading, validation and lookup. */

export { checkModelProfile } from './check.js';
export { requestFieldSchema } from './field-schema.js';
export {
  builtinProfiles,
  loadProfiles,
  type ProfileIssue,
  ProfileLoadError,
  ProfileRegistry,
} from './loader.js';
export { applyVariant, modeConstraints, type ResolvedProfile } from './resolve.js';
