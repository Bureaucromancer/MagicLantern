// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

// Rule 3: the UI never names a backend, in any of the shapes a name arrives in.
declare const backend: { id: string };

const sdcppUrl = 'http://127.0.0.1:1234';

export function Bad() {
  const isComfy = backend.id === 'comfy';
  return (
    <div title={`${sdcppUrl} via sdapi`}>
      {isComfy ? 'ComfyUI workflow' : null}
      <span>Running on sd.cpp</span>
    </div>
  );
}
