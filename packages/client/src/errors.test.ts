// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { describe, expect, it } from 'vitest';

import { errorCode, LanternApiError, refusalFrom, UNKNOWN_ERROR_CODE } from './errors.js';

describe('refusalFrom', () => {
  it('reads the envelope', () => {
    const error = refusalFrom(403, { error: 'forbidden-host', message: 'Not this host.' });

    expect(error).toBeInstanceOf(LanternApiError);
    expect(error.status).toBe(403);
    expect(error.code).toBe('forbidden-host');
    expect(error.message).toBe('Not this host.');
    expect(error).not.toHaveProperty('issues');
  });

  it.each([
    ['no body', undefined],
    ['null', null],
    ['a string', 'Bad Gateway'],
    ['an array', [{ error: 'invalid' }]],
    ['a non-string code', { error: 42, message: 'x' }],
  ])('falls back to the unknown code for %s', (_label, payload) => {
    const error = refusalFrom(502, payload);

    expect(error.code).toBe(UNKNOWN_ERROR_CODE);
  });

  it('says the status when the message is missing or not a string', () => {
    expect(refusalFrom(500, { error: 'internal' }).message).toBe(
      'The Lantern daemon answered with status 500.',
    );
    expect(refusalFrom(500, { error: 'internal', message: ['x'] }).message).toBe(
      'The Lantern daemon answered with status 500.',
    );
  });

  it('copies only path and message from each issue', () => {
    const error = refusalFrom(422, {
      error: 'invalid',
      message: 'Invalid.',
      issues: [{ path: '/password', message: 'must be string', keyword: 'type' }],
    });

    expect(error.issues).toEqual([{ path: '/password', message: 'must be string' }]);
  });

  it('keeps an empty issue list', () => {
    expect(refusalFrom(422, { error: 'invalid', message: 'x', issues: [] }).issues).toEqual([]);
  });

  it.each([
    ['not an array', { path: '/a', message: 'b' }],
    ['an entry without a path', [{ message: 'b' }]],
    ['an entry whose message is not a string', [{ path: '/a', message: { text: 'b' } }]],
    ['an entry that is not an object', ['/a: b']],
  ])('drops issues that are %s, rather than rendering [object Object]', (_label, issues) => {
    const error = refusalFrom(422, { error: 'invalid', message: 'x', issues });

    expect(error.code).toBe('invalid');
    expect(error.issues).toBeUndefined();
  });
});

describe('errorCode', () => {
  it('is the code of an API refusal', () => {
    expect(errorCode(new LanternApiError(401, 'unauthenticated', 'x'))).toBe('unauthenticated');
  });

  it.each([
    ['a network error', new TypeError('fetch failed')],
    ['an abort', new DOMException('aborted', 'AbortError')],
    ['a plain error', new Error('x')],
    ['a string', 'unauthenticated'],
    ['undefined', undefined],
  ])('is null for %s', (_label, failure) => {
    expect(errorCode(failure)).toBeNull();
  });
});
