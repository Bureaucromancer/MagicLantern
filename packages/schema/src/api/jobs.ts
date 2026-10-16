// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Jobs (EN6): submit, history, cancel, Reproduce and Re-roll under
 * `/api/v1/libraries/{lib}/jobs`; the install-wide queue at `/api/v1/queue`;
 * and the event stream at `/api/v1/events` (A31).
 *
 * A job's states (A16): `queued` → `submitting` → `dispatched` → `running`
 * → `finished`, plus `cancel_requested`. `outcome` is set only when it
 * finishes. A job a backend turns away before it starts goes back to
 * `queued` with a `blocked_reason` (L5, L6), keeping its seed.
 */

import { type Static, Type } from '@sinclair/typebox';

import { GenerationRequest } from '../request/generation-request.js';
import { BlockedReason, FieldReport, ResolutionWarning } from '../resolution/resolution.js';
import { AssetSummary, ProvenanceInput } from './assets.js';
import { errorResponse, ForbiddenHostOrOrigin } from './errors.js';
import { LibraryId, LibraryParams } from './libraries.js';
import { ModelId } from './resolve.js';
import { API_V1_PREFIX, streamResponse, type RouteContract } from './route.js';

const Timestamp = (description: string) => Type.String({ format: 'date-time', description });

export const JobState = Type.Union(
  [
    Type.Literal('queued'),
    Type.Literal('submitting'),
    Type.Literal('dispatched'),
    Type.Literal('running'),
    Type.Literal('cancel_requested'),
    Type.Literal('finished'),
  ],
  {
    description:
      "`queued`: in Lantern's queue (see `blocked_reason`). `submitting`: being sent. `dispatched`: the backend has it, not yet generating (`progress.waiting` says why). `running`: generating. `cancel_requested`: cancel asked of a job the backend cannot stop; its outputs are discarded. `finished`: see `outcome`.",
  },
);
export type JobState = Static<typeof JobState>;

export const JobOutcome = Type.Union(
  [
    Type.Literal('done'),
    Type.Literal('failed'),
    Type.Literal('refused'),
    Type.Literal('cancelled'),
  ],
  { description: 'How a finished job ended.' },
);
export type JobOutcome = Static<typeof JobOutcome>;

export const JobId = Type.String({
  pattern: '^job_[0-9A-HJKMNP-TV-Z]{26}$',
  description: 'A job id: `job_` and a ULID.',
});
export type JobId = Static<typeof JobId>;

