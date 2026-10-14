// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

// Request-time code reaches the disk through the store, not directly.
import { readFileSync } from 'node:fs';
import { writeFile } from 'fs/promises';

export const used = [readFileSync, writeFile];
