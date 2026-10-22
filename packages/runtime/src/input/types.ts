/**
 * Game-facing input types (D2-RT-01, frozen in `docs/todos/phase-1-dev/D2-controller-v0.md`).
 *
 * `ControllerState` is the only input shape game code ever sees (FR-7.17). It
 * carries no socket, packet, queue or decoder field, so a recorded trace can
 * drive a game without a network. D6 adds `gyroActive`/`gyroRecentered` and
 * the host-integrated `tilt` additively; existing fields must not be renamed.
 */
import type { InputState } from "@lanpad/protocol";
import type { TiltState } from "./TiltIntegrator.js";

export type { InputState };

/**
 * Latest mapped input for one slot.
 *
 * Units follow SPEC §7.5: axes are -1..1, triggers 0..1 and gyro is
 * degrees/second. `tick` is the packet's synced server-time estimate (A3),
 * not the host simulation tick; `InputSnapshot.tick` is the host tick.
 */
export interface ControllerState {
  /** Slot number, 1..8. */
  slot: number;
  /** u16 button level bitfield (FR-7.2). */
  buttons: number;
  /** u16 press edges accumulated since the last poll (FR-7.3, FR-7.12). */
  edges: number;
  /** Left stick X, -1..1 (FR-7.4). */
  lx: number;
  /** Left stick Y, -1..1 (FR-7.4). */
  ly: number;
  /** Right stick / touchpad X, -1..1 (FR-7.4, FR-7.7). */
  rx: number;
  /** Right stick / touchpad Y, -1..1 (FR-7.4, FR-7.7). */
  ry: number;
  /** Gyro in degrees/second (SPEC §7.5). */
  gyro: { x: number; y: number; z: number };
  /**
   * Motion data is active for this slot (D6-RT-01; FR-7.6). Derived from
   * `InputState.flags` bit 0; games use it to offer a fallback when a phone
   * has no usable motion sensor.
   */
  gyroActive: boolean;
  /**
   * The controller recentered its gyro in this packet (FR-7.6), flag bit 1.
   * Level field: it stays true only until the next packet without the flag.
   */
  gyroRecentered: boolean;
  /**
   * Host-integrated tilt for this slot (D6-RT-01; FR-7.5, FR-8.5). `InputMapper`
   * pools the object; `GameHost` updates its values before each `simulate`.
   * Optional so hand-built snapshots (traces, renderer fakes) that predate D6
   * still compile; every mapper-produced state carries it.
   */
  tilt?: TiltState;
  /** Triggers, 0..1 (FR-7.4). */
  triggers: { lt: number; rt: number };
  /** u32 server-time estimate stamped by the controller at send (A3). */
  tick: number;
}

/**
 * Input for every slot at one host simulation tick.
 *
 * Both the snapshot and the player objects are pooled: a game that keeps a
 * reference across ticks will see them mutate. Copy anything retained.
 */
export interface InputSnapshot {
  /** Host simulation tick count. */
  tick: number;
  /** Slots 1..N in fixed order (N is 8 unless configured lower). */
  players: ReadonlyArray<ControllerState>;
}

export interface InputMapperOptions {
  /** Extra radial deadzone applied to each stick pair at poll time, 0..1. Default 0. */
  deadzone?: number;
  /** Number of slots to expose, 1..8. Default 8. */
  slots?: number;
}

/** Per-slot diagnostics. `lastInputAgeMs` is -1 before the first packet. */
export interface SlotStats {
  lastInputAgeMs: number;
  packetsPerSecond: number;
  drops: number;
}
