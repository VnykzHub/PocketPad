/**
 * `@lanpad/engine-animation` public entry (spec 08).
 *
 * Types come from the frozen contracts; values are the compile, sampling,
 * blending, palette, root-motion, event and API implementations.
 */

export type * from "./contracts/animation.js";
export type * from "./contracts/sources.js";

export * from "./version.js";

export type { AnimationCounters } from "./errors.js";
export { AnimationEngineError, animationError, createCounters } from "./errors.js";

export { compileSkeleton } from "./skeleton/compileSkeleton.js";
export { compileClip } from "./clip/compileClip.js";
export { findKeyIndex, sampleTrackInto, sampleWeightInto } from "./clip/track.js";

export {
  createPoseBuffer,
  createJointPalette,
  copyPose,
  resetPoseJoint,
} from "./sample/PoseBuffer.js";
export { sampleClipInto } from "./sample/sampleClip.js";
export {
  lerpInto,
  copyInto,
  nlerpInto,
  normalizeQuatAt,
  canonicalizeQuatAt,
} from "./sample/interpolate.js";

export {
  validateBlendTree1D,
  evaluateBlend1D,
  dominantSampleIndex,
  sampleWeightSum,
} from "./blend/blend1d.js";

export {
  maskWordCount,
  validateMask,
  copyMask,
  fullMask,
  maskHas,
  applyOverrideLayer,
  applyAdditiveLayer,
  createAdditiveScratch,
  clampUnit,
  clampLayerWeight,
} from "./layer/layers.js";
export type { AdditiveScratch } from "./layer/layers.js";

export {
  computePalette,
  createPaletteScratch,
  readPoseInto,
} from "./palette/palette.js";
export type { PaletteScratch } from "./palette/palette.js";

export { EventQueue } from "./events/eventQueue.js";
export type { QueuedEvent } from "./events/eventQueue.js";

export { StateHasher, fnv1aString } from "./hash/hash.js";

export {
  resolveRootOptions,
  sampleRootModelTransform,
  createRootMotionState,
  resetRootMotion,
  computeRootDelta,
  consumeRootMotion,
  applyRootDelta,
  createRootScratch,
  createRootPoseScratch,
  removeRootFromPose,
} from "./rootmotion/rootMotion.js";
export type {
  ResolvedRootOptions,
  RootMotionState,
  RootScratch,
  RootPoseScratch,
} from "./rootmotion/rootMotion.js";

export {
  AnimationInstanceImpl,
  AnimationActionHandle,
} from "./api/AnimationInstance.js";
export type {
  AnimationInstanceHost,
  LayerState,
} from "./api/AnimationInstance.js";
export { AnimationApiImpl, createAnimationApi } from "./api/AnimationApi.js";
