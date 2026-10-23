/**
 * Track binary search and key sampling (spec 08 §5.4).
 *
 * All functions are allocation-free and mutate only the caller's buffers.
 * Times are stored as f32 and are strictly ascending by compile validation.
 */

import type { AnimationTrack, PoseBuffer } from "../contracts/animation.js";
import { nlerpInto, copyInto, lerpInto } from "../sample/interpolate.js";

/**
 * Index of the last key with `times[i] <= time`; 0 before the first key and
 * `keyCount - 1` after the last. `keyCount` must be >= 1.
 */
export function findKeyIndex(
  times: Float32Array,
  keyCount: number,
  time: number,
): number {
  if (keyCount <= 1) return 0;
  if (time <= times[0]!) return 0;
  if (time >= times[keyCount - 1]!) return keyCount - 1;
  let low = 0;
  let high = keyCount - 1;
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    if (times[mid]! <= time) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * Samples a TRS track into `pose` at `time` (already clamped by the action).
 * A `weights` track is ignored here; morph sampling uses `sampleWeightInto`.
 */
export function sampleTrackInto(
  track: AnimationTrack,
  time: number,
  pose: PoseBuffer,
): void {
  const target = track.target;
  const stride = track.valueStride;
  const times = track.times;
  const values = track.values;

  const step = track.interpolation === "step";
  if (track.path === "translation") {
    sampleVector(
      values,
      times,
      track.keyCount,
      stride,
      3,
      time,
      pose.translations,
      target * 3,
      false,
      step,
    );
  } else if (track.path === "scale") {
    sampleVector(
      values,
      times,
      track.keyCount,
      stride,
      3,
      time,
      pose.scales,
      target * 3,
      false,
      step,
    );
  } else if (track.path === "rotation") {
    sampleVector(
      values,
      times,
      track.keyCount,
      stride,
      4,
      time,
      pose.rotations,
      target * 4,
      true,
      step,
    );
  }
}

/**
 * Samples a `weights` track (one float per key) into `out[target]`. Targets
 * outside `out` are ignored (compile validates them against the morph cap).
 */
export function sampleWeightInto(
  track: AnimationTrack,
  time: number,
  out: Float32Array,
): void {
  const target = track.target;
  if (target < 0 || target >= out.length) return;
  const times = track.times;
  const values = track.values;
  const keyCount = track.keyCount;
  if (keyCount === 1 || track.interpolation === "step") {
    out[target] = values[findKeyIndex(times, keyCount, time)]!;
    return;
  }
  const left = findKeyIndex(times, keyCount, time);
  if (left >= keyCount - 1) {
    out[target] = values[keyCount - 1]!;
    return;
  }
  const t0 = times[left]!;
  const t1 = times[left + 1]!;
  const span = t1 - t0;
  const alpha = span > 0 ? (time - t0) / span : 0;
  const a = values[left]!;
  const b = values[left + 1]!;
  out[target] = a + (b - a) * alpha;
}

function sampleVector(
  values: Float32Array,
  times: Float32Array,
  keyCount: number,
  stride: number,
  width: number,
  time: number,
  out: Float32Array,
  outOffset: number,
  rotate: boolean,
  step: boolean,
): void {
  if (keyCount === 1) {
    copyInto(out, outOffset, values, 0, width);
    return;
  }
  if (time <= times[0]!) {
    copyInto(out, outOffset, values, 0, width);
    return;
  }
  if (time >= times[keyCount - 1]!) {
    copyInto(out, outOffset, values, (keyCount - 1) * stride, width);
    return;
  }
  const left = findKeyIndex(times, keyCount, time);
  const leftOffset = left * stride;
  if (step) {
    copyInto(out, outOffset, values, leftOffset, width);
    return;
  }
  const rightOffset = leftOffset + stride;
  const t0 = times[left]!;
  const t1 = times[left + 1]!;
  const span = t1 - t0;
  const alpha = span > 0 ? (time - t0) / span : 0;
  if (rotate) {
    nlerpInto(out, outOffset, values, leftOffset, values, rightOffset, alpha);
  } else {
    lerpInto(out, outOffset, values, leftOffset, values, rightOffset, width, alpha);
  }
}
