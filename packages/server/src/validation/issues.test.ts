// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { describe, expect, it } from 'vitest';

import { issuesOfAjv, messageOfIssue, pathOfIssue } from './issues.js';

describe('pathOfIssue', () => {
  it('joins the key Ajv keeps in params', () => {
    expect(pathOfIssue({ instancePath: '', params: { additionalProperty: 'x' } })).toBe('/x');
    expect(pathOfIssue({ instancePath: '/a', params: { missingProperty: 'b' } })).toBe('/a/b');
    expect(pathOfIssue({ instancePath: '/a/0', params: {} })).toBe('/a/0');
  });

  it("is '' for the whole body, as RFC 6901 has it", () => {
    expect(pathOfIssue({ instancePath: '', params: {} })).toBe('');
  });

  it('escapes the joined key as Ajv escapes its instancePath (~ before /)', () => {
    expect(pathOfIssue({ instancePath: '', params: { additionalProperty: 'a/b' } })).toBe('/a~1b');
    expect(pathOfIssue({ instancePath: '', params: { additionalProperty: 'x~y' } })).toBe('/x~0y');
    expect(pathOfIssue({ instancePath: '', params: { additionalProperty: '~1' } })).toBe('/~01');
    expect(pathOfIssue({ instancePath: '/a~1b', params: { missingProperty: 'z/w' } })).toBe(
      '/a~1b/z~1w',
    );
  });
});

describe('messageOfIssue and issuesOfAjv', () => {
  it("name an unknown and a missing field as such, and keep Ajv's message otherwise", () => {
    expect(messageOfIssue({ keyword: 'additionalProperties', instancePath: '', params: {} })).toBe(
      'is not a known field',
    );
    expect(messageOfIssue({ keyword: 'required', instancePath: '', params: {} })).toBe(
      'is required',
    );
    expect(
      messageOfIssue({
        keyword: 'maximum',
        instancePath: '/a',
        params: {},
        message: 'must be <= 2',
      }),
    ).toBe('must be <= 2');
    expect(messageOfIssue({ keyword: 'x', instancePath: '', params: {} })).toBe('is invalid');
  });

  it('keep the most telling error at each pointer, in first-seen order', () => {
    expect(
      issuesOfAjv([
        { keyword: 'type', instancePath: '/seed', params: {}, message: 'must be string' },
        {
          keyword: 'const',
          instancePath: '/seed',
          params: {},
          message: 'must be equal to constant',
        },
        { keyword: 'required', instancePath: '', params: { missingProperty: 'mode' } },
        { keyword: 'maximum', instancePath: '/seed', params: {}, message: 'must be <= 9' },
        {
          keyword: 'anyOf',
          instancePath: '/seed',
          params: {},
          message: 'must match a schema in anyOf',
        },
      ]),
    ).toEqual([
      { path: '/seed', message: 'must be <= 9' },
      { path: '/mode', message: 'is required' },
    ]);
  });

  it('turn each error into one issue, in order', () => {
    expect(
      issuesOfAjv([
        {
          keyword: 'additionalProperties',
          instancePath: '/a',
          params: { additionalProperty: 'b' },
        },
        { keyword: 'type', instancePath: '/c', params: {}, message: 'must be number' },
      ]),
    ).toEqual([
      { path: '/a/b', message: 'is not a known field' },
      { path: '/c', message: 'must be number' },
    ]);
  });
});
