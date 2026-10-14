// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** The daemon's default bind (lantern.json `host` and `port`). */
const DAEMON = 'http://127.0.0.1:7600';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Fixed, because the daemon's dev script allowlists exactly this origin
    // (LANTERN_ALLOWED_ORIGINS=http://localhost:5173).
    port: 5173,
    strictPort: true,
    // Proxying keeps the app same-origin, which the SameSite=Strict session
    // cookie needs. changeOrigin rewrites Host to the daemon's own, which its
    // Host allowlist accepts; Origin is left alone (never rewrite it: that would
    // let any site post through the dev server) and allowlisted instead.
    proxy: {
      '/api': { target: DAEMON, changeOrigin: true },
      '/healthz': { target: DAEMON, changeOrigin: true },
    },
  },
  // No `base`: the built index.html references /assets/... absolutely, which
  // works when the daemon serves the app from its root.
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
