/**
 * Pure scene data, frame-time statistics and stop logic for E3 (D1-EXP-04).
 *
 * No DOM, WebGL or timer access lives here. `bench.ts` drives the real
 * rendering and feeds timestamps into `FrameSampler`; tests exercise this
 * module in Node so the measurement rules (p50/p95, warm-up, discard window,
 * 10 s measurement, stop request) are verified without a GPU.
 */

/** Bumped only when the result shape changes in a way consumers must notice. */
export const E3_RESULT_SCHEMA_VERSION = 1;

/** Atlas edge length in pixels (work item: one 2048x2048 texture atlas). */
export const E3_ATLAS_SIZE = 2048;
/** Atlas is split into a 16x16 grid of cells that instances sample. */
export const E3_ATLAS_CELLS = 16;

/** Warm up for 2 s before measuring (E3 step 3). */
export const E3_WARMUP_MS = 2_000;
/** Measure each scene for 10 s (E3 scenes paragraph). */
export const E3_MEASURE_MS = 10_000;
/** Discard the first 30 frames after warm-up (E3 step 3). */
export const E3_DISCARD_FRAMES = 30;
/** Pass criterion: at least 30 fps at 720p with 1k+ instances. */
export const E3_PASS_FPS = 30;
export const E3_PASS_SCENE_ID = "quads-1k";
export const E3_PASS_WIDTH = 1280;
export const E3_PASS_HEIGHT = 720;

export interface SamplingPlan {
  warmupMs: number;
  measureMs: number;
  discardFrames: number;
}

export const E3_SAMPLING_PLAN: Readonly<SamplingPlan> = Object.freeze({
  warmupMs: E3_WARMUP_MS,
  measureMs: E3_MEASURE_MS,
  discardFrames: E3_DISCARD_FRAMES,
});

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/**
 * Static-mesh grid: 1000 x 500 quads = exactly 1,000,000 triangles, with
 * shared vertices (1001 x 501) so the mesh is one indexed draw call.
 */
export const MESH_QUAD_COLUMNS = 1_000;
export const MESH_QUAD_ROWS = 500;
export const MESH_VERTEX_COUNT = (MESH_QUAD_COLUMNS + 1) * (MESH_QUAD_ROWS + 1);
export const MESH_TRIANGLE_COUNT = MESH_QUAD_COLUMNS * MESH_QUAD_ROWS * 2;
/** position (vec3) + normal (vec3), float32 each. */
export const MESH_BYTES_PER_VERTEX = 24;
/** WebGL2 core supports 32-bit indices; the grid has 501,501 vertices. */
export const MESH_INDEX_BYTES = 4;

/** One quad: 4 corners x (vec2 position + vec2 uv) x float32. */
export const QUAD_VERTEX_BYTES = 64;
/** One instance: vec2 offset + vec2 size + vec2 atlas cell, float32 each. */
export const INSTANCE_BYTES = 24;

export type SceneKind = "instanced-quads" | "static-mesh";

export interface SceneDefinition {
  id: string;
  label: string;
  kind: SceneKind;
  /** Instances submitted per frame. Static meshes use 1 (the mesh itself). */
  instances: number;
  /**
   * Instances actually rasterised per frame. E3 never enables frustum
   * culling, so this equals `instances`; the field makes the assumption
   * explicit in every result (PR-9.7).
   */
  visibleInstances: number;
  trianglesPerFrame: number;
  drawCallsPerFrame: number;
  usesAtlas: boolean;
  /** E3 does not cull; recorded so D3 cannot assume it was free. */
  frustumCulling: false;
  description: string;
}

