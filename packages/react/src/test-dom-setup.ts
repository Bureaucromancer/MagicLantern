// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Unmounts what a test rendered. Testing Library registers this itself only
 * when describe/it are globals, and this repository imports them explicitly;
 * without it renders accumulate and queries report multiple matches.
 */
afterEach(cleanup);
