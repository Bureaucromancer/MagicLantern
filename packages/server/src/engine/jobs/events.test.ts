// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

import { describe, expect, it } from 'vitest';

import { EventBus, type LanternEvent } from './events.js';

const RESET: LanternEvent = { type: 'reset', data: {} };

describe('the event bus (A31)', () => {
  it('stamps events <boot>:<sequence> and delivers them to subscribers', () => {
    const bus = new EventBus('boot1');
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event.id));
    bus.publish(RESET);
    bus.publish(RESET);
    unsubscribe();
    bus.publish(RESET);
    expect(seen).toEqual(['boot1:1', 'boot1:2']);
    expect(bus.subscribers).toBe(0);
  });

  it('replays what came after an id, and resets for an unknown one', () => {
    const bus = new EventBus('boot1', 3);
    for (let index = 0; index < 5; index += 1) bus.publish(RESET);
    expect((bus.since('boot1:3') as readonly { id: string }[]).map((event) => event.id)).toEqual([
      'boot1:4',
      'boot1:5',
    ]);
    expect(bus.since('boot1:5')).toEqual([]);
    // Fell out of the buffer, another boot, from the future, or not an id.
    for (const id of ['boot1:1', 'boot0:4', 'boot1:9', 'nonsense'])
      expect(bus.since(id)).toBe('reset');
  });

  it('keeps delivering when one subscriber throws', () => {
    const bus = new EventBus('b');
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error('broken');
    });
    bus.subscribe((event) => seen.push(event.id));
    bus.publish(RESET);
    expect(seen).toEqual(['b:1']);
  });
});