export const SCENES: readonly SceneDefinition[] = Object.freeze([
  {
    id: "quads-1k",
    label: "1,000 instanced quads",
    kind: "instanced-quads",
    instances: 1_000,
    visibleInstances: 1_000,
    trianglesPerFrame: 2_000,
    drawCallsPerFrame: 1,
    usesAtlas: true,
    frustumCulling: false,
    description:
      "1,000 quads in one instanced draw call, every quad sampling the 2048x2048 atlas.",
  },
  {
    id: "quads-5k",
    label: "5,000 instanced quads",
    kind: "instanced-quads",
    instances: 5_000,
    visibleInstances: 5_000,
    trianglesPerFrame: 10_000,
    drawCallsPerFrame: 1,
    usesAtlas: true,
    frustumCulling: false,
    description:
      "5,000 quads in one instanced draw call, every quad sampling the 2048x2048 atlas.",
  },
  {
    id: "quads-10k",
    label: "10,000 instanced quads",
    kind: "instanced-quads",
    instances: 10_000,
    visibleInstances: 10_000,
    trianglesPerFrame: 20_000,
    drawCallsPerFrame: 1,
    usesAtlas: true,
    frustumCulling: false,
    description:
      "10,000 quads in one instanced draw call, every quad sampling the 2048x2048 atlas.",
  },
  {
    id: "mesh-1m",
    label: "1,000,000-triangle static mesh",
    kind: "static-mesh",
    instances: 1,
    visibleInstances: 1,
    trianglesPerFrame: MESH_TRIANGLE_COUNT,
    drawCallsPerFrame: 1,
    usesAtlas: false,
    frustumCulling: false,
    description:
      "One indexed static mesh, 1,000,000 triangles, submitted in one draw call.",
  },
  {
    id: "atlas-2048",
    label: "2048x2048 atlas stress",
    kind: "instanced-quads",
    instances: 10_000,
    visibleInstances: 10_000,
    trianglesPerFrame: 20_000,
    drawCallsPerFrame: 1,
    usesAtlas: true,
    frustumCulling: false,
    description:
      "10,000 small quads sampling distinct cells of the mipmapped 2048x2048 atlas, so the frame touches the whole atlas at small texel footprints.",
  },
]);

export interface Resolution {
  label: "720p" | "1080p";
  width: number;
  height: number;
}

export const E3_RESOLUTIONS: readonly Resolution[] = Object.freeze([
  { label: "720p", width: 1280, height: 720 },
  { label: "1080p", width: 1920, height: 1080 },
]);

export interface PlannedRun {
  scene: SceneDefinition;
  resolution: Resolution;
}

