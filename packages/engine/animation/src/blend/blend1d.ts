/**
 * 1D blend-tree weights (spec 08 §3.4, §5.5).
 *
 * Bracketing is linear between thresholds and clamped at the ends. The tree is
 * immutable and validated once at `play`; evaluation allocates nothing.
 */

import type { BlendTree1D } from "../contracts/animation.js";
import { animationError } from "../errors.js";
import { ANIMATION_MAX_TREE_SAMPLES } from "../version.js";

function fail(message: string): never {
  throw animationError("E_CONTRACT", `blendTree1D: ${message}`);
}

/** §3.4/§5.5. Throws for fewer than two samples, unsorted or duplicate thresholds. */
export function validateBlendTree1D(tree: BlendTree1D): void {
  const samples = tree.samples;
  if (samples.length < 2 || samples.length > ANIMATION_MAX_TREE_SAMPLES) {
    fail(`sample count ${samples.length} outside 2..${ANIMATION_MAX_TREE_SAMPLES}`);
  }
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]!;
    if (!Number.isFinite(sample.threshold)) {
      fail(`sample ${i} threshold is not finite`);
    }
    if (i > 0 && !(sample.threshold > samples[i - 1]!.threshold)) {
      fail(`sample ${i} threshold is not strictly ascending`);
    }
    if (
      sample.speed !== undefined &&
      !(sample.speed > 0 && Number.isFinite(sample.speed))
    ) {
      fail(`sample ${i} speed must be finite and > 0`);
    }
    if (!(sample.clip.duration > 0)) {
      fail(`sample ${i} clip has no duration`);
    }
  }
}

/**
 * Writes per-sample weights in sample order and returns the number of
 * contributing samples (1 or 2). `outWeights.length` must cover the samples.
 * `parameter` NaN is treated as 0 so a bad game value cannot poison a pose.
 */
export function evaluateBlend1D(
  tree: BlendTree1D,
  parameter: number,
  outWeights: Float32Array,
): number {
  const samples = tree.samples;
  const count = samples.length;
  for (let i = 0; i < count; i += 1) {
    outWeights[i] = 0;
  }
  const p = Number.isFinite(parameter) ? parameter : 0;
  if (count === 0) return 0;
  if (p <= samples[0]!.threshold) {
    outWeights[0] = 1;
    return 1;
  }
  if (p >= samples[count - 1]!.threshold) {
    outWeights[count - 1] = 1;
    return 1;
  }
  let left = 0;
  for (let i = 0; i + 1 < count; i += 1) {
    if (p >= samples[i]!.threshold && p <= samples[i + 1]!.threshold) {
      left = i;
      break;
    }
  }
  const t0 = samples[left]!.threshold;
  const t1 = samples[left + 1]!.threshold;
  const alpha = t1 > t0 ? (p - t0) / (t1 - t0) : 0;
  outWeights[left] = 1 - alpha;
  outWeights[left + 1] = alpha;
  return alpha === 0 || alpha === 1 ? 1 : 2;
}

/** The sample with the highest weight; ties resolve to the lower index. */
export function dominantSampleIndex(weights: Float32Array, count: number): number {
  let best = 0;
  let bestWeight = -1;
  for (let i = 0; i < count; i += 1) {
    const weight = weights[i]!;
    if (weight > bestWeight) {
      bestWeight = weight;
      best = i;
    }
  }
  return best;
}

/** Sum of weights for the contributing samples, used by tests and stats. */
export function sampleWeightSum(weights: Float32Array, count: number): number {
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    sum += weights[i]!;
  }
  return sum;
}
