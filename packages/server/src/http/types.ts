// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The Fastify instance type every HTTP module takes, and the `services`
 * decoration handlers read.
 *
 * The TypeBox type provider is used for types only: route handlers get typed
 * bodies and replies from the schema package's route contracts, while
 * validation stays with the one non-rewriting Ajv (http/ajv.ts, rule 5). Its
 * `TypeBoxValidatorCompiler` is never used.
 */

// Brings in @fastify/swagger's augmentations (`app.swagger()`, and the
// FastifySchema fields operationId, tags, hide…). A directive rather than
// `import type {}`, which declaration emit drops: the test projects see this
// module through dist/*.d.ts and would lose the augmentation.
/// <reference types="@fastify/swagger" preserve="true" />
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';

import type { AppServices } from '../services.js';

export type LanternApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;

declare module 'fastify' {
  interface FastifyInstance {
    /** Built once at startup. Read in handlers only, never at registration. */
    services: AppServices;
  }
}
