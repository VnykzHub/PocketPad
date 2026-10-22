/**
 * Cube demo game (D3-RT-02).
 *
 * Proves the whole pipeline: fixed-tick `simulate` reads the mapped
 * `InputSnapshot`, and variable-rate `render(alpha)` interpolates between the
 * last two simulation states before drawing through `Renderer3D` only. It
 * never imports a concrete renderer, a socket or an input decoder (FR-7.17),
 * so it runs unchanged on WebGL2 and on the Canvas2D fallback.
 *
 * Controls: the left stick rotates the cube (X) and lifts the camera (Y); the
 * A button pulses the cube and cycles its colour. Input edges are the mapper's
 * once-per-tick press edges, so one press produces one pulse.
 *
 * D3-SDK-01 will wrap this module in a `games/cube-demo/` manifest and a
 * default factory; keeping the class module-level and renderer-injected is
 * what makes that path a thin adapter rather than a rewrite.
 */
import { BUTTON_BITS } from "@lanpad/protocol";
import type { InputSnapshot } from "../input/types.js";
// The SDK's game-facing renderer: the runtime `Renderer3D` satisfies it, and
// the demo needs nothing beyond what any third-party game receives.
import type { GameRenderer3D as Renderer3D } from "@lanpad/sdk";

const A_BUTTON_MASK = 1 << BUTTON_BITS.A;
/** Radians per second at full left-stick X. */
export const CUBE_DEMO_TURN_RATE = 2.4;
/** Camera-height units per full left-stick Y. */
export const CUBE_DEMO_LIFT_RANGE = 1.5;
/** Pulse decay per second after an A press. */
export const CUBE_DEMO_PULSE_DECAY = 2.5;
/** Smoothing rate for the camera lift, per second. */
const LIFT_SMOOTHING = 6;
const BASE_CAMERA_HEIGHT = 1.2;
const CAMERA_DISTANCE = 3.2;
const BASE_SIZE = 1;
const PULSE_SIZE = 0.35;

/** Stable palette; the identity of these strings never changes per frame. */
export const CUBE_DEMO_COLORS: readonly string[] = [
  "#6ee7ff",
  "#ffd166",
  "#ff6b9d",
  "#8bffa0",
  "#c4a7ff",
];
const DEFAULT_COLOR = "#6ee7ff";

export interface CubeDemoOptions {
  /** Host slot driving the cube, 1..8. Default 1. */
  readonly slot?: number;
}

/**
 * Minimal `Game`-shaped demo: `init`, `simulate`, `render`, `dispose`. The
 * D3-SDK-01 `Game` interface is additive over this shape; no socket and no
 * DOM access lives here.
 */
export class CubeDemo {
  readonly renderer: Renderer3D;
  readonly slot: number;

  private previousYaw = 0;
  private yawValue = 0;
  private previousLift = 0;
  private liftValue = 0;
  private previousPulse = 0;
  private pulseValue = 0;
  private colorIndexValue = 0;

  /** Reused every frame; never reallocated (PR-9.3). */
  private readonly origin = { x: 0, y: 0, z: 0 };
  private readonly cameraPosition = { x: 0, y: BASE_CAMERA_HEIGHT, z: CAMERA_DISTANCE };
  private readonly cameraTarget = { x: 0, y: 0, z: 0 };

  constructor(renderer: Renderer3D, options: CubeDemoOptions = {}) {
    const slot = options.slot ?? 1;
    if (!Number.isInteger(slot) || slot < 1 || slot > 8) {
      throw new RangeError("CubeDemo slot must be an integer in 1..8.");
    }
    this.renderer = renderer;
    this.slot = slot;
  }

  /** Current simulated yaw in radians (exposed for tests and the overlay). */
  get yaw(): number {
    return this.yawValue;
  }

  /** Current pulse amplitude, 0..1. */
  get pulse(): number {
    return this.pulseValue;
  }

  /** Current camera lift, -1..1. */
  get lift(): number {
    return this.liftValue;
  }

  get colorIndex(): number {
    return this.colorIndexValue;
  }

  /** Called once by the host before the loop starts. */
  init(): void {
    this.renderer.setCamera(this.cameraPosition, this.cameraTarget);
  }

  /** One fixed 1/60 s step; must not allocate (PR-9.3). */
  simulate(dt: number, snapshot: InputSnapshot): void {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

    this.previousYaw = this.yawValue;
    this.previousLift = this.liftValue;
    this.previousPulse = this.pulseValue;

    const player = snapshot.players[this.slot - 1];
    if (player !== undefined) {
      this.yawValue += player.lx * CUBE_DEMO_TURN_RATE * step;

      const targetLift = clamp(player.ly, -1, 1);
      this.liftValue +=
        (targetLift - this.liftValue) * Math.min(1, step * LIFT_SMOOTHING);

      if ((player.edges & A_BUTTON_MASK) !== 0) {
        this.pulseValue = 1;
        this.colorIndexValue =
          (this.colorIndexValue + 1) % CUBE_DEMO_COLORS.length;
      }
    }

    this.pulseValue = Math.max(0, this.pulseValue - CUBE_DEMO_PULSE_DECAY * step);
  }

  /**
   * Draws one frame. `alpha` interpolates the yaw, lift and pulse between the
   * previous and current simulation states (FR-9.1); every object passed to
   * the renderer is preallocated, so the loop allocates nothing.
   */
  render(alpha: number): void {
    const blend = Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 0;
    const yaw = this.previousYaw + (this.yawValue - this.previousYaw) * blend;
    const lift = this.previousLift + (this.liftValue - this.previousLift) * blend;
    const pulse =
      this.previousPulse + (this.pulseValue - this.previousPulse) * blend;

    this.cameraPosition.y = BASE_CAMERA_HEIGHT + lift * CUBE_DEMO_LIFT_RANGE;
    this.renderer.setCamera(this.cameraPosition, this.cameraTarget);

    this.renderer.beginFrame(blend);
    this.renderer.drawCube(
      this.origin,
      BASE_SIZE + pulse * PULSE_SIZE,
      CUBE_DEMO_COLORS[this.colorIndexValue] ?? DEFAULT_COLOR,
      yaw,
    );
    this.renderer.endFrame();
  }

  dispose(): void {
    // No timers, listeners or GPU resources owned by the demo.
  }
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/** Factory shape D3-SDK-01's `GameModule` default export can return. */
export function createCubeDemo(
  renderer: Renderer3D,
  options: CubeDemoOptions = {},
): CubeDemo {
  return new CubeDemo(renderer, options);
}
