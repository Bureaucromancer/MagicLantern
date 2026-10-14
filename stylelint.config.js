// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { stylelintRules } from './stylelint.rules.js';

/** @type {import('stylelint').Config} */
export default {
  extends: ['stylelint-config-standard'],
  plugins: ['stylelint-use-logical'],
  ignoreFiles: [
    '**/dist/**',
    '**/dist-types/**',
    '**/node_modules/**',
    'tools/lint-fixtures/fixtures/**',
  ],
  rules: stylelintRules,
};
