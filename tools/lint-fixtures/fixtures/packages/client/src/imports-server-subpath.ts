// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

// A deep import: `paths` in no-restricted-imports compares exact names, so only
// the `<name>/*` pattern catches this.
import { buildApp } from '@bureaucromancer/lantern-server/dist/app.js';

export const used = buildApp;