/** Ten runs: each scene at 1280x720 and 1920x1080, DPR 1. */
export function buildRunPlan(
  scenes: readonly SceneDefinition[] = SCENES,
  resolutions: readonly Resolution[] = E3_RESOLUTIONS,
): PlannedRun[] {
  const runs: PlannedRun[] = [];
  for (const scene of scenes) {
    for (const resolution of resolutions) {
      runs.push({ scene, resolution });
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentile. `p` is a percentage in (0, 100]; the result is the
 * smallest sample whose rank covers `p` percent of the sorted values. Returns
 * null for an empty sample so callers never invent a number.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  if (!Number.isFinite(p) || p <= 0 || p > 100) {
    throw new RangeError(`percentile p must be in (0, 100], received ${String(p)}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? null;
}

export interface FrameStats {
  count: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  /** Frames per second implied by the mean frame interval. */
  fps: number;
}

/**
 * Summarises non-negative frame intervals. Non-finite and negative samples are
 * ignored. FPS is `1000 / meanMs`, so it reports achieved cadence rather than
 * the display's nominal refresh rate.
 */
export function summarizeFrameTimes(values: readonly number[]): FrameStats | null {
  const sane: number[] = [];
  for (const value of values) {
    if (Number.isFinite(value) && value >= 0) sane.push(value);
  }
  if (sane.length === 0) return null;

  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of sane) {
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  const mean = sum / sane.length;
  const p50 = percentile(sane, 50) ?? 0;
  const p95 = percentile(sane, 95) ?? 0;

  return {
    count: sane.length,
    meanMs: mean,
    p50Ms: p50,
    p95Ms: p95,
    minMs: min,
    maxMs: max,
    fps: mean > 0 ? 1000 / mean : 0,
  };
}

/** Draw-call throughput in calls per second for a measured frame rate. */
export function drawCallThroughput(drawCallsPerFrame: number, fps: number): number {
  return drawCallsPerFrame * fps;
}

// ---------------------------------------------------------------------------
// Frame sampling / stop logic
// ---------------------------------------------------------------------------

export type SamplingPhase = "warmup" | "discard" | "measure" | "done" | "stopped";

export interface FrameSample {
  frameTimeMs: number;
  drawCalls: number;
  visibleInstances: number;
}

export interface SamplerSummary {
  frames: number;
  frameTimeMs: FrameStats;
  drawCallsPerFrame: number;
  totalDrawCalls: number;
  visibleInstances: number;
  /** Frames longer than `longFrameMs`; a tab that lost focus shows these. */
  longFrames: number;
}

export interface SamplerPushResult {
  phase: SamplingPhase;
  collected: boolean;
}

/**
 * Deterministic frame accounting for one benchmark run.
 *
 * Timeline, measured with the rAF timestamps themselves:
 * 1. warm-up until `warmupMs` has elapsed since the first frame;
 * 2. discard the next `discardFrames` frame intervals;
 * 3. collect intervals until `measureMs` has elapsed since phase 2 started.
 *
 * The 10 s window includes the discard frames, matching "run each scene for
 * 10 seconds, discard the first 30 frames". `stop()` freezes the sampler and
 * keeps whatever was collected so a partial run can still be reported.
 */
export class FrameSampler {
  readonly plan: SamplingPlan;
  private phase: SamplingPhase = "warmup";
  private readonly collected: FrameSample[] = [];
  private discarded = 0;
  private firstTimestampMs: number | null = null;
  private measureStartedAtMs: number | null = null;
  private lastTimestampMs: number | null = null;

  constructor(plan: SamplingPlan = E3_SAMPLING_PLAN) {
    if (!Number.isFinite(plan.warmupMs) || plan.warmupMs < 0) {
      throw new RangeError("warmupMs must be a non-negative number");
    }
    if (!Number.isFinite(plan.measureMs) || plan.measureMs <= 0) {
      throw new RangeError("measureMs must be a positive number");
    }
    if (!Number.isInteger(plan.discardFrames) || plan.discardFrames < 0) {
      throw new RangeError("discardFrames must be a non-negative integer");
    }
    this.plan = { ...plan };
  }

  get currentPhase(): SamplingPhase {
    return this.phase;
  }

  get sampleCount(): number {
    return this.collected.length;
  }

  get discardedFrames(): number {
    return this.discarded;
  }

  get isFinished(): boolean {
    return this.phase === "done" || this.phase === "stopped";
  }

  /** Stops the run; collected samples stay available for a partial result. */
  stop(): void {
    if (this.phase !== "done" && this.phase !== "stopped") {
      this.phase = "stopped";
    }
  }

  /**
   * Feeds one rAF timestamp. Returns whether this frame produced a sample.
   * The first frame establishes the origin and never yields a delta.
   */
  push(timestampMs: number, drawCalls = 1, visibleInstances = 0): SamplerPushResult {
    if (this.phase === "done" || this.phase === "stopped") {
      return { phase: this.phase, collected: false };
    }
    if (!Number.isFinite(timestampMs)) {
      return { phase: this.phase, collected: false };
    }

    if (this.firstTimestampMs === null || this.lastTimestampMs === null) {
      this.firstTimestampMs = timestampMs;
      this.lastTimestampMs = timestampMs;
      return { phase: this.phase, collected: false };
    }

    const deltaMs = timestampMs - this.lastTimestampMs;
    this.lastTimestampMs = timestampMs;
    if (deltaMs <= 0) {
      return { phase: this.phase, collected: false };
    }

    if (this.phase === "warmup") {
      if (timestampMs - this.firstTimestampMs < this.plan.warmupMs) {
        return { phase: this.phase, collected: false };
      }
      this.measureStartedAtMs = timestampMs;
      this.phase = this.plan.discardFrames > 0 ? "discard" : "measure";
    }

    if (this.phase === "discard") {
      this.discarded += 1;
      if (this.discarded >= this.plan.discardFrames) {
        this.phase = "measure";
      }
      return { phase: this.phase, collected: false };
    }

    if (this.phase === "measure") {
      this.collected.push({
        frameTimeMs: deltaMs,
        drawCalls,
        visibleInstances,
      });
      const measuredFor =
        this.measureStartedAtMs === null ? 0 : timestampMs - this.measureStartedAtMs;
      if (measuredFor >= this.plan.measureMs) {
        this.phase = "done";
      }
      return { phase: this.phase, collected: true };
    }

    return { phase: this.phase, collected: false };
  }

  /** Read-only copy of the collected samples. */
  getSamples(): readonly FrameSample[] {
    return this.collected.slice();
  }

  /** Aggregates collected samples; null until at least one frame was kept. */
  getSummary(longFrameMs = 100): SamplerSummary | null {
    if (this.collected.length === 0) return null;

    const frameTimes: number[] = [];
    let drawCalls = 0;
    let visibleInstances = 0;
    let longFrames = 0;
    for (const sample of this.collected) {
      frameTimes.push(sample.frameTimeMs);
      drawCalls += sample.drawCalls;
      if (sample.visibleInstances > visibleInstances) {
        visibleInstances = sample.visibleInstances;
      }
      if (sample.frameTimeMs > longFrameMs) longFrames += 1;
    }

    const stats = summarizeFrameTimes(frameTimes);
    if (stats === null) return null;

    return {
      frames: stats.count,
      frameTimeMs: stats,
      drawCallsPerFrame: drawCalls / this.collected.length,
      totalDrawCalls: drawCalls,
      visibleInstances,
      longFrames,
    };
  }
}

// ---------------------------------------------------------------------------
// GPU memory estimate
// ---------------------------------------------------------------------------

/** RGBA8 base level plus the full mip chain, in bytes. */
export function atlasTextureBytes(size: number = E3_ATLAS_SIZE): number {
  let bytes = 0;
  let level = Math.max(1, Math.floor(size));
  while (level >= 1) {
    bytes += level * level * 4;
    if (level === 1) break;
    level = Math.floor(level / 2);
  }
  return bytes;
}

/** Colour (RGBA8) + depth/stencil (4 B/px) attachments, DPR 1. */
export function framebufferBytes(width: number, height: number): number {
  return width * height * 4 * 2;
}

export function bytesToMB(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

/** Estimated scene VRAM: buffers plus the atlas when the scene uses it. */
export function sceneGpuMemoryBytes(scene: SceneDefinition): number {
  if (scene.kind === "static-mesh") {
    return (
      MESH_VERTEX_COUNT * MESH_BYTES_PER_VERTEX +
      MESH_TRIANGLE_COUNT * 3 * MESH_INDEX_BYTES
    );
  }
  return (
    QUAD_VERTEX_BYTES +
    scene.instances * INSTANCE_BYTES +
    (scene.usesAtlas ? atlasTextureBytes() : 0)
  );
}

// ---------------------------------------------------------------------------
// Run results and pass criterion
// ---------------------------------------------------------------------------

export type RunStatus =
  | "pending"
  | "running"
  | "ok"
  | "aborted"
  | "context-lost"
  | "error"
  | "skipped";

export interface BenchmarkRunResult {
  sceneId: string;
  sceneLabel: string;
  kind: SceneKind;
  width: number;
  height: number;
  resolutionLabel: string;
  framesMeasured: number;
  frameTimeMs: {
    mean: number;
    p50: number;
    p95: number;
    min: number;
    max: number;
  } | null;
  fps: number | null;
  drawCallsPerFrame: number;
  totalDrawCalls: number;
  drawCallsPerSecond: number | null;
  visibleInstances: number;
  trianglesPerFrame: number;
  instancesPerDrawCall: number;
  gpuTimeMs: {
    count: number;
    mean: number;
    p50: number;
    p95: number;
  } | null;
  gpuTimerAvailable: boolean;
  sceneGpuMemoryMB: number;
  framebufferMB: number;
  estimatedGpuMemoryMB: number;
  longFrames: number;
  status: RunStatus;
  note: string | null;
}

export interface RunMeasurement {
  plan: PlannedRun;
  status: RunStatus;
  summary: SamplerSummary | null;
  gpuTimes: readonly number[];
  gpuTimerAvailable: boolean;
  note?: string | null;
}

export function createRunResult(measurement: RunMeasurement): BenchmarkRunResult {
  const { plan, summary } = measurement;
  const { scene, resolution } = plan;
  const sceneBytes = sceneGpuMemoryBytes(scene);
  const targetBytes = framebufferBytes(resolution.width, resolution.height);
  const gpuStats = summarizeFrameTimes(measurement.gpuTimes);
  const instancesPerDrawCall =
    summary === null || summary.drawCallsPerFrame <= 0
      ? scene.instances
      : scene.instances / summary.drawCallsPerFrame;

  return {
    sceneId: scene.id,
    sceneLabel: scene.label,
    kind: scene.kind,
    width: resolution.width,
    height: resolution.height,
    resolutionLabel: resolution.label,
    framesMeasured: summary === null ? 0 : summary.frames,
    frameTimeMs:
      summary === null
        ? null
        : {
            mean: summary.frameTimeMs.meanMs,
            p50: summary.frameTimeMs.p50Ms,
            p95: summary.frameTimeMs.p95Ms,
            min: summary.frameTimeMs.minMs,
            max: summary.frameTimeMs.maxMs,
          },
    fps: summary === null ? null : summary.frameTimeMs.fps,
    drawCallsPerFrame: summary === null ? 0 : summary.drawCallsPerFrame,
    totalDrawCalls: summary === null ? 0 : summary.totalDrawCalls,
    drawCallsPerSecond:
      summary === null
        ? null
        : drawCallThroughput(summary.drawCallsPerFrame, summary.frameTimeMs.fps),
    visibleInstances: summary === null ? scene.visibleInstances : summary.visibleInstances,
    trianglesPerFrame: scene.trianglesPerFrame,
    instancesPerDrawCall,
    gpuTimeMs:
      gpuStats === null
        ? null
        : {
            count: gpuStats.count,
            mean: gpuStats.meanMs,
            p50: gpuStats.p50Ms,
            p95: gpuStats.p95Ms,
          },
    gpuTimerAvailable: measurement.gpuTimerAvailable,
    sceneGpuMemoryMB: bytesToMB(sceneBytes),
    framebufferMB: bytesToMB(targetBytes),
    estimatedGpuMemoryMB: bytesToMB(sceneBytes + targetBytes),
    longFrames: summary === null ? 0 : summary.longFrames,
    status: measurement.status,
    note: measurement.note ?? null,
  };
}

export interface PassCriterionResult {
  evaluated: boolean;
  pass: boolean;
  thresholdFps: number;
  sceneId: string;
  width: number;
  height: number;
  measuredFps: number | null;
  reason: string;
}

export interface PassCriterionInput {
  sceneId: string;
  width: number;
  height: number;
  fps: number | null;
}

/**
 * Applies the E3 pass rule: >= 30 fps at 720p with 1k+ instances. A run that
 * exists but has no FPS counts as evaluated and failing; a missing run is
 * reported as not evaluated so a stopped benchmark cannot read as a pass.
 */
export function evaluatePassCriterion(
  runs: readonly PassCriterionInput[],
): PassCriterionResult {
  const base = {
    thresholdFps: E3_PASS_FPS,
    sceneId: E3_PASS_SCENE_ID,
    width: E3_PASS_WIDTH,
    height: E3_PASS_HEIGHT,
  };

  let target: PassCriterionInput | null = null;
  for (const run of runs) {
    if (
      run.sceneId === E3_PASS_SCENE_ID &&
      run.width === E3_PASS_WIDTH &&
      run.height === E3_PASS_HEIGHT
    ) {
      target = run;
      break;
    }
  }

  if (target === null) {
    return {
      ...base,
      evaluated: false,
      pass: false,
      measuredFps: null,
      reason: `No ${E3_PASS_SCENE_ID} run at ${E3_PASS_WIDTH}x${E3_PASS_HEIGHT} was recorded.`,
    };
  }

  if (target.fps === null) {
    return {
      ...base,
      evaluated: true,
      pass: false,
      measuredFps: null,
      reason: "The 720p 1k-instance run produced no frame samples.",
    };
  }

  const pass = target.fps >= E3_PASS_FPS;
  return {
    ...base,
    evaluated: true,
    pass,
    measuredFps: target.fps,
    reason: pass
      ? `${target.fps.toFixed(2)} fps meets the ${E3_PASS_FPS} fps criterion.`
      : `${target.fps.toFixed(2)} fps misses the ${E3_PASS_FPS} fps criterion.`,
  };
}

// ---------------------------------------------------------------------------
// Draw-call accounting
// ---------------------------------------------------------------------------

/**
 * Per-frame draw-call counter. `beginFrame()` resets the current frame,
 * `record()` adds the calls issued by that frame, and `endFrame()` returns the
 * frame's total and folds it into the run total. Resetting per frame is what
 * makes the reported number a per-frame count rather than a run total.
 */
export class DrawCallCounter {
  private currentFrameCalls = 0;
  private totalCalls = 0;
  private frameCount = 0;
  private lastFrameCalls = 0;

  beginFrame(): void {
    this.currentFrameCalls = 0;
  }

  record(count = 1): void {
    if (!Number.isFinite(count) || count < 0) {
      throw new RangeError(`draw call count must be non-negative, received ${String(count)}`);
    }
    this.currentFrameCalls += count;
    this.totalCalls += count;
  }

  endFrame(): number {
    this.lastFrameCalls = this.currentFrameCalls;
    this.frameCount += 1;
    this.currentFrameCalls = 0;
    return this.lastFrameCalls;
  }

  get lastFrame(): number {
    return this.lastFrameCalls;
  }

  get total(): number {
    return this.totalCalls;
  }

  get frames(): number {
    return this.frameCount;
  }

  get averagePerFrame(): number {
    return this.frameCount === 0 ? 0 : this.totalCalls / this.frameCount;
  }
}

/** Formats a run result for one table row; pure and shared with tests. */
export function formatRunRow(result: BenchmarkRunResult): string[] {
  const frame = result.frameTimeMs;
  return [
    result.sceneId,
    `${result.width}x${result.height}`,
    String(result.framesMeasured),
    frame === null ? "-" : frame.mean.toFixed(2),
    frame === null ? "-" : frame.p50.toFixed(2),
    frame === null ? "-" : frame.p95.toFixed(2),
    result.fps === null ? "-" : result.fps.toFixed(2),
    result.drawCallsPerFrame.toFixed(2),
    result.drawCallsPerSecond === null ? "-" : result.drawCallsPerSecond.toFixed(2),
    String(result.visibleInstances),
    result.gpuTimeMs === null
      ? "-"
      : `${result.gpuTimeMs.p50.toFixed(2)} / ${result.gpuTimeMs.p95.toFixed(2)}`,
    result.estimatedGpuMemoryMB.toFixed(2),
    result.status,
  ];
}
