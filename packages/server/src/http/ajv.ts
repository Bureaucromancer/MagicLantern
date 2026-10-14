// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The one Ajv instance, installed with `app.setValidatorCompiler` (rule 5:
 * validation never rewrites a request). Fastify's stock Ajv uses
 * `removeAdditional: true`, `useDefaults: true` and `coerceTypes: 'array'`,
 * which would silently strip unknown fields instead of refusing them, fill
 * defaults the resolver owns, and coerce types. Ours turns all three off,
 * reports every error (`allErrors`), and keeps `strict: false` because TypeBox
 * and OpenAPI annotations use keywords strict mode rejects.
 *
 * With coercion off, querystring and params values arrive as strings, so a
 * numeric query parameter is declared `Type.String({ pattern })` and converted
 * in the handler (StoryEngine shipped `Type.Integer()` on a query and refused
 * `?limit=10`).
 */

import { Ajv, type Options } from 'ajv';

export const AJV_OPTIONS = {
  removeAdditional: false,
  useDefaults: false,
  coerceTypes: false,
  allErrors: true,
  strict: false,
} as const satisfies Options;

/**
 * RFC 3339 date-time. Registered by hand rather than through ajv-formats
 * because it is the only format the API uses; without it Ajv treats the
 * format as unknown and accepts "yesterday".
 */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

export function isTimestamp(value: string): boolean {
  return RFC3339.test(value) && !Number.isNaN(Date.parse(value));
}

export function createValidator(): Ajv {
  const ajv = new Ajv(AJV_OPTIONS);
  ajv.addFormat('date-time', { type: 'string', validate: isTimestamp });
  return ajv;
}
