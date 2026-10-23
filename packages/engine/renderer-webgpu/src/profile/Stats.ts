/**
 * Stable mutable stats object (04 §5.13). `beginFrame` resets per-frame
 * counters; resource totals, error counts and cache counters are cumulative.
 */

import type { RenderStats } from "@lanpad/engine-core";

export class MutableRenderStats implements RenderStats {
  drawCalls = 0;
  shadowDrawCalls = 0;
  triangles = 0;
  instances = 0;
  culledInstances = 0;
  pipelineSwitches = 0;
  bindGroupSwitches = 0;
  pipelinesCreated = 0;
  pipelineCacheHits = 0;
  shaderModulesCreated = 0;
  textureBytes = 0;
  bufferBytes = 0;
  uploadBytes = 0;
  uploadCalls = 0;
  gpuErrors = 0;
  droppedDraws = 0;
  lodCounts: [number, number, number, number] = [0, 0, 0, 0];
  gpuFrameMs: number | null = null;
  cpuFrameMs = 0;

  beginFrame(): void {
    this.drawCalls = 0;
    this.shadowDrawCalls = 0;
    this.triangles = 0;
    this.instances = 0;
    this.culledInstances = 0;
    this.pipelineSwitches = 0;
    this.bindGroupSwitches = 0;
    this.uploadBytes = 0;
    this.uploadCalls = 0;
    this.droppedDraws = 0;
    this.lodCounts[0] = 0;
    this.lodCounts[1] = 0;
    this.lodCounts[2] = 0;
    this.lodCounts[3] = 0;
    this.cpuFrameMs = 0;
  }
}
