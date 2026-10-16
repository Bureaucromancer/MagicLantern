// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * @bureaucromancer/lantern-client: the typed HTTP client for the Magic Lantern
 * daemon. The app reaches the daemon only through this package (rule 1).
 */

export {
  assetQueryString,
  createLanternClient,
  type LanternClient,
  type LanternClientOptions,
  type ListAssetsOptions,
  type ListJobsOptions,
  type RequestOptions,
  type StreamOptions,
  type SubmitOptions,
} from './client.js';
export { createEventParser, type LanternStreamEvent } from './events.js';
export {
  errorCode,
  INVALID_RESPONSE_CODE,
  LanternApiError,
  refusalFrom,
  UNKNOWN_ERROR_CODE,
} from './errors.js';
// The wire types, so a consumer of the client needs no second import.
export type {
  BackendHealthEvent,
  BackendKindInfo,
  BackendKindListResponse,
  BackendListResponse,
  BackendRouteSummary,
  BackendSummary,
  ConfirmedModel,
  CreateBackendBody,
  DetectBody,
  DetectedBackend,
  DetectResponse,
  FamilyGuess,
  ModelDetail,
  ModelFingerprint,
  ModelListResponse,
  ModelPatchBody,
  ModelRouteDetail,
  ModelSummary,
  ProfileListResponse,
  ProfileSummary,
  ProposedModel,
  RouteDescriptor,
  AssetLineage,
  AssetOrigin,
  AssetPage,
  AssetProvenance,
  AssetSummary,
  AuthMode,
  BytesState,
  LibraryUsage,
  LineageEdge,
  ErrorBody,
  ErrorCode,
  FieldReport,
  FieldReportEntry,
  GenerationRequest,
  HealthResponse,
  InfoResponse,
  JobDetail,
  JobPage,
  JobProgress,
  JobState,
  JobSummary,
  QueueEntry,
  QueueResponse,
  SubmitBody,
  SubmitResponse,
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
