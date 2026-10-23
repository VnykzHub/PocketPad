/**
 * Root-motion extraction, accumulation and application (spec 08 §3.6, §5.7).
 *
 * Model-space root transform is sampled from the layer-composed base pose.
 * The per-tick delta is `currentRoot * inverse(previousRoot)`, filtered to
 * horizontal translation and yaw by default. All scratch is caller-owned.
 */

import type { Mat4, Quat, Vec3 } from "@lanpad/engine-core";
import {
  mat4Compose,
  mat4Copy,
  mat4GetTranslation,
  mat4Identity,
  mat4Invert,
  mat4Multiply,
  quatFromAxisAngle,
  quatFromMat4,
  quatIdentity,
  quatInvert,
  quatMultiply,
  quatRotateVec3,
} from "@lanpad/engine-core";
import type {
  PoseBuffer,
  RootMotionDelta,
  RootMotionMode,
  RootMotionOptions,
  Skeleton,
} from "../contracts/animation.js";
import {
  ANIMATION_DEFAULT_MAX_DELTA_PER_TICK,
  ANIMATION_MAX_JOINTS,
} from "../version.js";

const UP: Vec3 = { x: 0, y: 1, z: 0 };

export interface ResolvedRootOptions {
  readonly rootJoint: number;
  readonly applyVertical: boolean;
  readonly applyYaw: boolean;
  readonly maxDeltaPerTick: number;
}

/**
 * §3.6. `rootJoint` resolves to the explicit option, else the skeleton root.
 * Callers fall back to the dominant clip's root before calling this.
 */
export function resolveRootOptions(
  skeletonRootJoint: number,
  options: RootMotionOptions | undefined,
): ResolvedRootOptions {
  const override = options?.rootJoint ?? -1;
  const rootJoint = override >= 0 ? override : skeletonRootJoint;
  const candidate = options?.maxDeltaPerTick ?? ANIMATION_DEFAULT_MAX_DELTA_PER_TICK;
  const maxDeltaPerTick =
    Number.isFinite(candidate) && candidate > 0
      ? candidate
      : ANIMATION_DEFAULT_MAX_DELTA_PER_TICK;
  return {
    rootJoint,
    applyVertical: options?.applyVertical ?? false,
    applyYaw: options?.applyYaw ?? true,
    maxDeltaPerTick,
  };
}

