/* Generated from stop-conditions.ts by experiments/e02/build.mjs. Do not edit directly. */
const BYTES_PER_MB = 1024 * 1024;
const JS_BLOCK_BYTES = 32 * BYTES_PER_MB;
const SAFE_LIMIT_BYTES = 512 * BYTES_PER_MB;
const BENCHMARK_FRAME_COUNT = 60;
const SLOWDOWN_FACTOR = 3;
const SLOW_STEPS_TO_STOP = 2;
const TEXTURE_SIZE = 1024;
const TEXTURE_BYTES = TEXTURE_SIZE * TEXTURE_SIZE * 4;
const TEXTURES_PER_STEP = 4;
const BUDGET_PERCENT = 70;
function percentile(values, fraction) {
  var _a;
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const clamped = Math.min(1, Math.max(0, fraction));
  const rank = Math.ceil(clamped * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return (_a = sorted[index]) != null ? _a : 0;
}
function summarizeFrameTimes(samples) {
  var _a;
  if (samples.length === 0) {
    return { sampleCount: 0, p50Ms: 0, p95Ms: 0, meanMs: 0, maxMs: 0 };
  }
  let total = 0;
  let maxMs = (_a = samples[0]) != null ? _a : 0;
  for (const sample of samples) {
    total += sample;
    if (sample > maxMs) maxMs = sample;
  }
  return {
    sampleCount: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    meanMs: total / samples.length,
    maxMs
  };
}
function evaluateStep(input) {
  const frame = summarizeFrameTimes(input.frameSamplesMs);
  const slow = input.baselineFrameMs > 0 && frame.p95Ms > input.baselineFrameMs * SLOWDOWN_FACTOR;
  const consecutiveSlowSteps = slow ? input.consecutiveSlowSteps + 1 : 0;
  const stableBytes = slow ? input.previousStableBytes : input.allocatedBytes;
  let stopReason = null;
  if (consecutiveSlowSteps >= SLOW_STEPS_TO_STOP) {
    stopReason = "frame-slowdown";
  } else if (input.safeMode && input.allocatedBytes >= SAFE_LIMIT_BYTES) {
    stopReason = "safe-limit";
  }
  return { frame, slow, consecutiveSlowSteps, stableBytes, stopReason };
}
function recordFailedStep(stopReason, previousStableBytes, attemptedBytes) {
  return { stopReason, stableBytes: previousStableBytes, attemptedBytes };
}
function textureAllocationBytes(count) {
  return count * TEXTURE_BYTES;
}
function totalStableBytes(jsStableBytes, textureStableBytes) {
  return jsStableBytes + textureStableBytes;
}
function budget70PercentMb(stableMb) {
  return Math.floor(stableMb * BUDGET_PERCENT / 100);
}
function bytesToMb(bytes) {
  return bytes / BYTES_PER_MB;
}
export {
  BENCHMARK_FRAME_COUNT,
  BUDGET_PERCENT,
  BYTES_PER_MB,
  JS_BLOCK_BYTES,
  SAFE_LIMIT_BYTES,
  SLOWDOWN_FACTOR,
  SLOW_STEPS_TO_STOP,
  TEXTURES_PER_STEP,
  TEXTURE_BYTES,
  TEXTURE_SIZE,
  budget70PercentMb,
  bytesToMb,
  evaluateStep,
  percentile,
  recordFailedStep,
  summarizeFrameTimes,
  textureAllocationBytes,
  totalStableBytes
};
