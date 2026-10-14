// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

// The store is where the filesystem is allowed.
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

export const used = [readFileSync, writeFile];
