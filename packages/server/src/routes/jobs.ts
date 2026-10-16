// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Jobs (EN6): submit with idempotency, history, one job, cancel, Reproduce
 * and Re-roll, under `/api/v1/libraries/{lib}/jobs`; and the install-wide
 * queue at `/api/v1/queue` (A19). The engine does the work; this maps it to
 * the contract.
 */

import {
  CancelJobRoute,
  ErrorCodes,
  GetJobRoute,
  GetQueueRoute,
  ListJobsRoute,
  ReproduceJobRoute,
  RerollJobRoute,
  SubmitJobRoute,
  type JobDetail,
  type JobPage,
  type QueueResponse,
  type SubmitResponse,
  type ValidationIssue,
} from '@bureaucromancer/lantern-schema';
import type { FastifyReply } from 'fastify';

import type { SubmitOutcome } from '../engine/jobs/index.js';
import { sendError, sendInvalid } from '../http/errors.js';
import type { LanternApp } from '../http/types.js';
import { toAssetSummary, toJobSummary } from '../wire.js';
import { encodeCursor } from './assets.js';
import { isReply, libraryFor } from './libraries.js';
import { failureIssues } from './resolve.js';

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

/** A submit's outcome as the answer: 202 for a new job, 200 for a replay, else the refusal. */
async function answerSubmit(
  reply: FastifyReply,
  library: string,
  model: string,
  outcome: SubmitOutcome,
): Promise<FastifyReply> {
  if (outcome.ok) {
    const body: SubmitResponse = {
      job: toJobSummary(library, outcome.job),
      field_report: outcome.fieldReport,
      warnings: [...outcome.warnings],
      replayed: outcome.replayed,
    };
    return await reply.code(outcome.replayed ? 200 : 202).send(body);
  }
  switch (outcome.kind) {
    case 'unknown_model':
      return sendInvalid(reply, [{ path: '/model', message: 'is not a known model' }], 'body');
    case 'resolve':
      return sendInvalid(reply, failureIssues(outcome.failure, model), 'body');
    case 'inputs':
      return sendInvalid(reply, [...outcome.issues], 'body');
    case 'conflict':
      return sendError(reply, 409, ErrorCodes.conflict, outcome.message);
    case 'library':
      return sendError(reply, 409, ErrorCodes.libraryUnavailable, 'The library cannot run jobs.');
  }
}

