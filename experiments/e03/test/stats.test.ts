import { describe, expect, it } from "vitest";
import {
  DrawCallCounter,
  E3_DISCARD_FRAMES,
  E3_MEASURE_MS,
  E3_PASS_FPS,
  E3_SAMPLING_PLAN,
  E3_WARMUP_MS,
  FrameSampler,
  MESH_TRIANGLE_COUNT,
  MESH_VERTEX_COUNT,
  SCENES,
  atlasTextureBytes,
  buildRunPlan,
  bytesToMB,
  createRunResult,
  drawCallThroughput,
  evaluatePassCriterion,
  percentile,
  sceneGpuMemoryBytes,
  summarizeFrameTimes,
} from "../stats.ts";
import type { SamplerSummary } from "../stats.ts";

describe("[E3] frame-time statistics", () => {
  it("[E3] percentile uses nearest rank and summary reports p50, p95 and fps", () => {
    const values = [16, 17, 15, 20, 100];
    const summary = summarizeFrameTimes(values);

    expect(percentile(values, 50)).toBe(17);
    expect(percentile(values, 95)).toBe(100);
    expect(summary).not.toBeNull();
    expect(summary?.count).toBe(5);
    expect(summary?.meanMs).toBeCloseTo(33.6, 10);
    expect(summary?.p50Ms).toBe(17);
    expect(summary?.p95Ms).toBe(100);
    expect(summary?.minMs).toBe(15);
    expect(summary?.maxMs).toBe(100);
    expect(summary?.fps).toBeCloseTo(1000 / 33.6, 10);
  });

  it("[E3] percentile and summary handle empty, single and invalid samples", () => {
    expect(percentile([], 50)).toBeNull();
    expect(summarizeFrameTimes([])).toBeNull();
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);

    const single = summarizeFrameTimes([16.7]);
    expect(single?.p50Ms).toBe(16.7);
    expect(single?.p95Ms).toBe(16.7);

    const filtered = summarizeFrameTimes([16, Number.NaN, -1, Number.POSITIVE_INFINITY, 17]);
    expect(filtered?.count).toBe(2);
    expect(filtered?.meanMs).toBe(16.5);
  });
});

