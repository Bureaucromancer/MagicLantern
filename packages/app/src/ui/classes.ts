// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Class recipes spelled once. A class list copied between files is one that
 * drifts (StoryEngine found its text control spelled four ways, three without
 * a disabled state), so call sites import these instead. Recipes carry
 * appearance only; margins and other position belong to the call site.
 */

/** A field's label. */
export const fieldLabel = 'block text-sm font-medium text-ink-muted';

/** A text input. The disabled state uses tokens, not opacity, so contrast stays measurable. */
export const control =
  'w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:border-line disabled:bg-surface-muted disabled:text-ink-muted';

/** An inline link in prose. */
export const link =
  'text-accent underline underline-offset-2 hover:text-accent-hover focus-visible:outline-2 focus-visible:outline-focus';

/** The page column every signed-in page sits in. */
export const pageColumn = 'mx-auto w-full max-w-5xl px-6';

/** A bordered card on the canvas. */
export const panel = 'rounded-panel border border-line bg-surface p-6';
