// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

// The control for names-a-backend.tsx: the UI renders what the server's
// descriptor says, so it never needs a backend's name in its own source.
declare const descriptor: { label: string; capabilities: string[] };

export function Good() {
  return (
    <div title={descriptor.label}>
      {descriptor.capabilities.map((capability) => (
        <span key={capability}>{capability}</span>
      ))}
    </div>
  );
}
