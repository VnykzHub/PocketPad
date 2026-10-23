/**
 * Stable, allocation-free statistics record (05 §5.11, §5.3).
 *
 * The object identity never changes. Per-frame counters reset in
 * `resetFrameStats`; cumulative counters and live byte totals do not.
 */

import type { RenderStats } from "@lanpad/engine-core";

export interface MutableRenderStats {
  drawCalls: number;
  shadowDrawCalls: number;
  triangles: number;
  instances: number;
  culledInstances: number;
  pipelineSwitches: number;
  bindGroupSwitches: number;
  pipelinesCreated: number;
  pipelineCacheHits: number;
  shaderModulesCreated: number;
  textureBytes: number;
  bufferBytes: number;
  uploadBytes: number;
  uploadCalls: number;
  gpuErrors: number;
  droppedDraws: number;
  lodCounts: [number, number, number, number];
  gpuFrameMs: number | null;
  cpuFrameMs: number;
  // Internal counters not carried by the frozen record.
  pipelineMisses: number;
  lostFrames: number;
  staleHandles: number;
  droppedCommands: number;
  textureBinds: number;
  uploadStalls: number;
}

export function createStats(): MutableRenderStats {
  return {
    drawCalls: 0,
    shadowDrawCalls: 0,
    triangles: 0,
    instances: 0,
    culledInstances: 0,
    pipelineSwitches: 0,
    bindGroupSwitches: 0,
    pipelinesCreated: 0,
    pipelineCacheHits: 0,
    shaderModulesCreated: 0,
    textureBytes: 0,
    bufferBytes: 0,
    uploadBytes: 0,
    uploadCalls: 0,
    gpuErrors: 0,
    droppedDraws: 0,
    lodCounts: [0, 0, 0, 0],
    gpuFrameMs: null,
    cpuFrameMs: 0,
    pipelineMisses: 0,
    lostFrames: 0,
    staleHandles: 0,
    droppedCommands: 0,
    textureBinds: 0,
    uploadStalls: 0,
  };
}

/** Resets only the per-frame counters; no allocation. */
export function resetFrameStats(stats: MutableRenderStats): void {
  stats.drawCalls = 0;
  stats.shadowDrawCalls = 0;
  stats.triangles = 0;
  stats.instances = 0;
  stats.culledInstances = 0;
  stats.pipelineSwitches = 0;
  stats.bindGroupSwitches = 0;
  stats.uploadBytes = 0;
  stats.uploadCalls = 0;
  stats.cpuFrameMs = 0;
  stats.lodCounts[0] = 0;
  stats.lodCounts[1] = 0;
  stats.lodCounts[2] = 0;
  stats.lodCounts[3] = 0;
}

/** The object is structurally a `RenderStats`; the cast is total. */
export function statsAsRenderStats(stats: MutableRenderStats): RenderStats {
  return stats;
}
