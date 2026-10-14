// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import stylelint from 'stylelint';
import { describe, expect, it } from 'vitest';

import { stylelintRules } from '../../stylelint.rules.js';

import { FIXTURE_ROOT } from './fixture-config.js';

/**
 * The CSS half of the logical-properties rule (the JSX half is in
 * eslint-rules.test.ts), run against the same rule objects as
 * `stylelint.config.js`.
 */

async function rulesFiredIn(fixture: string): Promise<string[]> {
  const { results } = await stylelint.lint({
    files: `${FIXTURE_ROOT}/css/${fixture}`,
    configBasedir: process.cwd(),
    config: {
      extends: ['stylelint-config-standard'],
      plugins: ['stylelint-use-logical'],
      rules: stylelintRules,
    },
  });
  const [result] = results;
  if (result === undefined) throw new Error(`No lint result for ${fixture}; is the path right?`);
  return result.warnings.map((warning) => warning.rule);
}

describe('logical properties in CSS', () => {
  it('refuses physical properties and values', async () => {
    const fired = await rulesFiredIn('physical.css');

    // Both layers: the plugin, and the disallow list that backstops it in case
    // the plugin's coverage shifts under a version bump.
    expect(fired).toContain('csstools/use-logical');
    expect(fired).toContain('property-disallowed-list');
    expect(fired).toContain('declaration-property-value-disallowed-list');
  });

  it('passes the logical equivalents', async () => {
    expect(await rulesFiredIn('logical.css')).toEqual([]);
  });
});
