// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

// The control for uses-node-builtins.ts in schema: the server runs in Node.
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

export const used = [EventEmitter, join];
