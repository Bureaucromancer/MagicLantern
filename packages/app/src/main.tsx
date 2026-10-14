// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { createLanternClient } from '@bureaucromancer/lantern-client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { createAppState } from './app-state.js';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root mount point in index.html');
}

// No baseUrl: the daemon serves this page, or Vite proxies to it, so every
// request is same-origin and carries the session cookie.
const state = createAppState(createLanternClient());

createRoot(container).render(
  <StrictMode>
    <App {...state} />
  </StrictMode>,
);
