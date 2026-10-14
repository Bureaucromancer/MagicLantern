// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import type { JSX, ReactNode } from 'react';

/**
 * A bordered box saying something went wrong, or might. The tones are
 * meanings: `error` is a refusal or failure, `warning` is something wrong you
 * may proceed past, `neutral` is a fact that needs a box.
 *
 * `role` is passed through rather than assumed: a box shown in reaction to an
 * action wants `alert`; one present when the page loaded would interrupt a
 * screen reader with old news.
 */

export type AlertTone = 'error' | 'warning' | 'neutral';

const BASE = 'rounded-panel border p-3 text-sm';

const TONE: Record<AlertTone, string> = {
  error: 'border-danger-line bg-danger-surface text-danger-ink',
  warning: 'border-warn-line bg-warn-surface text-warn-ink',
  neutral: 'border-line bg-surface-sunken text-ink-muted',
};

export interface AlertProps {
  tone?: AlertTone;
  children: ReactNode;
  role?: 'alert' | 'status';
  /** Position only. */
  className?: string;
}

export function Alert({ tone = 'error', children, role, className }: AlertProps): JSX.Element {
  const classes = `${BASE} ${TONE[tone]}`;
  return (
    <div role={role} className={className === undefined ? classes : `${className} ${classes}`}>
      {children}
    </div>
  );
}
