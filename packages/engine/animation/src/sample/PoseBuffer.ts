/**
 * Pose and palette buffers (spec 08 §3.2, §5.2).
 *
 * Allocation happens only here and at instance creation; the hot path copies
 * into buffers the caller owns. A `PoseBuffer` is always sized exactly to its
 * skeleton.
 */

import type { JointPalette, PoseBuffer } from "../contracts/animation.js";
import { animationError, IS_DEV } from "../errors.js";

function assertCount(jointCount: number, what: string): void {
  if (!Number.isInteger(jointCount) || jointCount < 0) {
    throw animationError(
      "E_CONTRACT",
      `${what}: jointCount must be a non-negative integer`,
    );
  }
}

/** §3.2. Allocates; cold path only. Every joint starts at identity TRS. */
export function createPoseBuffer(jointCount: number): PoseBuffer {
  assertCount(jointCount, "createPoseBuffer");
  const translations = new Float32Array(jointCount * 3);
  const rotations = new Float32Array(jointCount * 4);
  const scales = new Float32Array(jointCount * 3);
  for (let index = 0; index < jointCount; index += 1) {
    rotations[index * 4 + 3] = 1;
    scales[index * 3] = 1;
    scales[index * 3 + 1] = 1;
    scales[index * 3 + 2] = 1;
  }
  return { jointCount, translations, rotations, scales };
}

/** §3.2. Allocates; cold path only. Zero matrices until written. */
export function createJointPalette(jointCount: number): JointPalette {
  assertCount(jointCount, "createJointPalette");
  return { jointCount, matrices: new Float32Array(jointCount * 16) };
}

/** §3.2. Allocation-free copy; aliasing is rejected in dev. */
export function copyPose(out: PoseBuffer, source: PoseBuffer): void {
  if (out.jointCount !== source.jointCount) {
    if (IS_DEV) {
      throw animationError(
        "E_CONTRACT",
        `copyPose: jointCount mismatch (${out.jointCount} != ${source.jointCount})`,
      );
    }
    return;
  }
  if (
    out.translations === source.translations &&
    out.rotations === source.rotations &&
    out.scales === source.scales
  ) {
    if (IS_DEV) {
      throw animationError("E_CONTRACT", "copyPose: source and destination alias");
    }
    return;
  }
  out.translations.set(source.translations);
  out.rotations.set(source.rotations);
  out.scales.set(source.scales);
}

/** In-place identity reset for one joint; allocation-free. */
export function resetPoseJoint(pose: PoseBuffer, joint: number): void {
  const t = joint * 3;
  const r = joint * 4;
  pose.translations[t] = 0;
  pose.translations[t + 1] = 0;
  pose.translations[t + 2] = 0;
  pose.rotations[r] = 0;
  pose.rotations[r + 1] = 0;
  pose.rotations[r + 2] = 0;
  pose.rotations[r + 3] = 1;
  pose.scales[t] = 1;
  pose.scales[t + 1] = 1;
  pose.scales[t + 2] = 1;
}
