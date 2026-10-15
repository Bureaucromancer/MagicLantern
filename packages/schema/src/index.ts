// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * @bureaucromancer/lantern-schema: Magic Lantern's types as TypeBox schemas.
 *
 * Each schema is exported as a value and, under the same name, as its
 * `Static<>` type, so consumers never need to import TypeBox themselves.
 */

export * from './api/index.js';
export * from './request/index.js';
export * from './descriptor/index.js';
export * from './profile/index.js';
export * from './resolution/index.js';
