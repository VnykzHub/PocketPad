/**
 * Keyboard state (10 §5.4).
 *
 * Physical `KeyboardEvent.code` strings are registered once into a 256-id
 * table; per tick the router reads 256-entry byte arrays. Keydown sets
 * `down` and a pending press, keyup clears `down` and sets a pending release,
 * so a tap that begins and ends between polls still produces both edges.
 * Auto-repeat is ignored by the caller (`repeat === true`).
 */

import { INPUT_KEY_ID_LIMIT } from "../version.js";

export class KeyboardState {
  private readonly ids = new Map<string, number>();
  private readonly codes: string[] = [];
  private readonly down = new Uint8Array(INPUT_KEY_ID_LIMIT);
  private readonly pressPending = new Uint8Array(INPUT_KEY_ID_LIMIT);
  private readonly releasePending = new Uint8Array(INPUT_KEY_ID_LIMIT);

  /** Codes beyond the 256-id cap; counted for debug, never bound. */
  unknownCodes = 0;

  /** Returns the stable id for `code`, registering it when there is room. */
  register(code: string): number {
    const existing = this.ids.get(code);
    if (existing !== undefined) return existing;
    if (this.codes.length >= INPUT_KEY_ID_LIMIT) {
      this.unknownCodes += 1;
      return -1;
    }
    const id = this.codes.length;
    this.codes.push(code);
    this.ids.set(code, id);
    return id;
  }

  idOf(code: string): number {
    const id = this.ids.get(code);
    return id === undefined ? -1 : id;
  }

  isDown(id: number): boolean {
    return id >= 0 && id < INPUT_KEY_ID_LIMIT && this.down[id] === 1;
  }

  isPressPending(id: number): boolean {
    return id >= 0 && id < INPUT_KEY_ID_LIMIT && this.pressPending[id] === 1;
  }

  isReleasePending(id: number): boolean {
    return id >= 0 && id < INPUT_KEY_ID_LIMIT && this.releasePending[id] === 1;
  }

  /** Returns false for a repeated keydown or when the id table is full. */
  keyDown(code: string, repeat = false): boolean {
    if (repeat) return false;
    const id = this.register(code);
    if (id < 0) return false;
    this.down[id] = 1;
    this.pressPending[id] = 1;
    return true;
  }

  /** Returns false when the key was not held (a stray or captured keyup). */
  keyUp(code: string): boolean {
    const id = this.idOf(code);
    if (id < 0) return false;
    if (this.down[id] !== 1) return false;
    this.down[id] = 0;
    this.releasePending[id] = 1;
    return true;
  }

  /** Test/injection seam; mirrors a keydown or keyup pair. */
  setKey(code: string, isDown: boolean): void {
    if (isDown) this.keyDown(code, false);
    else this.keyUp(code);
  }

  /**
   * Blur/detach: held keys release exactly once; pending presses are
   * discarded. A tapped key that already released keeps that release edge.
   */
  releaseAll(): void {
    for (let id = 0; id < INPUT_KEY_ID_LIMIT; id += 1) {
      if (this.down[id] === 1) {
        this.down[id] = 0;
        this.releasePending[id] = 1;
      }
    }
    this.pressPending.fill(0);
  }

  /** Drops pending edges, e.g. when a target is re-attached. */
  clearPending(): void {
    this.pressPending.fill(0);
    this.releasePending.fill(0);
  }

  reset(): void {
    this.down.fill(0);
    this.pressPending.fill(0);
    this.releasePending.fill(0);
  }
}
