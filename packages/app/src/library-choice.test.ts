// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import type { LibrarySummary } from '@bureaucromancer/lantern-client';
import { describe, expect, it } from 'vitest';

import { findLibrary, isLibraryId, needsSignIn, pickLibrary } from './library-choice.js';

const A = 'lib_01JA0000000000000000000000';
const B = 'lib_01JB0000000000000000000000';
const C = 'lib_01JC0000000000000000000000';

function library(id: string, status: LibrarySummary['status'] = 'ok'): LibrarySummary {
  return { id, name: id.slice(-4), status };
}

describe('whether / must go to sign-in', () => {
  it('sends a visitor without a session to sign-in in password mode', () => {
    expect(needsSignIn({ mode: 'password', authenticated: false })).toBe(true);
  });

  it('lets a signed-in visitor through', () => {
    expect(needsSignIn({ mode: 'password', authenticated: true })).toBe(false);
  });

  it('never asks in mode none', () => {
    expect(needsSignIn({ mode: 'none', authenticated: true })).toBe(false);
  });
});

describe('the library / opens', () => {
  it('is the one last used, while it is still listed', () => {
    expect(pickLibrary([library(A), library(B)], B)?.id).toBe(B);
  });

  it('is the remembered one even when read-only: the visitor chose it', () => {
    expect(pickLibrary([library(A), library(B, 'read-only')], B)?.id).toBe(B);
  });

  it('is the first one when the remembered one is gone', () => {
    expect(pickLibrary([library(A), library(B)], C)?.id).toBe(A);
  });

  it('is the first one when nothing is remembered', () => {
    expect(pickLibrary([library(A), library(B)], null)?.id).toBe(A);
  });

  it('skips a remembered library that cannot be opened', () => {
    expect(pickLibrary([library(A), library(B, 'unavailable')], B)?.id).toBe(A);
  });

  it('skips libraries that cannot be opened when choosing the first', () => {
    expect(pickLibrary([library(A, 'unavailable'), library(B)], null)?.id).toBe(B);
  });

  it('prefers a writable library to a read-only one when nothing is remembered', () => {
    expect(pickLibrary([library(A, 'read-only'), library(B)], null)?.id).toBe(B);
  });

  it('falls back to a read-only library when that is all there is', () => {
    expect(pickLibrary([library(A, 'unavailable'), library(B, 'read-only')], null)?.id).toBe(B);
  });

  it('is none when nothing can be opened', () => {
    expect(pickLibrary([library(A, 'unavailable')], A)).toBeUndefined();
    expect(pickLibrary([], null)).toBeUndefined();
  });
});

describe('library ids', () => {
  it('accepts lib_ and a ULID', () => {
    expect(isLibraryId(A)).toBe(true);
  });

  it('refuses anything else without asking the daemon', () => {
    expect(isLibraryId('lib_123')).toBe(false);
    expect(isLibraryId('library')).toBe(false);
    expect(isLibraryId(`${A}/..`)).toBe(false);
    // Crockford base32 has no I, L, O or U.
    expect(isLibraryId('lib_01JI0000000000000000000000')).toBe(false);
    expect(isLibraryId(A.toLowerCase())).toBe(false);
  });

  it('finds a listed library by id, and nothing for an unlisted one', () => {
    expect(findLibrary([library(A), library(B)], B)?.id).toBe(B);
    expect(findLibrary([library(A)], B)).toBeUndefined();
  });
});
