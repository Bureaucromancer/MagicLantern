// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import type { ComponentProps, JSX } from 'react';

/**
 * The button. `type` is required because an omitted one inside a `<form>` is a
 * submit button, which is the bug that only shows on the screen nobody
 * re-tested. `className` is for position (a margin, `w-full`), never colour:
 * Tailwind's cascade follows stylesheet order, so a colour passed here would
 * fight the variant rather than override it.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'quiet';
export type ButtonSize = 'default' | 'compact';

/** The same focus ring a text control draws, so focus looks alike across the page. */
const BASE =
  'rounded-control font-medium focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed';

/**
 * Every variant has a disabled state in tokens, label and fill together;
 * opacity would dim text below the contrast floor. theme.test.ts measures each
 * pairing in both themes.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-on-accent hover:bg-accent-hover disabled:bg-accent-muted disabled:text-on-accent-muted',
  secondary:
    'border border-line-strong text-ink-muted hover:bg-surface-muted disabled:text-ink-faint',
  quiet: 'text-ink-subtle underline hover:text-ink disabled:text-ink-faint disabled:no-underline',
};

const SIZE: Record<ButtonSize, string> = {
  default: 'px-4 py-2 text-sm',
  compact: 'px-3 py-1 text-sm',
};

export interface ButtonProps extends Omit<ComponentProps<'button'>, 'className'> {
  type: 'button' | 'submit' | 'reset';
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Position only: a margin, `ms-auto`, `w-full`. */
  className?: string;
}

export function Button({
  variant = 'secondary',
  size = 'default',
  className,
  ...rest
}: ButtonProps): JSX.Element {
  const classes = `${BASE} ${VARIANT[variant]} ${SIZE[size]}`;
  return (
    <button {...rest} className={className === undefined ? classes : `${className} ${classes}`} />
  );
}
