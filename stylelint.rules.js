// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The CSS half of the logical-properties rule, split out of
 * `stylelint.config.js` so the fixture tests can run against these objects.
 * The JSX half (Tailwind utilities, which are not declarations) lives in
 * `eslint.rules.js`. Logical properties matter here because lantern-react
 * renders inside StoryEngine, which enforces the same rule.
 */

const LOGICAL_MESSAGE =
  'Physical property. Use the logical equivalent (margin-inline-start, ' +
  'padding-inline-end, inset-inline-start, border-inline-start…).';

/**
 * The plugin covers the common declarations; this list is the backstop in case
 * its coverage shifts under a version bump. Only direction-sensitive
 * properties: `width` and `height` are axis-sensitive and banning them would be
 * a rule people fight rather than follow.
 */
const PHYSICAL_PROPERTIES = [
  /^margin-(left|right|top|bottom)$/,
  /^padding-(left|right|top|bottom)$/,
  /^border-(left|right|top|bottom)(-.*)?$/,
  /^(left|right|top|bottom)$/,
  /^border-(top|bottom)-(left|right)-radius$/,
  /^scroll-margin-(left|right|top|bottom)$/,
  /^scroll-padding-(left|right|top|bottom)$/,
];

/** @type {NonNullable<import('stylelint').Config['rules']>} */
export const stylelintRules = {
  'csstools/use-logical': 'always',

  'property-disallowed-list': [PHYSICAL_PROPERTIES, { message: LOGICAL_MESSAGE }],

  'declaration-property-value-disallowed-list': [
    {
      'text-align': ['left', 'right'],
      float: ['left', 'right'],
      clear: ['left', 'right'],
      resize: ['horizontal', 'vertical'],
    },
    {
      message:
        'Physical direction. Use `start` / `end` (text-align, float, clear) or ' +
        '`block` / `inline` (resize).',
    },
  ],

  // Tailwind v4 is configured in CSS at-rules, so the standard config's
  // unknown-at-rule check is told about them rather than disabled: a typo'd
  // at-rule still fails.
  'at-rule-no-unknown': [
    true,
    {
      ignoreAtRules: [
        'theme',
        'source',
        'utility',
        'variant',
        'custom-variant',
        'apply',
        'reference',
        'config',
        'plugin',
      ],
    },
  ],

  'at-rule-no-deprecated': [true, { ignoreAtRules: ['apply'] }],

  // `@import "tailwindcss"` is a package specifier, not a URL.
  'import-notation': 'string',

  // A font token holds family names (`BlinkMacSystemFont`), which the
  // keyword-case rule cannot tell from keywords inside a custom property.
  'value-keyword-case': ['lower', { ignoreProperties: [/^--font-/] }],

  // Tailwind v4 spells a token's sub-property with a doubled hyphen
  // (`--text-section--line-height`); otherwise names stay kebab-case.
  'custom-property-pattern': [
    '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$',
    {
      message:
        'Custom property names are kebab-case, optionally with one `--` before ' +
        'a Tailwind theme sub-property (`--text-section--line-height`).',
    },
  ],
};
