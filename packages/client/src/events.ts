// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Reading `GET /api/v1/events` (A31) with `fetch`, so it works in browsers
 * and in Node alike (Node has no EventSource) and carries the same headers as
 * every other call. The parser follows the SSE format: `id`, `event` and
 * `data` fields, a blank line ends an event, lines starting `:` are comments.
 */

import type { EventType } from '@bureaucromancer/lantern-schema';

/** One event from the stream: its id, its type, and its `data` parsed as JSON. */
export interface LanternStreamEvent {
  readonly id: string | null;
  readonly type: EventType | (string & {});
  readonly data: unknown;
}

/**
 * An incremental SSE parser: feed it text as it arrives, and it calls
 * `onEvent` for each whole event. Data that is not JSON arrives as the string.
 */
export function createEventParser(
  onEvent: (event: LanternStreamEvent) => void,
): (chunk: string) => void {
  let buffer = '';
  let id: string | null = null;
  let type = 'message';
  let data: string[] = [];
  const dispatch = (): void => {
    if (data.length === 0) {
      type = 'message';
      return;
    }
    const text = data.join('\n');
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON: passed on as text.
    }
    onEvent({ id, type, data: parsed });
    type = 'message';
    data = [];
  };
  return (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.search(/\r\n|\r|\n/);
      if (end === -1) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + (buffer.startsWith('\r\n', end) ? 2 : 1));
      if (line === '') {
        dispatch();
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'id') id = value;
      else if (field === 'event') type = value;
      else if (field === 'data') data.push(value);
    }
  };
}
