/**
 * Public animation contract (spec 08 §3). Types only; the implementation
 * modules import these and the package entry re-exports them.
 *
 * Frozen after the M1 release: additive optional fields only. All math types
 * are `engine-core` types (02); animation never imports a renderer, the DOM,
 * protocol, SDK, runtime or a game.
 */

import type { Entity, Quat, Scene, Vec3 } from "@lanpad/engine-core";

/** §3.2. A compiled skeleton. Immutable after compile; shared by every instance. */
export interface Skeleton {
  readonly jointCount: number;
  /** Stable asset identity; used only to reject a clip compiled against another skeleton. */
  readonly id?: string;
  /** Parent joint index; a root is -1; parents[i] < i for every non-root joint. */
  readonly parents: Int16Array;
  /** 16 floats per joint, column-major, model space; the skin's inverse bind matrices. */
  readonly inverseBindMatrices: Float32Array;
  /** Local bind-pose TRS, copied into every new instance's pose buffers. */
  readonly restPose: PoseBuffer;
  /** Default root joint for root motion; the first root unless the skeleton declares another. */
  readonly rootJoint: number;
  /** Debug/authoring names, index-aligned with joints; never used for lookup in a hot path. */
  readonly jointNames: readonly string[];
}

/** §3.2. Local-space TRS pose, structure-of-arrays, caller- or instance-owned. */
export interface PoseBuffer {
  readonly jointCount: number;
  readonly translations: Float32Array; // 3 floats per joint
  readonly rotations: Float32Array; // 4 floats per joint, (x, y, z, w)
  readonly scales: Float32Array; // 3 floats per joint
}

/** §3.2. Model-space skinning palette: jointWorldModel * inverseBind. */
export interface JointPalette {
  readonly jointCount: number;
  readonly matrices: Float32Array; // 16 floats per joint, column-major
}

/** §3.3. */
export type TrackPath = "translation" | "rotation" | "scale" | "weights";
export type TrackInterpolation = "linear" | "step";
export type ClipLoopMode = "repeat" | "once" | "ping-pong";

export interface AnimationTrack {
  /** Joint index for TRS paths; morph-target index for "weights". */
  readonly target: number;
  readonly path: TrackPath;
  readonly interpolation: TrackInterpolation;
  /** Seconds, strictly ascending, length === keyCount. */
  readonly times: Float32Array;
  /** 3/4/3/1 floats per key. Immutable and shared; never mutated after compile. */
  readonly values: Float32Array;
  readonly keyCount: number;
  readonly valueStride: 3 | 4 | 1;
}

export interface ClipEvent {
  /** Seconds from clip start, in [0, duration]. */
  readonly time: number;
  readonly name: string;
  /** Signed 32-bit gameplay payload; 0 when unused. */
  readonly payload: number;
}

export interface AnimationClip {
  readonly name: string;
  readonly duration: number; // seconds, > 0
  readonly loop: ClipLoopMode; // default for playback
  readonly tracks: readonly AnimationTrack[];
  readonly events: readonly ClipEvent[];
  /** Joint index used for root motion; -1 disables root motion. */
  readonly rootJoint: number;
  /** Retained CPU bytes for stats and budgets. */
  readonly sourceBytes: number;
}

/** §3.4. */
export interface BlendSample1D {
  readonly threshold: number;
  readonly clip: AnimationClip;
  readonly speed?: number; // > 0, default 1
}

export interface BlendTree1D {
  readonly kind: "1d";
  /** 2..16 samples, sorted by ascending threshold with no duplicates. */
  readonly samples: readonly BlendSample1D[];
  /** Match normalized clip phase across samples. Default true. */
  readonly syncPhase?: boolean;
}

export interface BlendSample2D {
  readonly x: number;
  readonly y: number;
  readonly clip: AnimationClip;
  readonly speed?: number;
}

/** M2. Freeform Cartesian blend, top-four inverse-distance weights. Declared only. */
export interface BlendTree2D {
  readonly kind: "2d";
  /** 2..16 samples. */
  readonly samples: readonly BlendSample2D[];
  readonly syncPhase?: boolean;
}

export interface BoneMask {
  /** ceil(jointCount / 32) u32 words. Bit i set means joint i is affected. */
  readonly joints: Uint32Array;
}

export interface LayerDesc {
  readonly name: string; // 1..32 characters
  readonly mode: "base" | "override" | "additive";
  /** Default: every joint. Only meaningful for override/additive. */
  readonly mask?: BoneMask;
  /** 0..1, default 1. */
  readonly weight?: number;
}

/** §3.5. */
export type Playable = AnimationClip | BlendTree1D | BlendTree2D;

