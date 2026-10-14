// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * Unmounts what a test rendered. Testing Library registers this itself only
 * when describe/it are globals, and this repository imports them explicitly;
 * without it renders accumulate and queries report multiple matches.
 */
afterEach(cleanup);

/**
 * jsdom computes no layout, so it has no `scrollIntoView`. A spy rather than a
 * no-op, so a component that must bring something into view can be asserted
 * to have asked.
 */
Element.prototype.scrollIntoView = vi.fn();

/** The router resets the scroll position after each navigation; jsdom only logs "not implemented". */
vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

/**
 * Node 25+ defines a `localStorage` global of its own (undefined unless Node
 * runs with --localstorage-file), and it shadows the one vitest copies from
 * jsdom, so code under test would see no storage at all. vitest exposes the
 * jsdom instance as `jsdom`; its window still has working Web Storage.
 */
const dom = (globalThis as { jsdom?: { window: Pick<Window, 'localStorage' | 'sessionStorage'> } })
  .jsdom;
if (dom !== undefined) {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    Object.defineProperty(globalThis, name, {
      value: dom.window[name],
      configurable: true,
      writable: true,
    });
  }
}
