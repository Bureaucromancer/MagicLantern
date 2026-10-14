// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LibraryStatusBadge } from './LibraryStatusBadge.js';

describe('LibraryStatusBadge', () => {
  it.each([
    ['ok', 'Available'],
    ['read-only', 'Read-only'],
    ['unavailable', 'Unavailable'],
  ] as const)('labels %s as %s', (status, label) => {
    render(<LibraryStatusBadge status={status} />);
    const badge = screen.getByText(label);
    expect(badge.dataset['status']).toBe(status);
  });
});
