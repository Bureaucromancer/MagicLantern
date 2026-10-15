// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Ajv errors as the 422 `issues` the API answers with: a JSON pointer naming
 * the field at fault, and a message. Shared by the HTTP error handler and the
 * engine (descriptor validators, the resolver), so the engine never imports
 * the HTTP layer and both speak one path form.
 */

import { pointerSegment, type ValidationIssue } from '@bureaucromancer/lantern-schema';

/** The parts of an Ajv error these functions read. */
export interface AjvIssue {
  readonly keyword: string;
  readonly instancePath: string;
  readonly params: Record<string, unknown>;
  readonly message?: string;
}

/**
 * The JSON pointer (RFC 6901) to the field at fault; `''` is the whole body.
 * Ajv reports an additionalProperties (or required) failure at the parent
 * object and puts the raw key in `params`, so joining them, escaped like the
 * rest of Ajv's already-escaped `instancePath`, turns "this object is wrong"
 * into "this field is wrong".
 */
export function pathOfIssue(issue: Pick<AjvIssue, 'instancePath' | 'params'>): string {
  const field = issue.params['additionalProperty'] ?? issue.params['missingProperty'];
  if (typeof field === 'string') return `${issue.instancePath}/${pointerSegment(field)}`;
  return issue.instancePath;
}

/** The message for one Ajv error: an unknown field and a missing one read as such. */
export function messageOfIssue(issue: AjvIssue): string {
  if (issue.keyword === 'additionalProperties') return 'is not a known field';
  if (issue.keyword === 'required') return 'is required';
  return issue.message ?? 'is invalid';
}

/**
 * How telling an error is about its value, highest first: a bound says what
 * to change; a type or `const` mismatch inside a union (`"random"` or an
 * integer) only says which member did not match, and `anyOf` only that none
 * did.
 */
function rank(keyword: string): number {
  if (keyword === 'anyOf' || keyword === 'oneOf') return 0;
  if (keyword === 'type' || keyword === 'const') return 1;
  return 2;
}

/**
 * Ajv's errors as issues: one per pointer, in the order the pointers first
 * appear, each with the most telling of the errors at that pointer. A value
 * that fails a union (the seed is `"random"` or an integer up to 2^53 − 1)
 * gets one error per member plus one for the union; the bound it broke is
 * the one worth reporting.
 *
 * @param errors Ajv's `errors`
 */
export function issuesOfAjv(errors: readonly AjvIssue[]): ValidationIssue[] {
  const best = new Map<string, AjvIssue>();
  for (const error of errors) {
    const path = pathOfIssue(error);
    const current = best.get(path);
    if (current === undefined || rank(error.keyword) > rank(current.keyword)) best.set(path, error);
  }
  return [...best].map(([path, error]) => ({ path, message: messageOfIssue(error) }));
}
