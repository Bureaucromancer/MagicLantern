// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The in-process event bus behind `GET /api/v1/events` (A31).
 *
 * Event ids are `<boot id>:<sequence>`, kept in a ring buffer, so a client
 * that reconnects with `Last-Event-ID` gets what it missed; an id from
 * another boot, or one that has fallen out of the buffer, gets `reset`, and
 * the client refetches. Payloads are already wire JSON. Progress events
 * carry no image bytes.
 */

import type {
  AssetCreatedEvent,
  JobProgressEvent,
  JobUpdatedEvent,
} from '@bureaucromancer/lantern-schema';

export type LanternEvent =
  | { readonly type: 'job.updated'; readonly data: JobUpdatedEvent }
  | { readonly type: 'job.progress'; readonly data: JobProgressEvent }
  | { readonly type: 'asset.created'; readonly data: AssetCreatedEvent }
  | { readonly type: 'backend.health'; readonly data: Readonly<Record<string, unknown>> }
  | { readonly type: 'reset'; readonly data: Readonly<Record<string, never>> };

/** An event with its id. */
export type StampedEvent = LanternEvent & { readonly id: string };

export type EventListener = (event: StampedEvent) => void;

/** How many events a reconnecting client can catch up on. */
export const EVENT_BUFFER_SIZE = 1000;

export class EventBus {
  readonly bootId: string;
  private sequence = 0;
  private readonly buffer: StampedEvent[] = [];
  private readonly listeners = new Set<EventListener>();
  private readonly capacity: number;

  constructor(bootId: string, capacity = EVENT_BUFFER_SIZE) {
    this.bootId = bootId;
    this.capacity = capacity;
  }

  publish(event: LanternEvent): StampedEvent {
    this.sequence += 1;
    const stamped = { ...event, id: `${this.bootId}:${String(this.sequence)}` } as StampedEvent;
    this.buffer.push(stamped);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    for (const listener of this.listeners) {
      try {
        listener(stamped);
      } catch {
        // One broken subscriber must not stop the others or the publisher.
      }
    }
    return stamped;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * What a client that last saw `lastId` missed, oldest first; `reset` when
   * that id is not one this bus can answer for.
   */
  since(lastId: string): readonly StampedEvent[] | 'reset' {
    const [boot, sequence] = lastId.split(':');
    const seen = Number(sequence);
    if (boot !== this.bootId || !Number.isSafeInteger(seen) || seen < 0 || seen > this.sequence) {
      return 'reset';
    }
    const oldest = this.buffer[0];
    const oldestSequence =
      oldest === undefined ? this.sequence + 1 : Number(oldest.id.split(':')[1]);
    // Something between what it saw and what is kept was dropped.
    if (seen + 1 < oldestSequence && seen < this.sequence) return 'reset';
    return this.buffer.filter((event) => Number(event.id.split(':')[1]) > seen);
  }

  get subscribers(): number {
    return this.listeners.size;
  }
}
