/**
 * Host layout manager (D5-RT-01; FR-8.2, D5 contracts 1, 2, 7, 8).
 *
 * `ctx.layouts.set(slot | "all", layout)` validates the document with the
 * SDK, sends one `setLayout` control message and tracks the controller ack
 * per slot by layout id. Games that need every phone ready call
 * `waitForAcks()`, which resolves when each targeted slot has acked (or has
 * no controller) and rejects with per-slot statuses on timeout.
 *
 * A sender failure is surfaced, never swallowed: `set()` throws an `Error`
 * naming the layout and target, and `lastError` keeps that failure. Recovery
 * re-sends record it without throwing from an event handler.
 *
 * The broker already replays the last layout to a rejoining controller, but
 * the plan also requires the host to re-send on `playerResumed`; this class
 * does that (and on `playerJoined`, for layouts set before a slot existed,
 * because the broker only stores layouts for known slots).
 *
 * Layout bodies stay opaque JSON on the wire (FR-7.9). No socket is exposed
 * to games (FR-7.17); the injected sender is the host client's `send`.
 */
import {
  validateLayout,
  type JsonValue,
  type LayoutDocument,
} from "@lanpad/sdk";
import { MAX_CONTROLLERS, type HostToServerMessage } from "@lanpad/protocol";

/** A specific slot (1..8) or every slot. */
export type LayoutTarget = number | "all";

/** Minimal sender surface; `HostClient.send` satisfies it. */
export interface LayoutSender {
  send(message: HostToServerMessage): void;
}

export type LayoutTimer = ReturnType<typeof setTimeout>;

export interface LayoutApiDeps {
  readonly sender: LayoutSender;
  /** Number of slots the host exposes, 1..8. Default 8. */
  readonly slots?: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => LayoutTimer;
  readonly clearTimer?: (handle: LayoutTimer) => void;
}

/** Thrown for a document the SDK validator rejects (developer error). */
export class LayoutValidationError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(`Invalid layout: ${errors.join("; ")}.`);
    this.name = "LayoutValidationError";
    this.errors = errors;
  }
}

export type LayoutAckState = "acked" | "pending" | "timeout" | "noPlayer" | "notSent";

/** Per-slot ack state for `waitForAcks`. */
export interface LayoutAckStatus {
  readonly slot: number;
  /** Layout id that was current when the status was sampled, or null. */
  readonly layoutId: string | null;
  readonly state: LayoutAckState;
}

/** Rejection value of `waitForAcks` when the timeout elapses. */
export class LayoutAckTimeoutError extends Error {
  readonly statuses: readonly LayoutAckStatus[];

  constructor(statuses: readonly LayoutAckStatus[]) {
    const waiting = statuses
      .filter((status) => status.state !== "acked" && status.state !== "noPlayer")
      .map((status) => `${status.slot}:${status.state}`)
      .join(", ");
    super(`Layout acks timed out (${waiting}).`);
    this.name = "LayoutAckTimeoutError";
    this.statuses = statuses;
  }
}

export interface LayoutCounters {
  /** Successful `setLayout` frames (one per API call, not per slot). */
  readonly swaps: number;
  readonly acksReceived: number;
  readonly staleAcks: number;
  readonly sendFailures: number;
  readonly pendingAcks: number;
  /** Slots whose stored layout was discarded by `handleLeft` or `clear`. */
  readonly cleared: number;
}

function validateTarget(target: LayoutTarget): void {
  if (target === "all") {
    return;
  }
  if (!Number.isInteger(target) || target < 1 || target > MAX_CONTROLLERS) {
    throw new RangeError(
      `ctx.layouts target must be an integer in 1..${MAX_CONTROLLERS} or "all".`,
    );
  }
}

/** Deep copy on storage so later game mutation cannot change a resend. */
function cloneLayout(layout: LayoutDocument): LayoutDocument {
  return JSON.parse(JSON.stringify(layout)) as LayoutDocument;
}

export class LayoutApi {
  private readonly sender: LayoutSender;
  private readonly slotCount: number;
  private readonly clock: () => number;
  private readonly setTimerFn: (callback: () => void, delayMs: number) => LayoutTimer;
  private readonly clearTimerFn: (handle: LayoutTimer) => void;

