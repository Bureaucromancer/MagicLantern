// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import { ConfigError, ConfigSchema, DEFAULT_CONFIG } from './schema.js';

describe('the config schema', () => {
  it('accepts the defaults', () => {
    expect(Value.Check(ConfigSchema, DEFAULT_CONFIG)).toBe(true);
  });

  it('declares the same defaults as DEFAULT_CONFIG', () => {
    expect(Value.Default(ConfigSchema, {})).toEqual(DEFAULT_CONFIG);
  });

  it('fills a partial document from the defaults', () => {
    const partial = { port: 8000, auth: { mode: 'password' } };
    expect(Value.Default(ConfigSchema, partial)).toEqual({
      ...DEFAULT_CONFIG,
      port: 8000,
      auth: { ...DEFAULT_CONFIG.auth, mode: 'password' },
    });
  });

  it('binds loopback with no password by default', () => {
    expect(DEFAULT_CONFIG.host).toBe('127.0.0.1');
    expect(DEFAULT_CONFIG.auth).toEqual({ mode: null, trustNetwork: false, cookieSecure: false });
  });

  it.each([
    ['a port out of range', { ...DEFAULT_CONFIG, port: 70000 }],
    ['a fractional port', { ...DEFAULT_CONFIG, port: 7600.5 }],
    ['a port given as a string', { ...DEFAULT_CONFIG, port: '7600' }],
    [
      'an unknown auth mode',
      { ...DEFAULT_CONFIG, auth: { ...DEFAULT_CONFIG.auth, mode: 'proxy' } },
    ],
    ['an unknown log level', { ...DEFAULT_CONFIG, log: { level: 'loud' } }],
    ['an empty host', { ...DEFAULT_CONFIG, host: '' }],
    ['a non-string allowed host', { ...DEFAULT_CONFIG, allowedHosts: [7] }],
  ])('refuses %s', (_label, document) => {
    expect(Value.Check(ConfigSchema, document)).toBe(false);
  });

  it('keeps unknown keys rather than refusing to start over them', () => {
    expect(Value.Check(ConfigSchema, { ...DEFAULT_CONFIG, fromTheFuture: true })).toBe(true);
  });
});

describe('DEFAULT_CONFIG', () => {
  it('is deeply frozen, so a merge cannot rewrite it for the rest of the process', () => {
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.auth)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.allowedHosts)).toBe(true);
    expect(() => {
      (DEFAULT_CONFIG.auth as { trustNetwork: boolean }).trustNetwork = true;
    }).toThrow(TypeError);
  });

  it('clones into an ordinary, mutable object', () => {
    const copy = structuredClone(DEFAULT_CONFIG);
    copy.allowedHosts.push('lantern.lan');
    expect(DEFAULT_CONFIG.allowedHosts).toEqual([]);
  });
});

describe('ConfigError', () => {
  it('names every issue in one sentence', () => {
    const error = new ConfigError('LANTERN_PORT', ['must be an integer']);
    expect(error.message).toBe('LANTERN_PORT is not valid: must be an integer');
    expect(error.issues).toEqual(['must be an integer']);
    expect(error.name).toBe('ConfigError');
  });
});
