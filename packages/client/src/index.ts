// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * @bureaucromancer/lantern-client: the typed HTTP client for the Magic Lantern
 * daemon. The app reaches the daemon only through this package (rule 1).
 */

export {
  createLanternClient,
  type LanternClient,
  type LanternClientOptions,
  type RequestOptions,
} from './client.js';
export {
  errorCode,
  INVALID_RESPONSE_CODE,
  LanternApiError,
  refusalFrom,
  UNKNOWN_ERROR_CODE,
} from './errors.js';
// The wire types, so a consumer of the client needs no second import.
export type {
  AuthMode,
  ErrorBody,
  ErrorCode,
  FieldReport,
  FieldReportEntry,
  GenerationRequest,
  HealthResponse,
  InfoResponse,
  LibraryId,
  LibraryListResponse,
  LibraryStatus,
  LibrarySummary,
  ResolutionWarning,
  ResolveBody,
  ResolveResponse,
  SessionResponse,
  SkippedRoute,
  ValidationIssue,
} from '@bureaucromancer/lantern-schema';
export { ErrorCodes } from '@bureaucromancer/lantern-schema';
