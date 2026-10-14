// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The app's one lantern-client, handed to components through context rather
 * than imported as a module singleton, so a test renders a page with a fake
 * client and no module mocking.
 */

import type { LanternClient } from '@bureaucromancer/lantern-client';
import { createContext, use, type JSX, type ReactNode } from 'react';

const LanternClientContext = createContext<LanternClient | null>(null);

export function LanternClientProvider({
  client,
  children,
}: {
  client: LanternClient;
  children: ReactNode;
}): JSX.Element {
  return <LanternClientContext value={client}>{children}</LanternClientContext>;
}

export function useLanternClient(): LanternClient {
  const client = use(LanternClientContext);
  if (client === null) throw new Error('useLanternClient needs a LanternClientProvider above it.');
  return client;
}
