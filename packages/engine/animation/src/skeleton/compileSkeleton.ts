/**
 * Skeleton compilation and validation (spec 08 §3.2, §4.3, §4.7).
 *
 * A compiled skeleton is immutable and shared by every instance. Validation is
 * a boundary operation: it throws `E_ASSET_FORMAT` on malformed input and
 * never runs in `update`.
 */

import type { Skeleton, PoseBuffer } from "../contracts/animation.js";
import type { SkeletonSource } from "../contracts/sources.js";
import { animationError } from "../errors.js";
import { createPoseBuffer } from "../sample/PoseBuffer.js";
import { ANIMATION_MAX_JOINTS, ANIMATION_MAX_ROOTS } from "../version.js";

function fail(message: string): never {
  throw animationError("E_ASSET_FORMAT", `compileSkeleton: ${message}`);
}

function requireLength(
  array: ArrayLike<number>,
  expected: number,
  what: string,
): void {
  if (array.length !== expected) {
    fail(`${what} length ${array.length} != ${expected}`);
  }
}

function requireFinite(array: ArrayLike<number>, what: string): void {
  for (let i = 0; i < array.length; i += 1) {
    if (!Number.isFinite(array[i])) {
      fail(`${what}[${i}] is not finite`);
    }
  }
}

/**
 * §3.2. `parents` must be topological (`parents[i] < i`), have at least one
 * root and at most sixteen. The returned arrays are copies: a caller mutating
 * its source cannot corrupt live instances.
 */
export function compileSkeleton(source: SkeletonSource): Skeleton {
  const jointCount = source.parents.length;
  if (jointCount < 1 || jointCount > ANIMATION_MAX_JOINTS) {
    fail(`jointCount ${jointCount} outside 1..${ANIMATION_MAX_JOINTS}`);
  }

  if (source.jointNames.length !== jointCount) {
    fail(
      `jointNames has ${source.jointNames.length} entries, expected ${jointCount}`,
    );
  }
  for (let i = 0; i < jointCount; i += 1) {
    if (typeof source.jointNames[i] !== "string") {
      fail(`jointNames[${i}] is not a string`);
    }
  }

  const parents = new Int16Array(jointCount);
  let roots = 0;
  for (let i = 0; i < jointCount; i += 1) {
    const parent = source.parents[i]!;
    if (!Number.isInteger(parent) || parent < -1 || parent >= i) {
      fail(`parents[${i}] = ${parent} is not a topological parent index`);
    }
    if (parent === -1) {
      roots += 1;
    }
    parents[i] = parent;
  }
  if (roots === 0) {
    fail("skeleton has no root joint");
  }
  if (roots > ANIMATION_MAX_ROOTS) {
    fail(`${roots} roots exceed the limit of ${ANIMATION_MAX_ROOTS}`);
  }

  requireLength(source.inverseBindMatrices, jointCount * 16, "inverseBindMatrices");
  requireLength(source.restTranslations, jointCount * 3, "restTranslations");
  requireLength(source.restRotations, jointCount * 4, "restRotations");
  requireLength(source.restScales, jointCount * 3, "restScales");
  for (let i = 0; i < jointCount; i += 1) {
    const qx = source.restRotations[i * 4]!;
    const qy = source.restRotations[i * 4 + 1]!;
    const qz = source.restRotations[i * 4 + 2]!;
    const qw = source.restRotations[i * 4 + 3]!;
    const norm = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
    if (!(norm > 0) || !Number.isFinite(norm)) {
      fail(`restRotations[${i}] is not a valid quaternion`);
    }
  }
  requireFinite(source.inverseBindMatrices, "inverseBindMatrices");
  requireFinite(source.restTranslations, "restTranslations");
  requireFinite(source.restRotations, "restRotations");
  requireFinite(source.restScales, "restScales");

  let rootJoint = source.rootJoint;
  if (rootJoint === undefined || rootJoint === -1) {
    rootJoint = -1;
    for (let i = 0; i < jointCount; i += 1) {
      if (parents[i] === -1) {
        rootJoint = i;
        break;
      }
    }
  }
  if (rootJoint < -1 || rootJoint >= jointCount) {
    fail(`rootJoint ${rootJoint} outside -1..${jointCount - 1}`);
  }

  const restPose: PoseBuffer = createPoseBuffer(jointCount);
  restPose.translations.set(source.restTranslations);
  restPose.rotations.set(source.restRotations);
  restPose.scales.set(source.restScales);

  const skeleton: Skeleton = {
    jointCount,
    parents,
    inverseBindMatrices: new Float32Array(source.inverseBindMatrices),
    restPose,
    rootJoint,
    jointNames: source.jointNames.slice(),
    ...(source.id === undefined ? {} : { id: source.id }),
  };
  return skeleton;
}
