/**
 * Model-space skinning palette (spec 08 §5.3, §5.9).
 *
 * Interpolates the two fixed-tick poses, computes local `T * R * S`, walks the
 * hierarchy in index order and writes `J_i = W_i * inverseBind_i`. Buffers are
 * allocated once per instance; the hot path uses only scalar locals.
 */

import type { JointPalette, PoseBuffer, Skeleton } from "../contracts/animation.js";
import type { Mat4, Quat, Vec3 } from "@lanpad/engine-core";
import { mat4Compose, mat4Identity } from "@lanpad/engine-core";
import { createPoseBuffer, copyPose } from "../sample/PoseBuffer.js";
import { lerpInto, nlerpInto } from "../sample/interpolate.js";

/** Preallocated per-instance scratch for `computePalette`. */
export interface PaletteScratch {
  readonly pose: PoseBuffer;
  readonly local: Mat4;
  readonly worlds: Float32Array;
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

export function createPaletteScratch(jointCount: number): PaletteScratch {
  const local: Mat4 = { m: new Float32Array(16) };
  mat4Identity(local);
  return {
    pose: createPoseBuffer(jointCount),
    local,
    worlds: new Float32Array(jointCount * 16),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

/**
 * §5.3. `alpha` is clamped to [0, 1]; at the endpoints the stored pose is used
 * directly (no interpolation pass). Joint parents always precede children.
 */
export function computePalette(
  skeleton: Skeleton,
  previous: PoseBuffer,
  current: PoseBuffer,
  alpha: number,
  out: JointPalette,
  scratch: PaletteScratch,
): void {
  if (out.jointCount !== skeleton.jointCount) {
    throw new Error(
      `computePalette: palette jointCount ${out.jointCount} != ${skeleton.jointCount}`,
    );
  }
  const clamped = !Number.isFinite(alpha)
    ? 0
    : alpha < 0
      ? 0
      : alpha > 1
        ? 1
        : alpha;
  let pose: PoseBuffer;
  if (clamped <= 0) {
    pose = previous;
  } else if (clamped >= 1) {
    pose = current;
  } else {
    pose = scratch.pose;
    pose.translations.set(previous.translations);
    pose.rotations.set(previous.rotations);
    pose.scales.set(previous.scales);
    const count = skeleton.jointCount;
    for (let joint = 0; joint < count; joint += 1) {
      lerpInto(
        pose.translations,
        joint * 3,
        previous.translations,
        joint * 3,
        current.translations,
        joint * 3,
        3,
        clamped,
      );
      nlerpInto(
        pose.rotations,
        joint * 4,
        previous.rotations,
        joint * 4,
        current.rotations,
        joint * 4,
        clamped,
      );
      lerpInto(
        pose.scales,
        joint * 3,
        previous.scales,
        joint * 3,
        current.scales,
        joint * 3,
        3,
        clamped,
      );
    }
  }

  const count = skeleton.jointCount;
  const parents = skeleton.parents;
  const worlds = scratch.worlds;
  const local = scratch.local;
  const ibm = skeleton.inverseBindMatrices;
  const matrices = out.matrices;
  for (let joint = 0; joint < count; joint += 1) {
    const position = scratch.position;
    position.x = pose.translations[joint * 3]!;
    position.y = pose.translations[joint * 3 + 1]!;
    position.z = pose.translations[joint * 3 + 2]!;
    const rotation = scratch.rotation;
    rotation.x = pose.rotations[joint * 4]!;
    rotation.y = pose.rotations[joint * 4 + 1]!;
    rotation.z = pose.rotations[joint * 4 + 2]!;
    rotation.w = pose.rotations[joint * 4 + 3]!;
    const scale = scratch.scale;
    scale.x = pose.scales[joint * 3]!;
    scale.y = pose.scales[joint * 3 + 1]!;
    scale.z = pose.scales[joint * 3 + 2]!;
    mat4Compose(local, position, rotation, scale);

    const parent = parents[joint]!;
    const worldOffset = joint * 16;
    if (parent < 0) {
      for (let i = 0; i < 16; i += 1) {
        worlds[worldOffset + i] = local.m[i]!;
      }
    } else {
      multiplyFlat(worlds, worldOffset, worlds, parent * 16, local.m, 0);
    }
    multiplyFlat(matrices, worldOffset, worlds, worldOffset, ibm, worldOffset);
  }
}

/** C = A * B for column-major 4x4 matrices stored in flat f32 arrays. */
function multiplyFlat(
  out: Float32Array,
  outOffset: number,
  a: Float32Array,
  aOffset: number,
  b: Float32Array,
  bOffset: number,
): void {
  for (let column = 0; column < 4; column += 1) {
    const columnBase = bOffset + column * 4;
    const outBase = outOffset + column * 4;
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += a[aOffset + k * 4 + row]! * b[columnBase + k]!;
      }
      out[outBase + row] = sum;
    }
  }
}

/** Copies a pose without interpolation, for `readPose`. */
export function readPoseInto(out: PoseBuffer, source: PoseBuffer): void {
  copyPose(out, source);
}