export function registerJobRoutes(app: LanternApp): void {
  app.route({
    method: SubmitJobRoute.method,
    url: SubmitJobRoute.url,
    schema: SubmitJobRoute.schema,
    handler: async (request, reply) => {
      const library = libraryFor(request, reply, request.params.lib, { write: true });
      if (isReply(library)) return library;
      const { body } = request;
      const key = request.headers['idempotency-key'];
      const outcome = await request.server.services.engine.submit(library.id, {
        request: body.request,
        model: body.model,
        ...(body.route === undefined ? {} : { route: body.route }),
        ...(body.collection === undefined ? {} : { collection: body.collection }),
        ...(body.end_user === undefined ? {} : { endUser: body.end_user }),
        ...(body.priority === undefined ? {} : { priority: body.priority }),
        ...(typeof key === 'string' ? { idempotencyKey: key } : {}),
      });
      return await answerSubmit(reply, library.id, body.model, outcome);
    },
  });

  app.route({
    method: ListJobsRoute.method,
    url: ListJobsRoute.url,
    schema: ListJobsRoute.schema,
    handler: async (request, reply) => {
      const library = libraryFor(request, reply, request.params.lib);
      if (isReply(library)) return library;
      const { query } = request;
      const issues: ValidationIssue[] = [];
      const limit = query.limit === undefined ? PAGE_DEFAULT : Number(query.limit);
      if (limit < 1 || limit > PAGE_MAX) {
        issues.push({ path: '/limit', message: `must be from 1 to ${String(PAGE_MAX)}` });
      }
      // Job cursors carry a job id where asset cursors carry a hash.
      const after = query.cursor === undefined ? undefined : decodeJobCursor(query.cursor);
      if (after === null)
        issues.push({ path: '/cursor', message: 'is not a cursor this daemon gave' });
      if (issues.length > 0) return sendInvalid(reply, issues, 'querystring');
      const page = library.listJobs({
        limit,
        ...(after === undefined || after === null ? {} : { after }),
        ...(query.state === undefined ? {} : { state: query.state }),
      });
      const answer: JobPage = {
        jobs: page.jobs.map((job) => toJobSummary(library.id, job)),
        next_cursor: page.next === null ? null : encodeCursor(page.next),
      };
      return answer;
    },
  });

  app.route({
    method: GetJobRoute.method,
    url: GetJobRoute.url,
    schema: GetJobRoute.schema,
    handler: async (request, reply) => {
      const library = libraryFor(request, reply, request.params.lib);
      if (isReply(library)) return library;
      const job = library.getJob(request.params.job);
      const payloads = job === undefined ? undefined : library.payloads(job.id);
      if (job === undefined || payloads === undefined) {
        return await sendError(reply, 404, ErrorCodes.notFound, 'No such job.');
      }
      const detail: JobDetail = {
        ...toJobSummary(library.id, job),
        canonical: payloads.canonical,
        effective: payloads.effective,
        field_report: payloads.fieldReport,
        wire: payloads.wire,
        backend_response: payloads.backendResponse,
        route_snapshot: job.routeSnapshot,
        inputs: library.inputs(job.id).map((input) => ({
          position: input.position,
          asset_id: input.assetId,
          role: input.role,
          weight: input.weight ?? null,
          region: input.region ?? null,
          crop: input.crop ?? null,
          source_library: input.sourceLibrary ?? null,
        })),
        outputs: library.jobOutputs(job.id).map(toAssetSummary),
      };
      return detail;
    },
  });

  app.route({
    method: CancelJobRoute.method,
    url: CancelJobRoute.url,
    schema: CancelJobRoute.schema,
    handler: async (request, reply) => {
      const library = libraryFor(request, reply, request.params.lib, { write: true });
      if (isReply(library)) return library;
      const job = await request.server.services.engine.cancel(library.id, request.params.job);
      if (job === undefined)
        return await sendError(reply, 404, ErrorCodes.notFound, 'No such job.');
      return await reply.code(202).send(toJobSummary(library.id, job));
    },
  });

  for (const [route, kind] of [
    [ReproduceJobRoute, 'reproduce'],
    [RerollJobRoute, 'reroll'],
  ] as const) {
    app.route({
      method: route.method,
      url: route.url,
      schema: route.schema,
      handler: async (request, reply) => {
        const library = libraryFor(request, reply, request.params.lib, { write: true });
        if (isReply(library)) return library;
        const { engine, libraries } = request.server.services;
        const outcome = await engine.rerun(library.id, request.params.job, kind);
        if (!outcome.ok && outcome.kind === 'missing') {
          return await sendError(reply, 404, ErrorCodes.notFound, 'No such job.');
        }
        if (!outcome.ok && outcome.kind === 'unresolved') {
          return await sendError(
            reply,
            409,
            ErrorCodes.conflict,
            'The job never resolved, so it has no effective request to rerun.',
          );
        }
        const model = libraries.jobs(library.id)?.getJob(request.params.job)?.modelId ?? '';
        return await answerSubmit(reply, library.id, model, outcome);
      },
    });
  }

  app.route({
    method: GetQueueRoute.method,
    url: GetQueueRoute.url,
    schema: GetQueueRoute.schema,
    handler: (request) => {
      const mine = request.query.library;
      const answer: QueueResponse = {
        entries: request.server.services.engine.queue().map((item, position) => ({
          position,
          library: item.library,
          state: item.job.state,
          mode: item.mode,
          blocked: item.blocked,
          // Other libraries' jobs show no prompt, no payload, no ids (A19).
          job: item.library === mine ? toJobSummary(item.library, item.job) : null,
        })),
      };
      return answer;
    },
  });
}

/** A job cursor: the asset cursor's encoding, with a job id in place of a hash. */
export function decodeJobCursor(cursor: string): { createdAt: number; id: string } | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'number' &&
      Number.isFinite(value[0]) &&
      typeof value[1] === 'string' &&
      /^job_[0-9A-HJKMNP-TV-Z]{26}$/.test(value[1])
    ) {
      return { createdAt: value[0], id: value[1] };
    }
  } catch {
    // Any malformed cursor is the same 422.
  }
  return null;
}
