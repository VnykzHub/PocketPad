/**
 * Game-facing input view and controller event queue (D3-RT-04; FR-7.11,
 * FR-7.12, FR-7.17).
 *
 * The fixed loop calls `InputMapper.pollAll()` exactly once per tick and
 * hands the pooled snapshot to the host; `SnapshotInputReader.update()` only
 * swaps the reference, so `poll()` is a view, never a second poll. Edges are
 * therefore seen exactly once per tick.
 *
 * `GameEventQueue` is a fixed-capacity ring: producers (D5's server `event`
 * routing) push between ticks; the host drains once per tick before
 * `simulate`. When full it drops the oldest event and counts the drop rather
 * than growing. Event objects are pooled; games must copy what they keep.
 */
import type { GameEvent, GameInputReader, JsonValue } from "@lanpad/sdk";
import type { ControllerState, InputSnapshot } from "../input/types.js";

/** Default per-tick event capacity (D3-RT-04 risk note: 256/tick). */
export const DEFAULT_EVENT_CAPACITY = 256;

interface MutableGameEvent {
  slot: number;
  name: string;
  data: JsonValue;
}

function createEventPool(capacity: number): MutableGameEvent[] {
  const pool: MutableGameEvent[] = [];
  for (let index = 0; index < capacity; index += 1) {
    pool.push({ slot: 0, name: "", data: null });
  }
  return pool;
}

export class GameEventQueue {
  readonly capacity: number;

  private readonly ring: MutableGameEvent[];
  private readonly drained: MutableGameEvent[];
  /** View handed to games; its length is reset each drain. */
  private readonly view: GameEvent[] = [];
  private head = 0;
  private size = 0;
  private droppedValue = 0;

  constructor(capacity: number = DEFAULT_EVENT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("GameEventQueue capacity must be a positive integer.");
    }
    this.capacity = capacity;
    this.ring = createEventPool(capacity);
    this.drained = createEventPool(capacity);
  }

  /** Events dropped because the queue was full (oldest first). */
  get dropped(): number {
    return this.droppedValue;
  }

  /** Events waiting for the next drain. */
  get pending(): number {
    return this.size;
  }

  push(slot: number, name: string, data: JsonValue): void {
    if (this.size === this.capacity) {
      this.head = (this.head + 1) % this.capacity;
      this.size -= 1;
      this.droppedValue += 1;
    }
    const target = this.ring[(this.head + this.size) % this.capacity];
    if (target === undefined) return;
    target.slot = slot;
    target.name = name;
    target.data = data;
    this.size += 1;
  }

  /**
   * Moves every pending event into the per-tick view and returns it. The
   * previous view is invalidated (pooled objects are overwritten).
   */
  drain(): ReadonlyArray<GameEvent> {
    const view = this.view;
    view.length = 0;
    for (let index = 0; index < this.size; index += 1) {
      const source = this.ring[(this.head + index) % this.capacity];
      const target = this.drained[index];
      if (source === undefined || target === undefined) continue;
      target.slot = source.slot;
      target.name = source.name;
      target.data = source.data;
      source.data = null;
      view.push(target);
    }
    this.head = 0;
    this.size = 0;
    return view;
  }

  /** The view produced by the last `drain()`. */
  current(): ReadonlyArray<GameEvent> {
    return this.view;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
    this.view.length = 0;
  }
}

const EMPTY_SNAPSHOT: InputSnapshot = Object.freeze({
  tick: 0,
  players: Object.freeze([]) as ReadonlyArray<ControllerState>,
});

/** The `ctx.input` implementation. */
export class SnapshotInputReader implements GameInputReader {
  private current: InputSnapshot = EMPTY_SNAPSHOT;
  private readonly queue: GameEventQueue;
  /**
   * Optional start-of-simulate hook. `main.ts` installs `EventRouter.dispatch`
   * here so named `ctx.events.on` handlers run at the start of the tick, just
   * before the game's own `onEvent` callbacks (D5-RT-01).
   */
  private tickHook: (() => void) | null = null;

  constructor(queue: GameEventQueue) {
    this.queue = queue;
  }

  get snapshot(): InputSnapshot {
    return this.current;
  }

  /** Host-only: installs the event-dispatch hook called at each tick start. */
  setTickHook(hook: (() => void) | null): void {
    this.tickHook = hook;
  }

  /** Host-only: called by the loop hook with the tick's single poll result. */
  update(snapshot: InputSnapshot): void {
    if (this.tickHook !== null) {
      this.tickHook();
    }
    this.current = snapshot;
  }

  poll(): InputSnapshot {
    return this.current;
  }

  player(slot: number): ControllerState | undefined {
    if (!Number.isInteger(slot) || slot < 1) return undefined;
    return this.current.players[slot - 1];
  }

  events(): ReadonlyArray<GameEvent> {
    return this.queue.current();
  }
}