export const JobProgress = Type.Object(
  {
    fraction: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    step: Type.Optional(Type.Integer({ minimum: 0 })),
    total_steps: Type.Optional(Type.Integer({ minimum: 0 })),
    eta_s: Type.Optional(Type.Number({ minimum: 0 })),
    waiting: Type.Optional(
      Type.Object(
        {
          reason: Type.String({
            description: '`memory`, `loading`, `calibrating`, `engine_queue` or `other` (L5).',
          }),
          detail: Type.Optional(Type.String()),
          queue_position: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        { additionalProperties: false, description: 'Why the backend has not started it.' },
      ),
    ),
  },
  {
    additionalProperties: false,
    description:
      "What the backend reports, as far as the route's `control.progress` allows; absent fields are unknown.",
  },
);
export type JobProgress = Static<typeof JobProgress>;

export const JobSummary = Type.Object(
  {
    id: JobId,
    library: LibraryId,
    parent_id: Type.Union([JobId, Type.Null()], {
      description: 'The job this one reran (Reproduce, Re-roll).',
    }),
    state: JobState,
    blocked_reason: Type.Union([BlockedReason, Type.Null()], {
      description: 'Why a queued job is not being dispatched now.',
    }),
    outcome: Type.Union([JobOutcome, Type.Null()]),
    outcome_reason: Type.Union([Type.String(), Type.Null()], {
      description:
        "`backend_error`, `backend_lost`, `interrupted`, `ingest_failed`, `route_missing`, `user`, or the backend's reason for a refusal.",
    }),
    model_id: ModelId,
    route_id: Type.Union([Type.String(), Type.Null()]),
    collection: Type.Union([Type.String(), Type.Null()]),
    end_user: Type.Union([Type.String(), Type.Null()]),
    priority: Type.Integer(),
    progress: Type.Union([JobProgress, Type.Null()]),
    created_at: Timestamp('When it was submitted.'),
    updated_at: Timestamp('When it last changed.'),
    started_at: Type.Union([Timestamp('When it was sent to the backend.'), Type.Null()]),
    finished_at: Type.Union([Timestamp('When it finished.'), Type.Null()]),
  },
  { additionalProperties: false, description: 'One job.' },
);
export type JobSummary = Static<typeof JobSummary>;

export const JobDetail = Type.Object(
  {
    ...JobSummary.properties,
    canonical: Type.Unknown({
      description: 'The request as submitted; its seed may be `"random"`.',
    }),
    effective: Type.Unknown({
      description:
        'The request as it runs, every pixel-affecting value written out and the seed concrete; provisional until dispatch.',
    }),
    field_report: Type.Unknown({ description: 'What became of each field.' }),
    wire: Type.Unknown({
      description: 'The body sent to the backend, with `$asset` placeholders.',
    }),
    backend_response: Type.Unknown(),
    route_snapshot: Type.Unknown({ description: 'What ran, as it was when it ran.' }),
    inputs: Type.Array(ProvenanceInput),
    outputs: Type.Array(AssetSummary, { description: 'The stored outputs, by index.' }),
  },
  { additionalProperties: false, description: 'One job, with its stored payloads.' },
);
export type JobDetail = Static<typeof JobDetail>;

export const JobParams = Type.Object(
  { lib: LibraryId, job: JobId },
  { additionalProperties: false, description: 'The library and the job.' },
);
export type JobParams = Static<typeof JobParams>;

export const IDEMPOTENCY_KEY_PATTERN = '^[A-Za-z0-9_.:-]{1,128}$';

export const SubmitHeaders = Type.Object(
  {
    'idempotency-key': Type.Optional(
      Type.String({
        pattern: IDEMPOTENCY_KEY_PATTERN,
        description:
          'A client-chosen key: a second submit with the same key answers the first job (200) instead of making another; with a different body, 409.',
      }),
    ),
  },
  { description: 'Request headers the submit reads.' },
);
export type SubmitHeaders = Static<typeof SubmitHeaders>;

export const SubmitBody = Type.Object(
  {
    request: GenerationRequest,
    model: ModelId,
    route: Type.Optional(
      Type.String({
        pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
        maxLength: 128,
        description: "The route to use. Absent: the model's best healthy route for the request.",
      }),
    ),
    collection: Type.Optional(
      Type.String({ minLength: 1, maxLength: 200, description: "The client's own grouping." }),
    ),
    end_user: Type.Optional(
      Type.String({ minLength: 1, maxLength: 200, description: "The client's own user." }),
    ),
    priority: Type.Optional(
      Type.Integer({
        minimum: -10,
        maximum: 10,
        description: 'Higher runs first; 0 when absent. "Run next" raises it.',
      }),
    ),
  },
  { additionalProperties: false, description: 'A generation to run.' },
);
export type SubmitBody = Static<typeof SubmitBody>;

export const SubmitResponse = Type.Object(
  {
    job: JobSummary,
    field_report: FieldReport,
    warnings: Type.Array(ResolutionWarning),
    replayed: Type.Boolean({
      description: 'True when the idempotency key named a job already submitted, which this is.',
    }),
  },
  { additionalProperties: false, description: 'The queued job and what resolving it found.' },
);
export type SubmitResponse = Static<typeof SubmitResponse>;

export const JobQuery = Type.Object(
  {
    state: Type.Optional(
      Type.Union([Type.Literal('live'), Type.Literal('finished')], {
        description: '`live`: not finished. `finished`: finished. Absent: both.',
      }),
    ),
    limit: Type.Optional(
      Type.String({ pattern: '^[0-9]{1,15}$', description: '1 to 200; 50 when absent.' }),
    ),
    cursor: Type.Optional(
      Type.String({ minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_-]+$' }),
    ),
  },
  { additionalProperties: false, description: 'History filters.' },
);
export type JobQuery = Static<typeof JobQuery>;

export const JobPage = Type.Object(
  {
    jobs: Type.Array(JobSummary, { description: 'Newest first.' }),
    next_cursor: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false, description: 'One page of jobs.' },
);
export type JobPage = Static<typeof JobPage>;

export const QueueQuery = Type.Object(
  {
    library: Type.Optional(LibraryId),
  },
  {
    additionalProperties: false,
    description: "The library the caller is in: its jobs are listed in full, others' collapsed.",
  },
);
export type QueueQuery = Static<typeof QueueQuery>;

export const QueueEntry = Type.Object(
  {
    position: Type.Integer({ minimum: 0, description: 'The dispatch order, from 0.' }),
    library: LibraryId,
    state: JobState,
    mode: Type.String({ description: 'The generation mode.' }),
    blocked: Type.Boolean({ description: 'Skipped for now; see `blocked_reason` in the job.' }),
    job: Type.Union([JobSummary, Type.Null()], {
      description: "The job, for the caller's library; null for another library's job (A19).",
    }),
  },
  { additionalProperties: false, description: 'One live job.' },
);
export type QueueEntry = Static<typeof QueueEntry>;

export const QueueResponse = Type.Object(
  { entries: Type.Array(QueueEntry, { description: 'Running first, then in dispatch order.' }) },
  { additionalProperties: false, description: 'The live queue, install-wide (A19).' },
);
export type QueueResponse = Static<typeof QueueResponse>;

// ---------------------------------------------------------------------------
// Events (A31)
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  'job.updated',
  'job.progress',
  'asset.created',
  'backend.health',
  'reset',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const JobUpdatedEvent = Type.Object(
  { library: LibraryId, job: JobSummary },
  { additionalProperties: false, description: '`job.updated`: a job changed state.' },
);
export type JobUpdatedEvent = Static<typeof JobUpdatedEvent>;

export const JobProgressEvent = Type.Object(
  { library: LibraryId, job_id: JobId, progress: JobProgress },
  {
    additionalProperties: false,
    description: '`job.progress`: progress or a wait reason. Never image bytes.',
  },
);
export type JobProgressEvent = Static<typeof JobProgressEvent>;

export const AssetCreatedEvent = Type.Object(
  { library: LibraryId, asset: AssetSummary },
  { additionalProperties: false, description: '`asset.created`: an output was stored.' },
);
export type AssetCreatedEvent = Static<typeof AssetCreatedEvent>;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const JOBS = `${API_V1_PREFIX}/libraries/{lib}/jobs`;
const unauthenticated = errorResponse('`unauthenticated`: password mode and no valid session.');
const notWritable = errorResponse(
  '`library-read-only`: the library was written by a newer Lantern. `library-unavailable`: it could not be opened.',
);
const jobNotFound = errorResponse('`not-found`: no library has this id, or it has no such job.');
const bodyRefusals = {
  400: errorResponse('`bad-request`: the body is not valid JSON.'),
  413: errorResponse("`payload-too-large`: the body is over the daemon's size limit."),
  415: errorResponse('`unsupported-media-type`: the body is not JSON.'),
};
const submitted = (description: string) =>
  Type.Object(SubmitResponse.properties, { additionalProperties: false, description });

export const SubmitJobRoute = {
  method: 'POST',
  path: JOBS,
  url: '/libraries/:lib/jobs',
  schema: {
    operationId: 'submitJob',
    summary: 'Submit a generation',
    description:
      'Resolves the request (as the dry run does), fixes its seed, and queues it. Inputs held only in another library are found by id and copied in (A22). The resolution is provisional: the route is checked again at dispatch (A12).',
    tags: ['jobs'],
    params: LibraryParams,
    headers: SubmitHeaders,
    body: SubmitBody,
    response: {
      200: submitted('The idempotency key named a job already submitted with this body.'),
      202: submitted('Queued.'),
      ...bodyRefusals,
      401: unauthenticated,
      403: ForbiddenHostOrOrigin,
      404: errorResponse('`not-found`: no library has this id.'),
      409: errorResponse(
        '`conflict`: the idempotency key names a job submitted with another body. `library-read-only`, `library-unavailable`: as for every write.',
      ),
      422: errorResponse(
        '`invalid`: the body does not match the schema, the model or route is unknown, the request does not validate on its routes, or an input asset is in no library.',
      ),
    },
  },
} satisfies RouteContract;

export const ListJobsRoute = {
  method: 'GET',
  path: JOBS,
  url: '/libraries/:lib/jobs',
  schema: {
    operationId: 'listJobs',
    summary: 'Job history',
    tags: ['jobs'],
    params: LibraryParams,
    querystring: JobQuery,
    response: {
      200: JobPage,
      401: unauthenticated,
      403: ForbiddenHostOrOrigin,
      404: errorResponse('`not-found`: no library has this id.'),
      409: errorResponse('`library-unavailable`: the library could not be opened.'),
      422: errorResponse('`invalid`: a filter or the cursor is malformed.'),
    },
  },
} satisfies RouteContract;

export const GetJobRoute = {
  method: 'GET',
  path: `${JOBS}/{job}`,
  url: '/libraries/:lib/jobs/:job',
  schema: {
    operationId: 'getJob',
    summary: 'One job, with its payloads',
    tags: ['jobs'],
    params: JobParams,
    response: {
      200: JobDetail,
      401: unauthenticated,
      403: ForbiddenHostOrOrigin,
      404: jobNotFound,
      409: errorResponse('`library-unavailable`: the library could not be opened.'),
      422: errorResponse('`invalid`: the library or job id is malformed.'),
    },
  },
} satisfies RouteContract;

export const CancelJobRoute = {
  method: 'POST',
  path: `${JOBS}/{job}/cancel`,
  url: '/libraries/:lib/jobs/:job/cancel',
  schema: {
    operationId: 'cancelJob',
    summary: 'Cancel a job',
    description:
      'A queued job is cancelled at once. One the backend has is cancelled there when the route can; otherwise it moves to `cancel_requested` and its outputs are discarded when it ends. Cancelling a finished job changes nothing. Answers the job as it now is; the end arrives as `job.updated`.',
    tags: ['jobs'],
    params: JobParams,
    response: {
      202: Type.Object(JobSummary.properties, {
        additionalProperties: false,
        description: 'The job as it now is.',
      }),
      ...bodyRefusals,
      401: unauthenticated,
      403: ForbiddenHostOrOrigin,
      404: jobNotFound,
      409: notWritable,
      422: errorResponse('`invalid`: the library or job id is malformed.'),
    },
  },
} satisfies RouteContract;

function rerunRoute(kind: 'reproduce' | 'reroll') {
  return {
    method: 'POST',
    path: `${JOBS}/{job}/${kind}`,
    url: `/libraries/:lib/jobs/:job/${kind}`,
    schema: {
      operationId: kind === 'reproduce' ? 'reproduceJob' : 'rerollJob',
      summary: kind === 'reproduce' ? 'Reproduce a job' : 'Re-roll a job',
      description:
        kind === 'reproduce'
          ? "A new job from this one's `effective` request on the same route (A11). A warning `environment_changed` says the model's identity differs from when it ran."
          : "A new job from this one's `effective` request on the same route with a newly drawn seed, never its own (A11).",
      tags: ['jobs'],
      params: JobParams,
      response: {
        202: submitted('Queued.'),
        ...bodyRefusals,
        401: unauthenticated,
        403: ForbiddenHostOrOrigin,
        404: jobNotFound,
        409: errorResponse(
          '`conflict`: the job has no effective request to rerun (it never resolved). `library-read-only`, `library-unavailable`: as for every write.',
        ),
        422: errorResponse(
          '`invalid`: an id is malformed, or the request no longer validates on the route (the model or route changed).',
        ),
      },
    },
  } satisfies RouteContract;
}

export const ReproduceJobRoute = rerunRoute('reproduce');
export const RerollJobRoute = rerunRoute('reroll');

export const GetQueueRoute = {
  method: 'GET',
  path: `${API_V1_PREFIX}/queue`,
  url: '/queue',
  schema: {
    operationId: 'getQueue',
    summary: 'The live queue',
    description:
      "Every live job, install-wide, in the order the scheduler will dispatch them (priority, then age), so people can see why they are waiting. Other libraries' jobs are collapsed to library, mode and state (A19).",
    tags: ['jobs'],
    querystring: QueueQuery,
    response: {
      200: QueueResponse,
      401: unauthenticated,
      403: ForbiddenHostOrOrigin,
      422: errorResponse('`invalid`: the library id is malformed.'),
    },
  },
} satisfies RouteContract;

export const EventsRoute = {
  method: 'GET',
  path: `${API_V1_PREFIX}/events`,
  url: '/events',
  schema: {
    operationId: 'streamEvents',
    summary: 'The event stream',
    description:
      'Server-sent events: `job.updated`, `job.progress`, `asset.created`, `backend.health` and `reset`, each with a JSON `data` line. Event ids are `<boot id>:<sequence>`; reconnecting with `Last-Event-ID` replays what was missed, or sends `reset` when that id is unknown (another boot, or too long ago), after which a client refetches. A comment line every 15 s keeps proxies from closing the stream.',
    tags: ['jobs'],
    response: {
      200: streamResponse('The stream.', 'text/event-stream'),
      401: unauthenticated,
      403: ForbiddenHostOrOrigin,
    },
  },
} satisfies RouteContract;
