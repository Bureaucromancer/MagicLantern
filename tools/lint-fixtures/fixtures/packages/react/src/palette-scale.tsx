// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

// A colour decided at the call site rather than by a token, and the variant
// that means a token is missing.
export function Bad() {
  return (
    <div className="bg-slate-50">
      <span className="hover:text-red-900/40">a scale behind a variant</span>
      <span className="dark:bg-surface">a dark variant</span>
    </div>
  );
}