export interface RootScratch {
  readonly chain: Int32Array;
  readonly local: Mat4;
  readonly world: Mat4;
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

export function createRootScratch(): RootScratch {
  return {
    chain: new Int32Array(ANIMATION_MAX_JOINTS),
    local: { m: new Float32Array(16) },
    world: { m: new Float32Array(16) },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

/**
 * §5.7. Model-space transform of `rootJoint`: compose the local TRS chain from
 * the skeleton root down. Returns false for an invalid joint or a broken
 * parent chain (compile validation makes the latter unreachable).
 */
export function sampleRootModelTransform(
  skeleton: Skeleton,
  pose: PoseBuffer,
  rootJoint: number,
  out: Mat4,
  scratch: RootScratch,
): boolean {
  if (rootJoint < 0 || rootJoint >= skeleton.jointCount) return false;
  const chain = scratch.chain;
  let depth = 0;
  let joint = rootJoint;
  while (joint >= 0) {
    if (depth >= chain.length) return false;
    chain[depth] = joint;
    depth += 1;
    joint = skeleton.parents[joint]!;
  }
  mat4Identity(scratch.world);
  for (let i = depth - 1; i >= 0; i -= 1) {
    const index = chain[i]!;
    scratch.position.x = pose.translations[index * 3]!;
    scratch.position.y = pose.translations[index * 3 + 1]!;
    scratch.position.z = pose.translations[index * 3 + 2]!;
    scratch.rotation.x = pose.rotations[index * 4]!;
    scratch.rotation.y = pose.rotations[index * 4 + 1]!;
    scratch.rotation.z = pose.rotations[index * 4 + 2]!;
    scratch.rotation.w = pose.rotations[index * 4 + 3]!;
    scratch.scale.x = pose.scales[index * 3]!;
    scratch.scale.y = pose.scales[index * 3 + 1]!;
    scratch.scale.z = pose.scales[index * 3 + 2]!;
    mat4Compose(scratch.local, scratch.position, scratch.rotation, scratch.scale);
    if (i === depth - 1) {
      mat4Copy(scratch.world, scratch.local);
    } else {
      mat4Multiply(scratch.world, scratch.world, scratch.local);
    }
  }
  mat4Copy(out, scratch.world);
  return true;
}

export interface RootMotionState {
  mode: RootMotionMode;
  options: ResolvedRootOptions;
  hasPrevious: boolean;
  resetRequested: boolean;
  tickValid: boolean;
  validSinceConsume: boolean;
  lastSpeed: number;
  readonly previous: Mat4;
  readonly inversePrevious: Mat4;
  readonly deltaMatrix: Mat4;
  readonly currentTranslation: Vec3;
  readonly previousTranslation: Vec3;
  readonly translation: Vec3;
  readonly rotation: Quat;
  readonly accumulator: Vec3;
  readonly accumulatorRotation: Quat;
  readonly scratchQuat: Quat;
}

export function createRootMotionState(
  mode: RootMotionMode,
  options: ResolvedRootOptions,
): RootMotionState {
  return {
    mode,
    options,
    hasPrevious: false,
    resetRequested: true,
    tickValid: false,
    validSinceConsume: false,
    lastSpeed: 0,
    previous: { m: new Float32Array(16) },
    inversePrevious: { m: new Float32Array(16) },
    deltaMatrix: { m: new Float32Array(16) },
    currentTranslation: { x: 0, y: 0, z: 0 },
    previousTranslation: { x: 0, y: 0, z: 0 },
    translation: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    accumulator: { x: 0, y: 0, z: 0 },
    accumulatorRotation: { x: 0, y: 0, z: 0, w: 1 },
    scratchQuat: { x: 0, y: 0, z: 0, w: 1 },
  };
}

/** Clears every stored delta and forces the next tick to be invalid. */
export function resetRootMotion(state: RootMotionState): void {
  state.hasPrevious = false;
  state.resetRequested = true;
  state.tickValid = false;
  state.validSinceConsume = false;
  state.lastSpeed = 0;
  state.translation.x = 0;
  state.translation.y = 0;
  state.translation.z = 0;
  quatIdentity(state.rotation);
  clearAccumulator(state);
}

function clearAccumulator(state: RootMotionState): void {
  state.accumulator.x = 0;
  state.accumulator.y = 0;
  state.accumulator.z = 0;
  quatIdentity(state.accumulatorRotation);
  state.validSinceConsume = false;
}

/**
 * §5.7. Compares `current` against the previous tick's root and accumulates a
 * valid delta. The first tick after creation or a reset, a dominant-action
 * change, and a rejected teleport all yield `tickValid = false` and clear the
 * accumulator.
 */
export function computeRootDelta(
  state: RootMotionState,
  current: Mat4,
  dt: number,
): void {
  state.tickValid = false;
  if (!state.hasPrevious || state.resetRequested) {
    state.hasPrevious = true;
    state.resetRequested = false;
    state.lastSpeed = 0;
    mat4Copy(state.previous, current);
    clearAccumulator(state);
    quatIdentity(state.rotation);
    return;
  }
  if (!mat4Invert(state.inversePrevious, state.previous)) {
    state.lastSpeed = 0;
    mat4Copy(state.previous, current);
    clearAccumulator(state);
    quatIdentity(state.rotation);
    return;
  }
  mat4Multiply(state.deltaMatrix, current, state.inversePrevious);
  if (!quatFromMat4(state.rotation, state.deltaMatrix)) {
    quatIdentity(state.rotation);
  }
  // Model-space displacement. The delta matrix's own translation is
  // `t_cur - R_delta * t_prev`, which re-rotates the absolute position and
  // therefore overstates movement whenever the root turns. [ER-08-05]
  mat4GetTranslation(state.currentTranslation, current);
  mat4GetTranslation(state.previousTranslation, state.previous);
  state.translation.x = state.currentTranslation.x - state.previousTranslation.x;
  state.translation.y = state.currentTranslation.y - state.previousTranslation.y;
  state.translation.z = state.currentTranslation.z - state.previousTranslation.z;
  const rawX = state.translation.x;
  const rawY = state.translation.y;
  const rawZ = state.translation.z;
  const rawMagnitude = Math.sqrt(rawX * rawX + rawY * rawY + rawZ * rawZ);

  if (!state.options.applyVertical) {
    state.translation.y = 0;
  }
  if (state.options.applyYaw) {
    writeYawQuat(state.rotation, state.rotation);
  } else {
    quatIdentity(state.rotation);
  }

  if (rawMagnitude > state.options.maxDeltaPerTick) {
    state.lastSpeed = 0;
    mat4Copy(state.previous, current);
    clearAccumulator(state);
    return;
  }

  state.accumulator.x += state.translation.x;
  state.accumulator.y += state.translation.y;
  state.accumulator.z += state.translation.z;
  quatMultiply(state.scratchQuat, state.accumulatorRotation, state.rotation);
  state.accumulatorRotation.x = state.scratchQuat.x;
  state.accumulatorRotation.y = state.scratchQuat.y;
  state.accumulatorRotation.z = state.scratchQuat.z;
  state.accumulatorRotation.w = state.scratchQuat.w;
  state.validSinceConsume = true;
  state.tickValid = true;
  state.lastSpeed = dt > 0 ? rawMagnitude / dt : 0;
  mat4Copy(state.previous, current);
}

/** §3.6: returns and clears the accumulated delta. */
export function consumeRootMotion(
  state: RootMotionState,
  out: RootMotionDelta,
): boolean {
  out.translation.x = state.accumulator.x;
  out.translation.y = state.accumulator.y;
  out.translation.z = state.accumulator.z;
  out.rotation.x = state.accumulatorRotation.x;
  out.rotation.y = state.accumulatorRotation.y;
  out.rotation.z = state.accumulatorRotation.z;
  out.rotation.w = state.accumulatorRotation.w;
  out.speed = state.lastSpeed;
  out.valid = state.validSinceConsume;
  const result = state.validSinceConsume;
  clearAccumulator(state);
  state.lastSpeed = 0;
  return result;
}

/**
 * `apply` writes the entity transform: `position += rotation * translation`,
 * then `rotation = rotation * deltaRotation` (02 multiply order).
 */
export function applyRootDelta(
  position: Vec3,
  rotation: Quat,
  translation: Vec3,
  deltaRotation: Quat,
  scratch: Vec3,
): void {
  quatRotateVec3(scratch, rotation, translation);
  position.x += scratch.x;
  position.y += scratch.y;
  position.z += scratch.z;
  quatMultiply(rotation, rotation, deltaRotation);
}

export interface RootPoseScratch {
  readonly inverse: Quat;
  readonly local: Quat;
  readonly result: Quat;
}

export function createRootPoseScratch(): RootPoseScratch {
  return {
    inverse: { x: 0, y: 0, z: 0, w: 1 },
    local: { x: 0, y: 0, z: 0, w: 1 },
    result: { x: 0, y: 0, z: 0, w: 1 },
  };
}

function writeYawQuat(out: Quat, quat: Quat): void {
  const yaw = Math.atan2(
    2 * (quat.w * quat.y + quat.x * quat.z),
    1 - 2 * (quat.y * quat.y + quat.z * quat.z),
  );
  quatFromAxisAngle(out, UP, yaw);
}

/**
 * §5.7. `apply` zeroes the applied components in `currentPose`: root XZ
 * translation always, Y when `applyVertical`, and yaw when `applyYaw`. The
 * root joint must be a skeleton root (`parents[rootJoint] === -1`); the
 * instance validates that when `apply` is selected. Zeroing the absolute
 * components (not the per-tick delta) keeps the root in place over time.
 */
export function removeRootFromPose(
  pose: PoseBuffer,
  rootJoint: number,
  applyVertical: boolean,
  applyYaw: boolean,
  scratch: RootPoseScratch,
): void {
  if (rootJoint < 0 || rootJoint >= pose.jointCount) return;
  pose.translations[rootJoint * 3] = 0;
  pose.translations[rootJoint * 3 + 2] = 0;
  if (applyVertical) {
    pose.translations[rootJoint * 3 + 1] = 0;
  }
  if (!applyYaw) return;
  const offset = rootJoint * 4;
  scratch.local.x = pose.rotations[offset]!;
  scratch.local.y = pose.rotations[offset + 1]!;
  scratch.local.z = pose.rotations[offset + 2]!;
  scratch.local.w = pose.rotations[offset + 3]!;
  writeYawQuat(scratch.result, scratch.local);
  quatInvert(scratch.inverse, scratch.result);
  quatMultiply(scratch.result, scratch.inverse, scratch.local);
  pose.rotations[offset] = scratch.result.x;
  pose.rotations[offset + 1] = scratch.result.y;
  pose.rotations[offset + 2] = scratch.result.z;
  pose.rotations[offset + 3] = scratch.result.w;
}