  /** One current layout per slot (index = slot - 1), never per send. */
  private readonly layouts: (LayoutDocument | null)[];
  /** Last id acked this session, per slot. */
  private readonly acked: (string | null)[];
  /** Id awaiting an ack, per slot; null when no ack is expected. */
  private readonly pending: (string | null)[];
  private readonly occupied: boolean[];
  /** Registered layouts addressable by id for the SDK's string API. */
  private readonly registry = new Map<string, LayoutDocument>();

  private swaps = 0;
  private acksReceived = 0;
  private staleAcks = 0;
  private sendFailures = 0;
  private cleared = 0;
  private lastSentAtMs: number | null = null;
  private lastSendErrorValue: Error | null = null;
  private readonly waiters = new Set<() => void>();

  constructor(deps: LayoutApiDeps) {
    const slots = deps.slots ?? MAX_CONTROLLERS;
    if (!Number.isInteger(slots) || slots < 1 || slots > MAX_CONTROLLERS) {
      throw new RangeError(
        `LayoutApi slots must be an integer in 1..${MAX_CONTROLLERS}.`,
      );
    }
    this.sender = deps.sender;
    this.slotCount = slots;
    this.clock = deps.now ?? (() => performance.now());
    this.setTimerFn = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimerFn =
      deps.clearTimer ??
      ((handle) => {
        clearTimeout(handle);
      });

    this.layouts = new Array<LayoutDocument | null>(slots).fill(null);
    this.acked = new Array<string | null>(slots).fill(null);
    this.pending = new Array<string | null>(slots).fill(null);
    this.occupied = new Array<boolean>(slots).fill(false);
  }

  get counters(): LayoutCounters {
    let pendingAcks = 0;
    for (const id of this.pending) {
      if (id !== null) {
        pendingAcks += 1;
      }
    }
    return {
      swaps: this.swaps,
      acksReceived: this.acksReceived,
      staleAcks: this.staleAcks,
      sendFailures: this.sendFailures,
      pendingAcks,
      cleared: this.cleared,
    };
  }

  /** Host clock at the most recent accepted `setLayout` send, or null. */
  get lastSentAt(): number | null {
    return this.lastSentAtMs;
  }

  /**
   * Most recent sender failure, or null after a successful send. `set()`
   * throws the same Error; recovery re-sends keep it here without throwing
   * into an event handler.
   */
  get lastError(): Error | null {
    return this.lastSendErrorValue;
  }

  /**
   * Validates and stores a layout so later `set(slot, id)` calls can resolve
   * the SDK's string form. Returns the layout id.
   */
  register(layout: LayoutDocument): string {
    const validated = this.validate(layout);
    const copy = cloneLayout(validated);
    this.registry.set(copy.id, copy);
    return copy.id;
  }

  /**
   * Sets `layout` for one slot or all slots. Accepts either a layout document
   * (plan contract 7) or the id of a document previously passed to
   * `register()` (the SDK's `ctx.layouts.set(slot, layoutId)` form).
   *
   * Sending the same id twice to the same targets is a no-op unless the
   * previous send failed, so a game cannot accidentally spam the channel.
   */
  set(target: LayoutTarget, layout: LayoutDocument | string): void {
    validateTarget(target);
    let validated: LayoutDocument;
    if (typeof layout === "string") {
      const registered = this.registry.get(layout);
      if (registered === undefined) {
        throw new LayoutValidationError([
          `layout id "${layout}" is not registered; pass the layout document or call register() first`,
        ]);
      }
      validated = registered;
    } else {
      validated = cloneLayout(this.validate(layout));
      this.registry.set(validated.id, validated);
    }

    const targets = this.targetSlots(target);
    const unchanged = targets.every((slot) => {
      const index = slot - 1;
      return (
        this.layouts[index]?.id === validated.id &&
        (this.acked[index] === validated.id || this.pending[index] === validated.id)
      );
    });
    if (unchanged) {
      return;
    }

    for (const slot of targets) {
      const index = slot - 1;
      this.layouts[index] = validated;
      this.acked[index] = null;
      this.pending[index] = this.occupied[index] ? validated.id : null;
    }

    try {
      this.sender.send({
        t: "setLayout",
        slot: target,
        layout: validated as unknown as JsonValue,
      });
    } catch (error) {
      this.sendFailures += 1;
      for (const slot of targets) {
        this.pending[slot - 1] = null;
      }
      // A13 makes 16 KB layouts sendable, so a throw here is a real transport
      // failure. Surface it instead of silently losing the layout.
      throw this.failSend("ctx.layouts.set", validated.id, target, error);
    }
    this.lastSendErrorValue = null;
    this.swaps += 1;
    this.lastSentAtMs = this.clock();
  }

