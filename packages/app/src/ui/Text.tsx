// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import type { JSX, ReactNode } from 'react';

/**
 * The type scale. Step names say the structural role, not the size, so a
 * theme can move the size without the name becoming wrong; the element is
 * separate from the step because heading level is document structure and
 * belongs to the page.
 */

type Level = 'h1' | 'h2' | 'h3';

interface HeadingProps {
  children: ReactNode;
  as?: Level;
  id?: string;
  /** Position only: the margin below the heading. */
  className?: string;
}

function heading(step: string, fallback: Level) {
  return function Heading({ children, as, id, className }: HeadingProps): JSX.Element {
    const Tag = as ?? fallback;
    return (
      <Tag id={id} className={className === undefined ? step : `${className} ${step}`}>
        {children}
      </Tag>
    );
  };
}

/** The name of the page. One per page. */
export const PageTitle = heading('text-title text-ink', 'h1');

/** A region within the page. */
export const SectionTitle = heading('text-section text-ink', 'h2');

/** Supporting prose: what a control does, an empty state, a loading line. */
export function Note({
  children,
  className,
  role,
}: {
  children: ReactNode;
  className?: string;
  role?: 'status';
}): JSX.Element {
  const classes = 'text-sm text-ink-subtle';
  return (
    <p role={role} className={className === undefined ? classes : `${className} ${classes}`}>
      {children}
    </p>
  );
}
