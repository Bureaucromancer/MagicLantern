// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Store refusals a person can act on (a newer database, a busy data
 * directory, no room for a snapshot). The CLI prints the message as one
 * sentence and exits 1, rather than a stack trace.
 */
export class StoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreError';
  }
}

/**
 * The parts of an error that are safe and useful in a log line: never the
 * whole object, which can carry request bodies or handles.
 */
export function errorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: String(error) };
  const fields: Record<string, unknown> = { errorType: error.name, errorMessage: error.message };
  const { code, errcode } = error as { code?: unknown; errcode?: unknown };
  if (typeof code === 'string' || typeof code === 'number') fields['errorCode'] = code;
  if (typeof errcode === 'number') fields['sqliteCode'] = errcode;
  if (error.stack !== undefined) fields['stack'] = error.stack;
  return fields;
}
