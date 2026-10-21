import { describe, expect, it } from "vitest";
import {
  BENCHMARK_FRAME_COUNT,
  BUDGET_PERCENT,
  BYTES_PER_MB,
  JS_BLOCK_BYTES,
  SAFE_LIMIT_BYTES,
  SLOW_STEPS_TO_STOP,
  SLOWDOWN_FACTOR,
  TEXTURE_BYTES,
  TEXTURE_SIZE,
  budget70PercentMb,
  bytesToMb,
  evaluateStep,
  percentile,
  recordFailedStep,
  summarizeFrameTimes,
  textureAllocationBytes,
  totalStableBytes,
} from "../stop-conditions.js";

const MB = BYTES_PER_MB;

function frames(count: number, value: number): number[] {
  return new Array<number>(count).fill(value);
}

function framesWithPeak(
  count: number,
  value: number,
  peak: number,
  peakCount: number,
): number[] {
  const samples = frames(count, value);
  for (let index = 0; index < peakCount; index += 1) {
    samples[count - 1 - index] = peak;
  }
  return samples;
}

describe("[E2] memory ceiling stop conditions", () => {
  it("[E2] the method uses 60 frames, 3x p95 and two consecutive slow steps", () => {
    expect(BENCHMARK_FRAME_COUNT).toBe(60);
    expect(SLOWDOWN_FACTOR).toBe(3);
    expect(SLOW_STEPS_TO_STOP).toBe(2);
    expect(JS_BLOCK_BYTES).toBe(32 * MB);
    expect(SAFE_LIMIT_BYTES).toBe(512 * MB);
  });

  it("[E2] p95 is the 95th percentile of the benchmark frames", () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(samples, 0.95)).toBe(95);
    expect(percentile([], 0.95)).toBe(0);

    const stats = summarizeFrameTimes(frames(BENCHMARK_FRAME_COUNT, 10));
    expect(stats.sampleCount).toBe(60);
    expect(stats.p50Ms).toBe(10);
    expect(stats.p95Ms).toBe(10);
    expect(stats.meanMs).toBe(10);
    expect(stats.maxMs).toBe(10);
  });

  it("[E2] memory probe stops at the first unstable step", () => {
    const baselineMs = 10;
    const stableBytes = 32 * MB;

    const firstSlow = evaluateStep({
      frameSamplesMs: framesWithPeak(BENCHMARK_FRAME_COUNT, 10, 40, 6),
      baselineFrameMs: baselineMs,
      allocatedBytes: 64 * MB,
      previousStableBytes: stableBytes,
      consecutiveSlowSteps: 0,
      safeMode: false,
    });
    expect(firstSlow.slow).toBe(true);
    expect(firstSlow.stableBytes).toBe(stableBytes);
    expect(firstSlow.stableBytes).not.toBe(64 * MB);
    expect(firstSlow.consecutiveSlowSteps).toBe(1);
    expect(firstSlow.stopReason).toBeNull();

    const secondSlow = evaluateStep({
      frameSamplesMs: framesWithPeak(BENCHMARK_FRAME_COUNT, 10, 40, 6),
      baselineFrameMs: baselineMs,
      allocatedBytes: 96 * MB,
      previousStableBytes: stableBytes,
      consecutiveSlowSteps: firstSlow.consecutiveSlowSteps,
      safeMode: false,
    });
    expect(secondSlow.stopReason).toBe("frame-slowdown");
    expect(secondSlow.stableBytes).toBe(stableBytes);
  });

  it("[E2] a stable step breaks the consecutive slow streak", () => {
    const recovery = evaluateStep({
      frameSamplesMs: frames(BENCHMARK_FRAME_COUNT, 10),
      baselineFrameMs: 10,
      allocatedBytes: 96 * MB,
      previousStableBytes: 32 * MB,
      consecutiveSlowSteps: 1,
      safeMode: false,
    });
    expect(recovery.slow).toBe(false);
    expect(recovery.consecutiveSlowSteps).toBe(0);
    expect(recovery.stableBytes).toBe(96 * MB);
    expect(recovery.stopReason).toBeNull();
  });

  it("[E2] an allocation throw keeps the last completed step", () => {
    const snapshot = recordFailedStep("allocation-throw", 96 * MB, 128 * MB);
    expect(snapshot.stopReason).toBe("allocation-throw");
    expect(snapshot.stableBytes).toBe(96 * MB);
    expect(snapshot.attemptedBytes).toBe(128 * MB);
    expect(snapshot.stableBytes).toBeLessThan(snapshot.attemptedBytes);
  });

  it("[E2] WebGL context loss keeps the last stable texture memory", () => {
    const snapshot = recordFailedStep("webgl-context-lost", 80 * MB, 96 * MB);
    expect(snapshot.stopReason).toBe("webgl-context-lost");
    expect(snapshot.stableBytes).toBe(80 * MB);
    expect(snapshot.attemptedBytes).toBe(96 * MB);
  });

  it("[E2] safe mode stops at 512 MB while a full run continues", () => {
    const below = evaluateStep({
      frameSamplesMs: frames(BENCHMARK_FRAME_COUNT, 10),
      baselineFrameMs: 10,
      allocatedBytes: SAFE_LIMIT_BYTES - JS_BLOCK_BYTES,
      previousStableBytes: SAFE_LIMIT_BYTES - JS_BLOCK_BYTES,
      consecutiveSlowSteps: 0,
      safeMode: true,
    });
    expect(below.stopReason).toBeNull();

    const atLimit = evaluateStep({
      frameSamplesMs: frames(BENCHMARK_FRAME_COUNT, 10),
      baselineFrameMs: 10,
      allocatedBytes: SAFE_LIMIT_BYTES,
      previousStableBytes: SAFE_LIMIT_BYTES - JS_BLOCK_BYTES,
      consecutiveSlowSteps: 0,
      safeMode: true,
    });
    expect(atLimit.stableBytes).toBe(SAFE_LIMIT_BYTES);
    expect(atLimit.stopReason).toBe("safe-limit");

    const fullRun = evaluateStep({
      frameSamplesMs: frames(BENCHMARK_FRAME_COUNT, 10),
      baselineFrameMs: 10,
      allocatedBytes: SAFE_LIMIT_BYTES,
      previousStableBytes: SAFE_LIMIT_BYTES - JS_BLOCK_BYTES,
      consecutiveSlowSteps: 0,
      safeMode: false,
    });
    expect(fullRun.stopReason).toBeNull();
  });

  it("[E2] estimated total is the sum of the stable JS and texture limits", () => {
    expect(totalStableBytes(300 * MB, 128 * MB)).toBe(428 * MB);
    expect(bytesToMb(428 * MB)).toBe(428);
  });
});

describe("[PR-11.2] budgets come from the measured limit", () => {
  it("[PR-11.2] budgets are set at 70% of the stable limit, not guessed", () => {
    expect(BUDGET_PERCENT).toBe(70);
    expect(budget70PercentMb(300)).toBe(210);
    expect(budget70PercentMb(128)).toBe(89);
    expect(budget70PercentMb(512)).toBe(358);
  });
});

describe("[G3] texture budget derives from E2", () => {
  it("[G3] texture memory is counted from 1024x1024 RGBA allocations", () => {
    expect(TEXTURE_SIZE).toBe(1024);
    expect(TEXTURE_BYTES).toBe(4 * MB);
    expect(textureAllocationBytes(32)).toBe(128 * MB);
    expect(budget70PercentMb(bytesToMb(textureAllocationBytes(32)))).toBe(89);
  });
});