export interface PlayOptions {
  readonly loop?: ClipLoopMode;
  readonly speed?: number;
  readonly weight?: number;
  readonly fadeInSeconds?: number;
  readonly fadeOutPreviousSeconds?: number;
  readonly restart?: boolean;
  readonly parameter?: number;
  readonly parameterX?: number;
  readonly parameterY?: number;
  readonly layer?: number;
}

export interface AnimationAction {
  readonly source: Playable;
  readonly layer: number;
  /** Seconds into the source; for a tree, the group phase scaled to each sample. */
  time: number;
  /** [0, 1); live value derived from time. */
  readonly normalizedTime: number;
  weight: number;
  speed: number;
  readonly running: boolean;
  stop(fadeOutSeconds?: number): void;
  /** 1D tree parameter; no-op for clips and 2D trees. */
  setParameter(value: number): void;
  /** 2D tree parameter; no-op for clips and 1D trees. */
  setParameter2D(x: number, y: number): void;
}

export interface AnimationInstanceOptions {
  readonly layers?: readonly LayerDesc[];
  readonly rootMotion?: RootMotionOptions;
  readonly morphTargets?: number;
}

export interface AnimationStats {
  readonly instanceCount: number;
  readonly jointCount: number;
  readonly activeActionCount: number;
  readonly sampledTrackCount: number;
  readonly eventsEmitted: number;
  readonly eventsDropped: number;
  readonly updateMs: number;
  readonly paletteMs: number;
  readonly clipBytes: number;
  readonly poseBytes: number;
}

export interface AnimationInstance {
  readonly id: number;
  readonly entity: Entity;
  readonly skeleton: Skeleton;
  readonly previousPose: PoseBuffer;
  readonly currentPose: PoseBuffer;
  readonly morphWeights: Float32Array;

  play(source: Playable, options?: PlayOptions): AnimationAction;
  getAction(layer: number): AnimationAction | null;
  stop(layer?: number, fadeOutSeconds?: number): void;
  setLayerWeight(layer: number, weight: number): void;

  setRootMotionMode(mode: RootMotionMode, options?: RootMotionOptions): void;
  /** Returns the accumulated delta and clears it; false when no valid delta. */
  consumeRootMotion(out: RootMotionDelta): boolean;

  setMorphWeight(target: number, weight: number): void;
  /** Copies the pose to `out` without interpolation (debug/tests). */
  readPose(out: PoseBuffer, which: "previous" | "current"): void;
  /** Interpolates previous→current by alpha and writes model-space skinning matrices. */
  computePalette(out: JointPalette, alpha: number): void;
}

export interface AnimationApiOptions {
  /** The loop's fixed step; default 1/60. */
  readonly fixedStep?: number;
  /** Default 1,024. */
  readonly maxInstances?: number;
  /** Default 512. */
  readonly eventCapacity?: number;
  readonly debug?: boolean;
  /**
   * Additive extension of §3.5. `apply` root motion (§3.6) must write the
   * entity's `Transform`, but the frozen §3.5 options carry no scene handle.
   * When supplied, `createInstance` validates liveness and the implicit
   * `Transform`, and `apply` writes through it. Without a scene, `apply`
   * degrades to `extract` (counted) because there is nothing to write.
   */
  readonly scene?: Scene;
}

export interface AnimationApi {
  createInstance(
    entity: Entity,
    skeleton: Skeleton,
    options?: AnimationInstanceOptions,
  ): AnimationInstance;
  destroyInstance(instance: AnimationInstance): void;
  getInstance(entity: Entity): AnimationInstance | null;

  /** Advances every instance exactly once, in ascending slot index. */
  update(dt: number): void;

  /** Moves queued events into caller slots; returns the count copied. */
  drainEvents(out: AnimationEvent[]): number;

  /** FNV-1a 32 over the canonical pose/action stream in §4.6; test/replay probe. */
  stateHash(): number;

  readonly stats: AnimationStats;
  dispose(): void;
}

/** §3.5. The drained event form. */
export interface AnimationEvent {
  readonly entity: Entity;
  readonly clip: AnimationClip;
  readonly name: string;
  readonly payload: number;
  /** Clip-local time of the event, seconds. */
  readonly time: number;
}

/** §3.6. */
export type RootMotionMode = "none" | "extract" | "apply";

export interface RootMotionOptions {
  readonly rootJoint?: number;
  readonly applyVertical?: boolean;
  readonly applyYaw?: boolean;
  readonly maxDeltaPerTick?: number;
}

export interface RootMotionDelta {
  translation: Vec3;
  rotation: Quat;
  speed: number;
  valid: boolean;
}

/** §3.7. Additive fields this spec requires from the renderer's M1 skinned draw path. */
export interface SkinnedDraw {
  readonly entity: Entity;
  readonly palette: JointPalette;
  readonly morphWeights?: Float32Array;
}
