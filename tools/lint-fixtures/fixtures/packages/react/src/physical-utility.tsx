// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

// lantern-react renders inside StoryEngine, which enforces logical direction.
// One report per className expression, so each shape gets its own element.
declare const wide: boolean;

export function Bad() {
  return (
    <div>
      <span className="ml-4">a plain literal</span>
      <span className={`text-left ${wide ? 'w-full' : ''}`}>a template literal</span>
      <span className="md:hover:rounded-r-lg">behind variant prefixes</span>
    </div>
  );
}
