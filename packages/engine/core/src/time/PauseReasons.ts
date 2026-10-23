/**
 * Pause ownership (spec 01 §3.2 and §5.3).
 *
 * One `PauseReason` owns one bit of a 32-bit mask. The loop is paused while at
 * least one reason has a non-zero reference count, so a menu can close while
 * the tab is still hidden without resuming simulation. Holding the same reason
 * twice requires two releases; release tokens are idempotent.
 *
 * This module has no DOM dependency: the host shell decides when
 * `visibilitychange` maps to a `visibility` hold.
 */
import type { PauseReason } from "../contracts/time.js";

/** Stable reason order; bit `n` belongs to `PAUSE_REASON_ORDER[n]`. */
export const PAUSE_REASON_ORDER: readonly PauseReason[] = [
  "visibility",
  "hostPause",
  "menu",
  "network",
  "contextLoss",
  "manual",
];

/** One bit per reason, exported for overlays and host adapters. */
export const PAUSE_REASON_BITS: Readonly<Record<PauseReason, number>> = {
  visibility: 1 << 0,
  hostPause: 1 << 1,
  menu: 1 << 2,
  network: 1 << 3,
  contextLoss: 1 << 4,
  manual: 1 << 5,
};

export const PAUSE_REASON_COUNT = PAUSE_REASON_ORDER.length;

const PAUSE_REASON_INDEX: Readonly<Record<PauseReason, number>> = {
  visibility: 0,
  hostPause: 1,
  menu: 2,
  network: 3,
  contextLoss: 4,
  manual: 5,
};

/** Reference-counted pause reasons. Allocated once per loop. */
export class PauseReasons {
  private readonly counts: number[] = new Array<number>(PAUSE_REASON_COUNT).fill(0);
  private maskValue = 0;

  /** Current bitmask: set iff at least one hold for that reason is active. */
  get mask(): number {
    return this.maskValue;
  }

  get paused(): boolean {
    return this.maskValue !== 0;
  }

  /** Number of active holds for one reason. */
  count(reason: PauseReason): number {
    return this.counts[PAUSE_REASON_INDEX[reason]] ?? 0;
  }

  /**
   * Holds one reason and returns an idempotent release token. Calling the
   * token twice releases once; holding twice requires two separate tokens.
   */
  hold(reason: PauseReason): () => void {
    const index = PAUSE_REASON_INDEX[reason];
    if (index === undefined) {
      throw new RangeError(`unknown pause reason: ${String(reason)}`);
    }
    const bit = 1 << index;
    this.counts[index] = (this.counts[index] ?? 0) + 1;
    this.maskValue |= bit;

    let released = false;
    return (): void => {
      if (released) {
        return;
      }
      released = true;
      this.releaseIndex(index, bit);
    };
  }

  /** Clears every hold without firing callbacks (loop disposal only). */
  clear(): void {
    for (let index = 0; index < this.counts.length; index += 1) {
      this.counts[index] = 0;
    }
    this.maskValue = 0;
  }

  private releaseIndex(index: number, bit: number): void {
    const current = this.counts[index] ?? 0;
    if (current <= 0) {
      return;
    }
    const next = current - 1;
    this.counts[index] = next;
    if (next === 0) {
      this.maskValue &= ~bit;
    }
  }
}
