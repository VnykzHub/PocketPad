/**
 * Layer composition and bone masks (spec 08 §3.4, §5.5, §5.6).
 *
 * Override layers are M1; the additive formula is the fixed M2 definition and
 * is tested directly even though the M1 instance API rejects additive layers.
 * Every function mutates only caller-owned buffers and allocates nothing.
 */

import type {
  BoneMask,
  LayerDesc,
  PoseBuffer,
} from "../contracts/animation.js";
import type { Quat } from "@lanpad/engine-core";
import {
  quatInvert,
  quatMultiply,
  quatNlerp,
} from "@lanpad/engine-core";
import { animationError } from "../errors.js";
import { lerpInto, nlerpInto } from "../sample/interpolate.js";

/** Number of u32 words a mask must provide for `jointCount` joints. */
export function maskWordCount(jointCount: number): number {
  return (jointCount + 31) >>> 5;
}

/** §5.6. A mask shorter than `ceil(jointCount / 32)` is `E_CONTRACT`. */
export function validateMask(
  mask: BoneMask | undefined,
  jointCount: number,
  layerName: string,
): void {
  if (mask === undefined) return;
  const needed = maskWordCount(jointCount);
  if (mask.joints.length < needed) {
    throw animationError(
      "E_CONTRACT",
      `layer "${layerName}": mask has ${mask.joints.length} words, needs ${needed}`,
    );
  }
}

/** Copies a mask so the game cannot mutate it after creation. */
export function copyMask(mask: BoneMask | undefined): Uint32Array | undefined {
  return mask === undefined ? undefined : new Uint32Array(mask.joints);
}

/** All-joints mask used when a layer declares none. */
export function fullMask(jointCount: number): Uint32Array {
  const words = new Uint32Array(maskWordCount(jointCount));
  const full = 0xffffffff;
  for (let i = 0; i < words.length; i += 1) {
    words[i] = full;
  }
  const last = jointCount & 31;
  if (last !== 0 && words.length > 0) {
    words[words.length - 1] = (1 << last) - 1;
  }
  return words;
}

/** §5.6 bit test: word index `i >>> 5`, bit `1 << (i & 31)`. */
export function maskHas(mask: Uint32Array | undefined, joint: number): boolean {
  if (mask === undefined) return true;
  const word = mask[joint >>> 5];
  if (word === undefined) return false;
  return (word & (1 << (joint & 31))) !== 0;
}

/**
 * §5.5 (M1): for masked joints, `T/S = lerp(B, O, w)` and `R = nlerp(B, O, w)`.
 * `weight` is already `actionWeight * layerWeight`.
 */
export function applyOverrideLayer(
  base: PoseBuffer,
  overlay: PoseBuffer,
  mask: Uint32Array | undefined,
  weight: number,
): void {
  const w = weight < 0 ? 0 : weight > 1 ? 1 : weight;
  if (w === 0) return;
  if (base.jointCount !== overlay.jointCount) {
    throw animationError("E_CONTRACT", "applyOverrideLayer: pose size mismatch");
  }
  for (let joint = 0; joint < base.jointCount; joint += 1) {
    if (!maskHas(mask, joint)) continue;
    lerpInto(
      base.translations,
      joint * 3,
      base.translations,
      joint * 3,
      overlay.translations,
      joint * 3,
      3,
      w,
    );
    lerpInto(
      base.scales,
      joint * 3,
      base.scales,
      joint * 3,
      overlay.scales,
      joint * 3,
      3,
      w,
    );
    nlerpInto(
      base.rotations,
      joint * 4,
      base.rotations,
      joint * 4,
      overlay.rotations,
      joint * 4,
      w,
    );
  }
}

/** Reusable quaternions for the additive formula; one set per instance. */
export interface AdditiveScratch {
  readonly a: Quat;
  readonly b: Quat;
  readonly c: Quat;
  readonly d: Quat;
}

export function createAdditiveScratch(): AdditiveScratch {
  return {
    a: { x: 0, y: 0, z: 0, w: 1 },
    b: { x: 0, y: 0, z: 0, w: 1 },
    c: { x: 0, y: 0, z: 0, w: 1 },
    d: { x: 0, y: 0, z: 0, w: 1 },
  };
}

/**
 * §5.5 (M2), fixed formula: `T/S = B + (A - rest) * w` and
 * `R = B * nlerp(identity, A * inverse(rest), w)`. Exposed as a pure function
 * so both implementations agree; the M1 instance API does not call it.
 */
export function applyAdditiveLayer(
  base: PoseBuffer,
  overlay: PoseBuffer,
  rest: PoseBuffer,
  mask: Uint32Array | undefined,
  weight: number,
  scratch: AdditiveScratch,
): void {
  const w = weight < 0 ? 0 : weight > 1 ? 1 : weight;
  if (w === 0) return;
  if (
    base.jointCount !== overlay.jointCount ||
    base.jointCount !== rest.jointCount
  ) {
    throw animationError("E_CONTRACT", "applyAdditiveLayer: pose size mismatch");
  }
  for (let joint = 0; joint < base.jointCount; joint += 1) {
    if (!maskHas(mask, joint)) continue;
    const t = joint * 3;
    for (let i = 0; i < 3; i += 1) {
      base.translations[t + i] =
        base.translations[t + i]! +
        (overlay.translations[t + i]! - rest.translations[t + i]!) * w;
      base.scales[t + i] =
        base.scales[t + i]! + (overlay.scales[t + i]! - rest.scales[t + i]!) * w;
    }
    const r = joint * 4;
    const overlayQ = scratch.a;
    overlayQ.x = overlay.rotations[r]!;
    overlayQ.y = overlay.rotations[r + 1]!;
    overlayQ.z = overlay.rotations[r + 2]!;
    overlayQ.w = overlay.rotations[r + 3]!;
    const inverseRest = scratch.b;
    inverseRest.x = rest.rotations[r]!;
    inverseRest.y = rest.rotations[r + 1]!;
    inverseRest.z = rest.rotations[r + 2]!;
    inverseRest.w = rest.rotations[r + 3]!;
    quatInvert(inverseRest, inverseRest);
    // delta = A * inverse(rest)
    const delta = scratch.c;
    quatMultiply(delta, overlayQ, inverseRest);
    // qn = nlerp(identity, delta, w)
    const identity = scratch.d;
    identity.x = 0;
    identity.y = 0;
    identity.z = 0;
    identity.w = 1;
    const qn = scratch.b;
    quatNlerp(qn, identity, delta, w);
    // result = B * qn
    const baseQ = scratch.a;
    baseQ.x = base.rotations[r]!;
    baseQ.y = base.rotations[r + 1]!;
    baseQ.z = base.rotations[r + 2]!;
    baseQ.w = base.rotations[r + 3]!;
    const result = scratch.c;
    quatMultiply(result, baseQ, qn);
    base.rotations[r] = result.x;
    base.rotations[r + 1] = result.y;
    base.rotations[r + 2] = result.z;
    base.rotations[r + 3] = result.w;
  }
}

/** Weight clamp shared by layer and action writes. */
export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** §5.6: layer weights clamp to [0, 1]. */
export function clampLayerWeight(layer: LayerDesc): number {
  return layer.weight === undefined ? 1 : clampUnit(layer.weight);
}
