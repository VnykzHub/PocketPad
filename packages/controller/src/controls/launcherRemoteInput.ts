/**
 * Launcher remote input adapter (spec 25 §2.7).
 *
 * While `launcher-remote-v1` is the active layout, its Select/Back/d-pad
 * renderers still use the shared input path for pressed visuals, but their
 * bits must not become game input. This store consumes the same bit edges and
 * emits the host's `remote` event on each press edge; releases are ignored.
 *
 * The layout view passes it as `ControlContext.input` only for the launcher
 * layout, so the real `InputStore` never sees these bits and no duplicate
 * binary input can reach a running game. Unmapped bits are ignored.
 */
import { InputStore } from "../input/InputStore.js";
import {
  launcherRemoteButtonForBit,
  type LauncherRemoteButton,
} from "../layout/launcherRemote.js";

export type LauncherRemoteEmitter = (button: LauncherRemoteButton) => void;

export class LauncherRemoteInput extends InputStore {
  private readonly emit: LauncherRemoteEmitter;
  private pressed = 0;

  constructor(emit: LauncherRemoteEmitter) {
    super();
    this.emit = emit;
  }

  /** Emits once per press edge; releases only clear the local level. */
  override setButton(bit: number, down: boolean): void {
    const button = launcherRemoteButtonForBit(bit);
    if (button === null) {
      return;
    }
    const mask = 1 << bit;
    if (down) {
      if ((this.pressed & mask) !== 0) {
        return;
      }
      this.pressed |= mask;
      this.emit(button);
      return;
    }
    this.pressed &= ~mask;
  }

  /** Drops held state without emitting; used when the layout rebuilds. */
  reset(): void {
    this.pressed = 0;
  }
}
