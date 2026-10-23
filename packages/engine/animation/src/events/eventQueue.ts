/**
 * Fixed-capacity event ring (spec 08 §3.5, §5.8, §5.13).
 *
 * Records are preallocated at API creation. A push when full drops the newest
 * event and returns false; the API increments `eventsDropped`. `drain` copies
 * references into caller slots and never allocates.
 */

import type { Entity } from "@lanpad/engine-core";
import type { AnimationClip, AnimationEvent } from "../contracts/animation.js";

export interface QueuedEvent {
  entity: Entity;
  clip: AnimationClip;
  name: string;
  payload: number;
  time: number;
}

/**
 * The ring hands out its records by reference. A consumer reads a drained
 * event before the queue can wrap (capacity events later); this is the
 * allocation-free interpretation of §3.5 "never allocates".
 */
export class EventQueue {
  readonly capacity: number;
  private readonly records: QueuedEvent[];
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.records = [];
    for (let i = 0; i < capacity; i += 1) {
      this.records.push({
        entity: { id: 0, generation: 0 },
        clip: EMPTY_CLIP,
        name: "",
        payload: 0,
        time: 0,
      });
    }
  }

  get size(): number {
    return this.count;
  }

  /** Queue order (oldest first). Returns false when the newest was dropped. */
  push(
    entity: Entity,
    clip: AnimationClip,
    name: string,
    payload: number,
    time: number,
  ): boolean {
    if (this.count >= this.capacity) return false;
    const index = (this.head + this.count) % this.capacity;
    const record = this.records[index]!;
    record.entity = entity;
    record.clip = clip;
    record.name = name;
    record.payload = payload;
    record.time = time;
    this.count += 1;
    return true;
  }

  /** Copies up to `out.length` records in queue order; leaves the rest. */
  drain(out: AnimationEvent[]): number {
    const limit = out.length < this.count ? out.length : this.count;
    for (let i = 0; i < limit; i += 1) {
      const record = this.records[(this.head + i) % this.capacity]!;
      out[i] = record;
    }
    this.head = (this.head + limit) % this.capacity;
    this.count -= limit;
    return limit;
  }

  peek(index: number): QueuedEvent | undefined {
    if (index < 0 || index >= this.count) return undefined;
    return this.records[(this.head + index) % this.capacity];
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}

/** Placeholder clip for preallocated records; never observable through drain. */
const EMPTY_CLIP: AnimationClip = {
  name: "",
  duration: 1,
  loop: "repeat",
  tracks: [],
  events: [],
  rootJoint: -1,
  sourceBytes: 0,
};
