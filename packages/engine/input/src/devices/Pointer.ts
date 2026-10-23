/**
 * Pointer state (10 §5.5).
 *
 * Motion and wheel deltas accumulate until the next poll; position is in CSS
 * pixels and is frozen while pointer lock is active. Buttons produce pending
 * edges so a click shorter than a tick still registers. Leaving the target
 * does not release buttons; blur does, exactly once. Entering/leaving lock is
 * handled by `setLocked`: leaving releases buttons and clears motion.
 */

import type { PointerSnapshot } from "../contracts/input.js";

export class PointerState {
  x = 0;
  y = 0;
  dx = 0;
  dy = 0;
  wheel = 0;
  buttons = 0;
  pressPending = 0;
  releasePending = 0;
  inside = false;
  locked = false;

  /** Updates absolute position (ignored under lock) and accumulates motion. */
  move(dx: number, dy: number, x?: number, y?: number): void {
    if (Number.isFinite(dx)) this.dx += dx;
    if (Number.isFinite(dy)) this.dy += dy;
    if (!this.locked) {
      if (x !== undefined && Number.isFinite(x)) this.x = x;
      if (y !== undefined && Number.isFinite(y)) this.y = y;
    }
  }

  down(button: number): void {
    if (!Number.isInteger(button) || button < 0 || button > 2) return;
    const bit = 1 << button;
    if ((this.buttons & bit) !== 0) return;
    this.buttons |= bit;
    this.pressPending |= bit;
  }

  up(button: number): void {
    if (!Number.isInteger(button) || button < 0 || button > 2) return;
    const bit = 1 << button;
    if ((this.buttons & bit) === 0) return;
    this.buttons &= ~bit;
    this.releasePending |= bit;
  }

  wheelDelta(delta: number): void {
    if (Number.isFinite(delta)) this.wheel += delta;
  }

  /** Injection seam: derives edges from the previous mask. */
  setButtons(mask: number): void {
    const next = mask & 7;
    this.pressPending |= next & ~this.buttons;
    this.releasePending |= this.buttons & ~next;
    this.buttons = next;
  }

  setInside(inside: boolean): void {
    this.inside = inside;
  }

  /**
   * Pointer-lock transitions. Exiting releases every held button and drops
   * accumulated motion; absolute x/y stay where they were.
   */
  setLocked(locked: boolean): void {
    if (locked === this.locked) return;
    this.locked = locked;
    if (!locked) {
      const held = this.buttons & 7;
      if (held !== 0) this.releasePending |= held;
      this.buttons = 0;
      this.dx = 0;
      this.dy = 0;
      this.wheel = 0;
    }
  }

  /** Injects a contract snapshot; positions while locked are ignored. */
  applySnapshot(snapshot: PointerSnapshot): void {
    this.setLocked(snapshot.locked);
    if (!this.locked) {
      if (Number.isFinite(snapshot.x)) this.x = snapshot.x;
      if (Number.isFinite(snapshot.y)) this.y = snapshot.y;
    }
    if (Number.isFinite(snapshot.dx)) this.dx += snapshot.dx;
    if (Number.isFinite(snapshot.dy)) this.dy += snapshot.dy;
    if (Number.isFinite(snapshot.wheel)) this.wheel += snapshot.wheel;
    const next = snapshot.buttons & 7;
    this.pressPending |= (snapshot.edges | (next & ~this.buttons)) & 7;
    this.releasePending |= this.buttons & ~next;
    this.buttons = next;
    this.inside = snapshot.inside;
  }

  /** Blur/target loss: held buttons release once, motion is discarded. */
  blur(): void {
    const held = this.buttons & 7;
    if (held !== 0) this.releasePending |= held;
    this.buttons = 0;
    this.pressPending = 0;
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
  }

  /** Clears per-tick accumulators after the router has copied the frame. */
  clearAfterPoll(): void {
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this.pressPending = 0;
    this.releasePending = 0;
  }

  reset(): void {
    this.x = 0;
    this.y = 0;
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this.buttons = 0;
    this.pressPending = 0;
    this.releasePending = 0;
    this.inside = false;
    this.locked = false;
  }
}
