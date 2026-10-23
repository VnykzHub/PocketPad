/**
 * Focus state (10 §5.7).
 *
 * Blur or a hidden document releases held keyboard/pointer input exactly
 * once. `lastBlurTick` records the most recent polled tick at which the page
 * was suspended, so the host can ignore a same-tick press that races the
 * blur. Gamepads are never released by focus changes.
 */

export class FocusState {
  focused = true;
  visible = true;
  pointerLocked = false;
  lastBlurTick = -1;
  private lastPolledTick = -1;

  notePoll(tick: number): void {
    this.lastPolledTick = tick;
  }

  get suspended(): boolean {
    return !this.focused || !this.visible;
  }

  setFocused(focused: boolean): boolean {
    if (focused === this.focused) return false;
    this.focused = focused;
    if (!focused) this.lastBlurTick = this.lastPolledTick;
    return true;
  }

  setVisible(visible: boolean): boolean {
    if (visible === this.visible) return false;
    this.visible = visible;
    if (!visible) this.lastBlurTick = this.lastPolledTick;
    return true;
  }

  setPointerLocked(locked: boolean): boolean {
    if (locked === this.pointerLocked) return false;
    this.pointerLocked = locked;
    return true;
  }

  /** Reads current document state without a DOM type in this module. */
  applyDocumentState(hidden: boolean, focused: boolean): boolean {
    let changed = false;
    if (this.setVisible(!hidden)) changed = true;
    if (this.setFocused(focused)) changed = true;
    return changed;
  }

  reset(): void {
    this.focused = true;
    this.visible = true;
    this.pointerLocked = false;
    this.lastBlurTick = -1;
    this.lastPolledTick = -1;
  }
}
