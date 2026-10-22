/**
 * Controller state -> pooled player command (GAME-PF-03; FR-7.2/7.3/7.4/7.12).
 *
 * One call per connected slot per fixed tick. The mapper has already applied
 * latest-wins level state and OR-accumulated press edges (D2-RT-01), so this
 * function only translates:
 *
 * - left/right: d-pad bits 10/11 win; otherwise the left stick with a ±0.25
 *   threshold (the controller's own deadzone is applied earlier);
 * - jump: bit 0 of `edges` only. Holding the button produces no edge, so it
 *   cannot repeat a jump (FR-7.12).
 *
 * It writes into a caller-owned `PlayerCommand`. Nothing here allocates, and
 * the structural input type accepts both the runtime `ControllerState` and the
 * SDK `GameControllerState` without importing either layer.
 */

/** Per-slot command written once per fixed tick (pooled). */
export interface PlayerCommand {
  moveX: -1 | 0 | 1;
  jumpPressed: boolean;
}

/** The only input fields the platformer reads (FR-7.17). */
export interface CommandInputState {
  /** u16 button level bitfield (FR-7.2). */
  readonly buttons: number;
  /** u16 press edges accumulated since the last poll (FR-7.3). */
  readonly edges: number;
  /** Left stick X, -1..1 (FR-7.4). */
  readonly lx: number;
}

/** D-pad bit numbers from the shared layout contract (FR-7.2). */
export const DLEFT_BIT = 10;
export const DRIGHT_BIT = 11;
/** Jump button bit number (FR-7.2, FR-8.10). */
export const JUMP_BIT = 0;
/** Stick fallback threshold; at ±0.25 the direction is taken (FR-7.4). */
export const STICK_THRESHOLD = 0.25;

/** Creates the one pooled command object a `PlayerState` keeps. */
export function createPlayerCommand(): PlayerCommand {
  return { moveX: 0, jumpPressed: false };
}

/**
 * Writes the command for one slot into `out`.
 *
 * Priority: either d-pad direction suppresses the stick entirely; pressing
 * both directions is neutral, not a last-writer-wins guess. Jump is an edge,
 * never a level.
 */
export function readCommand(state: CommandInputState, out: PlayerCommand): void {
  const buttons = state.buttons;
  const left = (buttons & (1 << DLEFT_BIT)) !== 0;
  const right = (buttons & (1 << DRIGHT_BIT)) !== 0;

  let moveX: -1 | 0 | 1 = 0;
  if (left && !right) {
    moveX = -1;
  } else if (right && !left) {
    moveX = 1;
  } else if (!left && !right) {
    if (state.lx <= -STICK_THRESHOLD) {
      moveX = -1;
    } else if (state.lx >= STICK_THRESHOLD) {
      moveX = 1;
    }
  }

  out.moveX = moveX;
  out.jumpPressed = (state.edges & (1 << JUMP_BIT)) !== 0;
}
