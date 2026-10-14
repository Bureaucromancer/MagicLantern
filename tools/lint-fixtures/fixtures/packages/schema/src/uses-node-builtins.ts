// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

// Schema runs in browsers too: neither spelling of a built-in is allowed.
import { EventEmitter } from 'events';
import { join } from 'node:path';

export const used = [EventEmitter, join];
