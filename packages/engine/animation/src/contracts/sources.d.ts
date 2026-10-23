/**
 * Decoded animation/skeleton source data (spec 08 §4.3).
 *
 * `engine-assets` (spec 06) produces these structures from glTF, `.pclip` or
 * tooling output; animation owns the compile step and validates every field.
 * The shapes are declared here because `@lanpad/engine-assets` does not yet
 * export animation decode types; they are structural copies of 08 §4.3 and
 * will be replaced by an import when spec 06 lands, without changing callers.
 *
 * Two additive fields are required by the runtime and absent from §4.3:
 *
 * - `AnimationSource.loop` — `AnimationClip.loop` is required (§3.3) but the
 *   source shape carries no loop. Default `"repeat"`, the documented metadata
 *   default (§4.5).
 */

import type { ClipEvent, ClipLoopMode, TrackInterpolation, TrackPath } from "./animation.js";

export interface SkeletonSource {
  readonly id?: string;
  readonly jointNames: readonly string[];
  /** Length jointCount, topological (parents[i] < i), at least one -1 root. */
  readonly parents: Int16Array;
  readonly inverseBindMatrices: Float32Array; // 16 * jointCount, column-major
  readonly restTranslations: Float32Array; // 3 * jointCount
  readonly restRotations: Float32Array; // 4 * jointCount
  readonly restScales: Float32Array; // 3 * jointCount
  readonly rootJoint: number; // -1 if undeclared
}

export interface AnimationSourceTrack {
  readonly target: number; // joint or morph-target index
  readonly path: TrackPath;
  readonly interpolation: TrackInterpolation;
  readonly times: Float32Array; // seconds, ascending
  readonly values: Float32Array; // 3/4/3/1 per key
}

export interface AnimationSource {
  readonly name: string;
  /** The skeleton this source's indices were built for; checked when both ids exist. */
  readonly skeletonId?: string;
  readonly duration: number;
  readonly tracks: readonly AnimationSourceTrack[];
  readonly events?: readonly ClipEvent[];
  readonly rootJoint?: number; // -1 = no root motion
  /** Additive: playback default; `"repeat"` when absent (§4.5). */
  readonly loop?: ClipLoopMode;
}
