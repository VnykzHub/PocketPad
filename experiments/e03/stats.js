/* Generated from stats.ts by experiments/e03/build.mjs. Do not edit directly. */
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const E3_RESULT_SCHEMA_VERSION = 1;
const E3_ATLAS_SIZE = 2048;
const E3_ATLAS_CELLS = 16;
const E3_WARMUP_MS = 2e3;
const E3_MEASURE_MS = 1e4;
const E3_DISCARD_FRAMES = 30;
const E3_PASS_FPS = 30;
const E3_PASS_SCENE_ID = "quads-1k";
const E3_PASS_WIDTH = 1280;
const E3_PASS_HEIGHT = 720;
const E3_SAMPLING_PLAN = Object.freeze({
  warmupMs: E3_WARMUP_MS,
  measureMs: E3_MEASURE_MS,
  discardFrames: E3_DISCARD_FRAMES
});
const MESH_QUAD_COLUMNS = 1e3;
const MESH_QUAD_ROWS = 500;
const MESH_VERTEX_COUNT = (MESH_QUAD_COLUMNS + 1) * (MESH_QUAD_ROWS + 1);
const MESH_TRIANGLE_COUNT = MESH_QUAD_COLUMNS * MESH_QUAD_ROWS * 2;
const MESH_BYTES_PER_VERTEX = 24;
const MESH_INDEX_BYTES = 4;
const QUAD_VERTEX_BYTES = 64;
const INSTANCE_BYTES = 24;
const SCENES = Object.freeze([
  {
    id: "quads-1k",
    label: "1,000 instanced quads",
    kind: "instanced-quads",
    instances: 1e3,
    visibleInstances: 1e3,
    trianglesPerFrame: 2e3,
    drawCallsPerFrame: 1,
    usesAtlas: true,
    frustumCulling: false,
    description: "1,000 quads in one instanced draw call, every quad sampling the 2048x2048 atlas."
  },
  {
    id: "quads-5k",
    label: "5,000 instanced quads",
    kind: "instanced-quads",
    instances: 5e3,
    visibleInstances: 5e3,
    trianglesPerFrame: 1e4,
    drawCallsPerFrame: 1,
    usesAtlas: true,
    frustumCulling: false,
    description: "5,000 quads in one instanced draw call, every quad sampling the 2048x2048 atlas."
  },
  {
    id: "quads-10k",
    label: "10,000 instanced quads",
    kind: "instanced-quads",
    instances: 1e4,
    visibleInstances: 1e4,
    trianglesPerFrame: 2e4,
    drawCallsPerFrame: 1,
    usesAtlas: true,
    frustumCulling: false,
    description: "10,000 quads in one instanced draw call, every quad sampling the 2048x2048 atlas."
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
    description: "One indexed static mesh, 1,000,000 triangles, submitted in one draw call."
  },
  {
    id: "atlas-2048",
    label: "2048x2048 atlas stress",
    kind: "instanced-quads",
    instances: 1e4,
    visibleInstances: 1e4,
    trianglesPerFrame: 2e4,
    drawCallsPerFrame: 1,
    usesAtlas: true,
    frustumCulling: false,
    description: "10,000 small quads sampling distinct cells of the mipmapped 2048x2048 atlas, so the frame touches the whole atlas at small texel footprints."
  }
]);
const E3_RESOLUTIONS = Object.freeze([
  { label: "720p", width: 1280, height: 720 },
  { label: "1080p", width: 1920, height: 1080 }
]);
function buildRunPlan(scenes = SCENES, resolutions = E3_RESOLUTIONS) {
  const runs = [];
  for (const scene of scenes) {
    for (const resolution of resolutions) {
      runs.push({ scene, resolution });
    }
  }
  return runs;
}
function percentile(values, p) {
  var _a;
  if (values.length === 0) return null;
  if (!Number.isFinite(p) || p <= 0 || p > 100) {
    throw new RangeError(`percentile p must be in (0, 100], received ${String(p)}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p / 100 * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return (_a = sorted[index]) != null ? _a : null;
}
function summarizeFrameTimes(values) {
  var _a, _b;
  const sane = [];
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
  const p50 = (_a = percentile(sane, 50)) != null ? _a : 0;
  const p95 = (_b = percentile(sane, 95)) != null ? _b : 0;
  return {
    count: sane.length,
    meanMs: mean,
    p50Ms: p50,
    p95Ms: p95,
    minMs: min,
    maxMs: max,
    fps: mean > 0 ? 1e3 / mean : 0
  };
}
function drawCallThroughput(drawCallsPerFrame, fps) {
  return drawCallsPerFrame * fps;
}
class FrameSampler {
  constructor(plan = E3_SAMPLING_PLAN) {
    __publicField(this, "plan");
    __publicField(this, "phase", "warmup");
    __publicField(this, "collected", []);
    __publicField(this, "discarded", 0);
    __publicField(this, "firstTimestampMs", null);
    __publicField(this, "measureStartedAtMs", null);
    __publicField(this, "lastTimestampMs", null);
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
  get currentPhase() {
    return this.phase;
  }
  get sampleCount() {
    return this.collected.length;
  }
  get discardedFrames() {
    return this.discarded;
  }
  get isFinished() {
    return this.phase === "done" || this.phase === "stopped";
  }
  /** Stops the run; collected samples stay available for a partial result. */
  stop() {
    if (this.phase !== "done" && this.phase !== "stopped") {
      this.phase = "stopped";
    }
  }
  /**
   * Feeds one rAF timestamp. Returns whether this frame produced a sample.
   * The first frame establishes the origin and never yields a delta.
   */
  push(timestampMs, drawCalls = 1, visibleInstances = 0) {
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
        visibleInstances
      });
      const measuredFor = this.measureStartedAtMs === null ? 0 : timestampMs - this.measureStartedAtMs;
      if (measuredFor >= this.plan.measureMs) {
        this.phase = "done";
      }
      return { phase: this.phase, collected: true };
    }
    return { phase: this.phase, collected: false };
  }
  /** Read-only copy of the collected samples. */
  getSamples() {
    return this.collected.slice();
  }
  /** Aggregates collected samples; null until at least one frame was kept. */
  getSummary(longFrameMs = 100) {
    if (this.collected.length === 0) return null;
    const frameTimes = [];
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
      longFrames
    };
  }
}
function atlasTextureBytes(size = E3_ATLAS_SIZE) {
  let bytes = 0;
  let level = Math.max(1, Math.floor(size));
  while (level >= 1) {
    bytes += level * level * 4;
    if (level === 1) break;
    level = Math.floor(level / 2);
  }
  return bytes;
}
function framebufferBytes(width, height) {
  return width * height * 4 * 2;
}
function bytesToMB(bytes) {
  return Math.round(bytes / (1024 * 1024) * 100) / 100;
}
function sceneGpuMemoryBytes(scene) {
  if (scene.kind === "static-mesh") {
    return MESH_VERTEX_COUNT * MESH_BYTES_PER_VERTEX + MESH_TRIANGLE_COUNT * 3 * MESH_INDEX_BYTES;
  }
  return QUAD_VERTEX_BYTES + scene.instances * INSTANCE_BYTES + (scene.usesAtlas ? atlasTextureBytes() : 0);
}
function createRunResult(measurement) {
  var _a;
  const { plan, summary } = measurement;
  const { scene, resolution } = plan;
  const sceneBytes = sceneGpuMemoryBytes(scene);
  const targetBytes = framebufferBytes(resolution.width, resolution.height);
  const gpuStats = summarizeFrameTimes(measurement.gpuTimes);
  const instancesPerDrawCall = summary === null || summary.drawCallsPerFrame <= 0 ? scene.instances : scene.instances / summary.drawCallsPerFrame;
  return {
    sceneId: scene.id,
    sceneLabel: scene.label,
    kind: scene.kind,
    width: resolution.width,
    height: resolution.height,
    resolutionLabel: resolution.label,
    framesMeasured: summary === null ? 0 : summary.frames,
    frameTimeMs: summary === null ? null : {
      mean: summary.frameTimeMs.meanMs,
      p50: summary.frameTimeMs.p50Ms,
      p95: summary.frameTimeMs.p95Ms,
      min: summary.frameTimeMs.minMs,
      max: summary.frameTimeMs.maxMs
    },
    fps: summary === null ? null : summary.frameTimeMs.fps,
    drawCallsPerFrame: summary === null ? 0 : summary.drawCallsPerFrame,
    totalDrawCalls: summary === null ? 0 : summary.totalDrawCalls,
    drawCallsPerSecond: summary === null ? null : drawCallThroughput(summary.drawCallsPerFrame, summary.frameTimeMs.fps),
    visibleInstances: summary === null ? scene.visibleInstances : summary.visibleInstances,
    trianglesPerFrame: scene.trianglesPerFrame,
    instancesPerDrawCall,
    gpuTimeMs: gpuStats === null ? null : {
      count: gpuStats.count,
      mean: gpuStats.meanMs,
      p50: gpuStats.p50Ms,
      p95: gpuStats.p95Ms
    },
    gpuTimerAvailable: measurement.gpuTimerAvailable,
    sceneGpuMemoryMB: bytesToMB(sceneBytes),
    framebufferMB: bytesToMB(targetBytes),
    estimatedGpuMemoryMB: bytesToMB(sceneBytes + targetBytes),
    longFrames: summary === null ? 0 : summary.longFrames,
    status: measurement.status,
    note: (_a = measurement.note) != null ? _a : null
  };
}
function evaluatePassCriterion(runs) {
  const base = {
    thresholdFps: E3_PASS_FPS,
    sceneId: E3_PASS_SCENE_ID,
    width: E3_PASS_WIDTH,
    height: E3_PASS_HEIGHT
  };
  let target = null;
  for (const run of runs) {
    if (run.sceneId === E3_PASS_SCENE_ID && run.width === E3_PASS_WIDTH && run.height === E3_PASS_HEIGHT) {
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
      reason: `No ${E3_PASS_SCENE_ID} run at ${E3_PASS_WIDTH}x${E3_PASS_HEIGHT} was recorded.`
    };
  }
  if (target.fps === null) {
    return {
      ...base,
      evaluated: true,
      pass: false,
      measuredFps: null,
      reason: "The 720p 1k-instance run produced no frame samples."
    };
  }
  const pass = target.fps >= E3_PASS_FPS;
  return {
    ...base,
    evaluated: true,
    pass,
    measuredFps: target.fps,
    reason: pass ? `${target.fps.toFixed(2)} fps meets the ${E3_PASS_FPS} fps criterion.` : `${target.fps.toFixed(2)} fps misses the ${E3_PASS_FPS} fps criterion.`
  };
}
class DrawCallCounter {
  constructor() {
    __publicField(this, "currentFrameCalls", 0);
    __publicField(this, "totalCalls", 0);
    __publicField(this, "frameCount", 0);
    __publicField(this, "lastFrameCalls", 0);
  }
  beginFrame() {
    this.currentFrameCalls = 0;
  }
  record(count = 1) {
    if (!Number.isFinite(count) || count < 0) {
      throw new RangeError(`draw call count must be non-negative, received ${String(count)}`);
    }
    this.currentFrameCalls += count;
    this.totalCalls += count;
  }
  endFrame() {
    this.lastFrameCalls = this.currentFrameCalls;
    this.frameCount += 1;
    this.currentFrameCalls = 0;
    return this.lastFrameCalls;
  }
  get lastFrame() {
    return this.lastFrameCalls;
  }
  get total() {
    return this.totalCalls;
  }
  get frames() {
    return this.frameCount;
  }
  get averagePerFrame() {
    return this.frameCount === 0 ? 0 : this.totalCalls / this.frameCount;
  }
}
function formatRunRow(result) {
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
    result.gpuTimeMs === null ? "-" : `${result.gpuTimeMs.p50.toFixed(2)} / ${result.gpuTimeMs.p95.toFixed(2)}`,
    result.estimatedGpuMemoryMB.toFixed(2),
    result.status
  ];
}
export {
  DrawCallCounter,
  E3_ATLAS_CELLS,
  E3_ATLAS_SIZE,
  E3_DISCARD_FRAMES,
  E3_MEASURE_MS,
  E3_PASS_FPS,
  E3_PASS_HEIGHT,
  E3_PASS_SCENE_ID,
  E3_PASS_WIDTH,
  E3_RESOLUTIONS,
  E3_RESULT_SCHEMA_VERSION,
  E3_SAMPLING_PLAN,
  E3_WARMUP_MS,
  FrameSampler,
  INSTANCE_BYTES,
  MESH_BYTES_PER_VERTEX,
  MESH_INDEX_BYTES,
  MESH_QUAD_COLUMNS,
  MESH_QUAD_ROWS,
  MESH_TRIANGLE_COUNT,
  MESH_VERTEX_COUNT,
  QUAD_VERTEX_BYTES,
  SCENES,
  atlasTextureBytes,
  buildRunPlan,
  bytesToMB,
  createRunResult,
  drawCallThroughput,
  evaluatePassCriterion,
  formatRunRow,
  framebufferBytes,
  percentile,
  sceneGpuMemoryBytes,
  summarizeFrameTimes
};