  /**
   * Forgets the host-side layout for one slot or every slot. The protocol has
   * no layout-clear frame (D5 contract 8), so controllers keep rendering their
   * last layout; this only drops the stored document, ack and pending state so
   * the next `set` is not treated as a duplicate.
   */
  clear(target: LayoutTarget): void {
    validateTarget(target);
    for (const slot of this.targetSlots(target)) {
      const index = slot - 1;
      this.layouts[index] = null;
      this.acked[index] = null;
      this.pending[index] = null;
      this.cleared += 1;
    }
    this.notifyWaiters();
  }

  /**
   * Resolves when every targeted occupied slot has acked the slot's current
   * layout (slots without a controller count as ready). Rejects with a
   * `LayoutAckTimeoutError` carrying per-slot statuses after `timeoutMs`.
   */
  waitForAcks(target: LayoutTarget, timeoutMs = 2000): Promise<readonly LayoutAckStatus[]> {
    validateTarget(target);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("waitForAcks timeoutMs must be a non-negative finite number.");
    }
    const slots = this.targetSlots(target);

    const snapshot = (): LayoutAckStatus[] =>
      slots.map((slot) => {
        const index = slot - 1;
        const layout = this.layouts[index] ?? null;
        if (layout === null) {
          return { slot, layoutId: null, state: "notSent" };
        }
        if (!this.occupied[index]) {
          return { slot, layoutId: layout.id, state: "noPlayer" };
        }
        if (this.acked[index] === layout.id) {
          return { slot, layoutId: layout.id, state: "acked" };
        }
        return { slot, layoutId: layout.id, state: "pending" };
      });

    const ready = (statuses: readonly LayoutAckStatus[]): boolean =>
      statuses.every((status) => status.state === "acked" || status.state === "noPlayer");

    const immediate = snapshot();
    if (ready(immediate)) {
      return Promise.resolve(immediate);
    }