describe("[E3] sampler warm-up, discard and measurement window", () => {
  it("[E3] warms up 2 s, discards 30 frames, then measures 10 s by default", () => {
    expect(E3_SAMPLING_PLAN.warmupMs).toBe(2_000);
    expect(E3_SAMPLING_PLAN.measureMs).toBe(10_000);
    expect(E3_SAMPLING_PLAN.discardFrames).toBe(30);
    expect(E3_WARMUP_MS).toBe(2_000);
    expect(E3_MEASURE_MS).toBe(10_000);
    expect(E3_DISCARD_FRAMES).toBe(30);
  });

  it("[E3] collects only frames after the warm-up and discard phases", () => {
    const sampler = new FrameSampler({
      warmupMs: 100,
      measureMs: 500,
      discardFrames: 3,
    });

    // 10 ms frames. t=0 establishes the origin; t=100 starts the window.
    for (let timestamp = 0; timestamp <= 1_000; timestamp += 10) {
      sampler.push(timestamp, 1, 1_000);
    }

    // Measurement starts at t=100. Frames t=100, 110, 120 are discarded,
    // t=130..t=600 are collected (48 frames), and t=600 closes the window.
    expect(sampler.currentPhase).toBe("done");
    expect(sampler.sampleCount).toBe(48);
    expect(sampler.discardedFrames).toBe(3);

    const summary = sampler.getSummary();
    expect(summary).not.toBeNull();
    expect(summary?.frames).toBe(48);
    expect(summary?.frameTimeMs.meanMs).toBeCloseTo(10, 10);
    expect(summary?.frameTimeMs.p50Ms).toBe(10);
    expect(summary?.frameTimeMs.p95Ms).toBe(10);
    expect(summary?.drawCallsPerFrame).toBe(1);
    expect(summary?.totalDrawCalls).toBe(48);
    expect(summary?.visibleInstances).toBe(1_000);
  });

  it("[E3] the first frame never yields a delta and duplicate timestamps are ignored", () => {
    const sampler = new FrameSampler({ warmupMs: 0, measureMs: 100, discardFrames: 0 });
    expect(sampler.push(0).collected).toBe(false);
    expect(sampler.push(0).collected).toBe(false);
    expect(sampler.push(10).collected).toBe(true);
    expect(sampler.sampleCount).toBe(1);
  });

  it("[E3] stop freezes the sampler and keeps partial samples", () => {
    const sampler = new FrameSampler({ warmupMs: 0, measureMs: 1_000, discardFrames: 0 });
    for (let timestamp = 0; timestamp <= 50; timestamp += 10) {
      sampler.push(timestamp);
    }
    const kept = sampler.sampleCount;
    expect(kept).toBeGreaterThan(0);

    sampler.stop();
    expect(sampler.currentPhase).toBe("stopped");
    expect(sampler.isFinished).toBe(true);
    const afterStop = sampler.push(60);
    expect(afterStop.collected).toBe(false);
    expect(sampler.sampleCount).toBe(kept);
    expect(sampler.getSummary()?.frames).toBe(kept);
  });

  it("[E3] rejects an invalid sampling plan", () => {
    expect(() => new FrameSampler({ warmupMs: -1, measureMs: 100, discardFrames: 0 })).toThrow(
      RangeError,
    );
    expect(() => new FrameSampler({ warmupMs: 0, measureMs: 0, discardFrames: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      new FrameSampler({ warmupMs: 0, measureMs: 100, discardFrames: 1.5 }),
    ).toThrow(RangeError);
  });
});

describe("[E3] pass criterion", () => {
  it("[E3] 720p 1k instances meets or misses the 30 fps criterion", () => {
    const pass = evaluatePassCriterion([
      { sceneId: "quads-1k", width: 1280, height: 720, fps: E3_PASS_FPS },
    ]);
    expect(pass.evaluated).toBe(true);
    expect(pass.pass).toBe(true);
    expect(pass.measuredFps).toBe(30);

    const miss = evaluatePassCriterion([
      { sceneId: "quads-1k", width: 1280, height: 720, fps: 29.9 },
    ]);
    expect(miss.evaluated).toBe(true);
    expect(miss.pass).toBe(false);
    expect(miss.reason).toContain("misses");
  });

  it("[E3] a missing or sample-less run cannot read as a pass", () => {
    const missing = evaluatePassCriterion([
      { sceneId: "quads-10k", width: 1280, height: 720, fps: 60 },
    ]);
    expect(missing.evaluated).toBe(false);
    expect(missing.pass).toBe(false);

    const empty = evaluatePassCriterion([
      { sceneId: "quads-1k", width: 1280, height: 720, fps: null },
    ]);
    expect(empty.evaluated).toBe(true);
    expect(empty.pass).toBe(false);
    expect(empty.measuredFps).toBeNull();
  });
});

describe("[PR-9.1] draw-call accounting", () => {
  it("[PR-9.1] draw calls are counted per frame and reset each frame", () => {
    const counter = new DrawCallCounter();

    counter.beginFrame();
    counter.record(3);
    counter.record(1);
    expect(counter.endFrame()).toBe(4);
    expect(counter.lastFrame).toBe(4);

    counter.beginFrame();
    counter.record(2);
    expect(counter.lastFrame).toBe(4);
    expect(counter.endFrame()).toBe(2);

    expect(counter.frames).toBe(2);
    expect(counter.total).toBe(6);
    expect(counter.averagePerFrame).toBe(3);
    expect(() => counter.record(-1)).toThrow(RangeError);
  });

  it("[PR-9.1] every E3 scene stays inside the 120 draw-call budget", () => {
    for (const scene of SCENES) {
      expect(scene.drawCallsPerFrame).toBeLessThanOrEqual(120);
      expect(scene.drawCallsPerFrame).toBeGreaterThan(0);
    }
  });
});

describe("[PR-9.7] visible instances are recorded, not culled", () => {
  it("[PR-9.7] the benchmark does not assume frustum culling", () => {
    for (const scene of SCENES) {
      expect(scene.frustumCulling).toBe(false);
      if (scene.kind === "instanced-quads") {
        expect(scene.visibleInstances).toBe(scene.instances);
      }
    }
  });

  it("[PR-9.7] run results carry the visible-instance count", () => {
    const plan = buildRunPlan()[0];
    expect(plan).toBeDefined();
    if (plan === undefined) return;

    const result = createRunResult({
      plan,
      status: "skipped",
      summary: null,
      gpuTimes: [],
      gpuTimerAvailable: false,
      note: "not run",
    });
    expect(result.visibleInstances).toBe(plan.scene.visibleInstances);
    expect(result.visibleInstances).toBe(1_000);
  });
});

describe("[G2] frame-time baseline for the latency budget", () => {
  it("[G2] p95 frame time and draw-call throughput are exposed for budgeting", () => {
    const summary: SamplerSummary = {
      frames: 2,
      frameTimeMs: {
        count: 2,
        meanMs: 20,
        p50Ms: 16,
        p95Ms: 24,
        minMs: 16,
        maxMs: 24,
        fps: 50,
      },
      drawCallsPerFrame: 1,
      totalDrawCalls: 2,
      visibleInstances: 1_000,
      longFrames: 0,
    };
    const plan = buildRunPlan()[0];
    expect(plan).toBeDefined();
    if (plan === undefined) return;

    const result = createRunResult({
      plan,
      status: "ok",
      summary,
      gpuTimes: [5, 6],
      gpuTimerAvailable: true,
      note: null,
    });

    expect(result.fps).toBe(50);
    expect(result.frameTimeMs?.p50).toBe(16);
    expect(result.frameTimeMs?.p95).toBe(24);
    expect(result.drawCallsPerFrame).toBe(1);
    expect(result.drawCallsPerSecond).toBe(50);
    expect(drawCallThroughput(1, 50)).toBe(50);

    // GPU times are supplemental and use the same nearest-rank summary.
    expect(result.gpuTimeMs?.count).toBe(2);
    expect(result.gpuTimeMs?.mean).toBe(5.5);
    expect(result.gpuTimeMs?.p50).toBe(5);
    expect(result.gpuTimeMs?.p95).toBe(6);
  });
});

describe("[E3] GPU memory estimate", () => {
  it("[E3] the atlas estimate includes every mip level", () => {
    expect(atlasTextureBytes(2048)).toBe(22_369_620);
    expect(atlasTextureBytes(1)).toBe(4);
  });

  it("[E3] scene estimates cover buffers, atlas and framebuffer", () => {
    const quads = SCENES[0];
    expect(quads).toBeDefined();
    if (quads === undefined) return;
    expect(sceneGpuMemoryBytes(quads)).toBe(64 + 1_000 * 24 + 22_369_620);

    const mesh = SCENES[3];
    expect(mesh).toBeDefined();
    if (mesh === undefined) return;
    expect(MESH_VERTEX_COUNT).toBe(501_501);
    expect(MESH_TRIANGLE_COUNT).toBe(1_000_000);
    expect(sceneGpuMemoryBytes(mesh)).toBe(501_501 * 24 + 1_000_000 * 3 * 4);

    const plan = buildRunPlan()[0];
    expect(plan).toBeDefined();
    if (plan === undefined) return;
    const result = createRunResult({
      plan,
      status: "skipped",
      summary: null,
      gpuTimes: [],
      gpuTimerAvailable: false,
    });
    expect(result.sceneGpuMemoryMB).toBe(bytesToMB(sceneGpuMemoryBytes(quads)));
    expect(result.framebufferMB).toBe(bytesToMB(1280 * 720 * 8));
    expect(result.estimatedGpuMemoryMB).toBe(
      bytesToMB(sceneGpuMemoryBytes(quads) + 1280 * 720 * 8),
    );
  });
});

describe("[E3] run plan", () => {
  it("[E3] covers five scenes at 720p and 1080p in DPR 1 sizes", () => {
    const plan = buildRunPlan();
    expect(SCENES).toHaveLength(5);
    expect(plan).toHaveLength(10);
    expect(plan.filter((run) => run.resolution.label === "720p")).toHaveLength(5);
    expect(plan.filter((run) => run.resolution.label === "1080p")).toHaveLength(5);
    expect(plan[0]?.resolution.width).toBe(1280);
    expect(plan[0]?.resolution.height).toBe(720);
    expect(plan[1]?.resolution.width).toBe(1920);
    expect(plan[1]?.resolution.height).toBe(1080);
  });

  it("[E3] the generated browser stats module matches the TypeScript source", async () => {
    const source = await import("../stats.ts");
    const generated = await import("../stats.js");
    const values = [15, 16, 17, 20, 100];

    expect(generated.percentile(values, 50)).toBe(source.percentile(values, 50));
    expect(generated.percentile(values, 95)).toBe(source.percentile(values, 95));
    expect(generated.summarizeFrameTimes(values)).toEqual(source.summarizeFrameTimes(values));
    expect(generated.E3_SAMPLING_PLAN).toEqual(source.E3_SAMPLING_PLAN);
  });
});