    return new Promise<readonly LayoutAckStatus[]>((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.waiters.delete(check);
        this.clearTimerFn(timer);
        settle();
      };
      const check = (): void => {
        const statuses = snapshot();
        if (ready(statuses)) {
          finish(() => resolve(statuses));
        }
      };
      const timer = this.setTimerFn(() => {
        const statuses = snapshot().map((status): LayoutAckStatus =>
          status.state === "pending" || status.state === "notSent"
            ? { ...status, state: "timeout" }
            : status,
        );
        finish(() => reject(new LayoutAckTimeoutError(statuses)));
      }, timeoutMs);
      this.waiters.add(check);
      // A slot may have joined/acked between the snapshot and registration.
      check();
    });
  }

  /** Controller join: remember the slot and recover layouts set before it. */
  handleJoined(slot: number): void {
    if (!this.validSlot(slot)) {
      return;
    }
    const index = slot - 1;
    this.occupied[index] = true;
    const layout = this.layouts[index] ?? null;
    if (layout === null) {
      return;
    }
    this.acked[index] = null;
    this.sendSlot(slot, layout);
  }

  /** `playerResumed`: the plan requires an unconditional re-send. */
  handleResumed(slot: number): void {
    if (!this.validSlot(slot)) {
      return;
    }
    const index = slot - 1;
    this.occupied[index] = true;
    this.acked[index] = null;
    const layout = this.layouts[index] ?? null;
    if (layout !== null) {
      this.sendSlot(slot, layout, true);
    }
  }

  /** `playerLeft`: forget the slot's layout, ack and reservation. */
  handleLeft(slot: number): void {
    if (!this.validSlot(slot)) {
      return;
    }
    const index = slot - 1;
    this.occupied[index] = false;
    this.layouts[index] = null;
    this.acked[index] = null;
    this.pending[index] = null;
    this.cleared += 1;
    this.notifyWaiters();
  }

  /** Ack forwarded by the broker; `slot` is authenticated server-side. */
  handleAck(slot: number, layoutId: string): void {
    if (!this.validSlot(slot) || typeof layoutId !== "string") {
      this.staleAcks += 1;
      return;
    }
    const index = slot - 1;
    if (this.layouts[index]?.id !== layoutId) {
      this.staleAcks += 1;
      return;
    }
    if (this.acked[index] === layoutId) {
      this.staleAcks += 1;
      return;
    }
    this.acked[index] = layoutId;
    if (this.pending[index] === layoutId) {
      this.pending[index] = null;
    }
    this.acksReceived += 1;
    this.notifyWaiters();
  }

  /** Re-sends every occupied slot's current layout (host reconnect). */
  resendAll(): void {
    for (let slot = 1; slot <= this.slotCount; slot += 1) {
      if (!this.occupied[slot - 1]) {
        continue;
      }
      const layout = this.layouts[slot - 1] ?? null;
      if (layout !== null) {
        this.acked[slot - 1] = null;
        this.sendSlot(slot, layout, true);
      }
    }
  }

  /** Drops all layout/ack state (room lost or host teardown). */
  clearAll(): void {
    for (let index = 0; index < this.slotCount; index += 1) {
      this.layouts[index] = null;
      this.acked[index] = null;
      this.pending[index] = null;
      this.occupied[index] = false;
    }
    this.registry.clear();
    this.notifyWaiters();
  }

  /** Current layout for one slot, or null. */
  current(slot: number): LayoutDocument | null {
    return this.validSlot(slot) ? this.layouts[slot - 1] ?? null : null;
  }

  private validate(layout: LayoutDocument): LayoutDocument {
    const result = validateLayout(layout);
    if (!result.ok) {
      throw new LayoutValidationError(result.errors);
    }
    return result.layout;
  }

  private validSlot(slot: number): boolean {
    return Number.isInteger(slot) && slot >= 1 && slot <= this.slotCount;
  }

  private targetSlots(target: LayoutTarget): number[] {
    const slots: number[] = [];
    if (target === "all") {
      for (let slot = 1; slot <= this.slotCount; slot += 1) {
        slots.push(slot);
      }
    } else {
      slots.push(target);
    }
    return slots;
  }

  /** One `setLayout` for one slot; used for join/resume/reconnect recovery. */
  private sendSlot(slot: number, layout: LayoutDocument, force = false): void {
    const index = slot - 1;
    if (!force && this.pending[index] !== null) {
      return;
    }
    this.pending[index] = this.occupied[index] ? layout.id : null;
    try {
      this.sender.send({
        t: "setLayout",
        slot,
        layout: layout as unknown as JsonValue,
      });
    } catch (error) {
      this.sendFailures += 1;
      this.pending[index] = null;
      // Recovery runs from join/resume/reconnect handlers, so record the
      // failure instead of throwing into the event dispatch path.
      this.failSend("layout re-send", layout.id, slot, error);
      return;
    }
    this.lastSendErrorValue = null;
    this.swaps += 1;
    this.lastSentAtMs = this.clock();
  }

  /** Records and returns a sender failure for `set()` to throw. */
  private failSend(
    operation: string,
    layoutId: string,
    target: LayoutTarget,
    cause: unknown,
  ): Error {
    const where = target === "all" ? "all slots" : `slot ${target}`;
    const reason = cause instanceof Error ? cause.message : String(cause);
    const error = new Error(
      `${operation} could not send layout "${layoutId}" to ${where}: ${reason}.`,
    );
    this.lastSendErrorValue = error;
    return error;
  }

  private notifyWaiters(): void {
    for (const check of [...this.waiters]) {
      check();
    }
  }
}
