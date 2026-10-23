/**
 * Frame command recording, frustum culling and stable ordering (05 §5.3–§5.4).
 *
 * A frame is a fixed pool: no allocation and no closures. Draws append to
 * parallel arrays; `finish` culls against the camera frustum, compacts kept
 * instance transforms inside their command slice, and stable-sorts command
 * indices. Opaque commands sort by pipeline → material → mesh → depth; blended
 * commands sort depth-descending first. The device draws in `order`.
 *
 * The backend-wide "never culls" line in 05 §5.4 conflicts with 04 §5.12 and
 * the M0 acceptance; this recorder culls spheres and reports the deviation.
 */

import type { Mat4 } from "@lanpad/engine-core";
import type { MaterialGpuRecord } from "./material.js";
import type { MeshGpuRecord } from "./mesh.js";
import { pipelineVariantIndex } from "./pipelineCache.js";
import type { MutableRenderStats } from "./stats.js";

export const MAX_COMMANDS = 4096;
export const MAX_FRAME_INSTANCES = 16384;
const FLOATS_PER_INSTANCE = 16;
const PLANE_COUNT = 6;
const PLANE_COMPONENTS = 4;

export type CommandKind = 0 | 1;

/**
 * Reusable frame recorder. The public `RenderFrame` is a thin view over this
 * class; device code calls the internal `record*` methods with resolved
 * records and handle indices for sorting.
 */
export class FrameRecorder {
  private stats: MutableRenderStats;
  private readonly viewProjection = new Float32Array(FLOATS_PER_INSTANCE);
  private readonly frustum = new Float64Array(PLANE_COUNT * PLANE_COMPONENTS);
  private readonly meshes: Array<MeshGpuRecord | null> = new Array<MeshGpuRecord | null>(
    MAX_COMMANDS,
  ).fill(null);
  private readonly materials: Array<MaterialGpuRecord | null> = new Array<MaterialGpuRecord | null>(
    MAX_COMMANDS,
  ).fill(null);
  private readonly meshIds = new Uint32Array(MAX_COMMANDS);
  private readonly materialIds = new Uint32Array(MAX_COMMANDS);
  private readonly kinds = new Uint8Array(MAX_COMMANDS);
  private readonly instanceStarts = new Uint32Array(MAX_COMMANDS);
  private readonly instanceCounts = new Uint32Array(MAX_COMMANDS);
  private readonly depthKeys = new Uint32Array(MAX_COMMANDS);
  private readonly variantKeys = new Uint32Array(MAX_COMMANDS);
  private readonly instancePool = new Float32Array(MAX_FRAME_INSTANCES * FLOATS_PER_INSTANCE);
  private readonly order: Uint32Array = new Uint32Array(MAX_COMMANDS);
  private readonly sortScratch: Uint32Array = new Uint32Array(MAX_COMMANDS);
  private readonly keyScratch: Uint32Array = new Uint32Array(MAX_COMMANDS);
  private readonly bucketCounts: Uint32Array = new Uint32Array(65536 + 1);
  private commandCount = 0;
  private instanceCursor = 0;
  private opaqueCount = 0;
  private hasCamera = false;

  constructor(stats: MutableRenderStats) {
    this.stats = stats;
  }

  /** Clears per-frame state. Cumulative counters are untouched. */
  begin(stats: MutableRenderStats): void {
    this.stats = stats;
    this.commandCount = 0;
    this.instanceCursor = 0;
    this.opaqueCount = 0;
    this.hasCamera = false;
  }

  setCamera(viewProjection: Mat4): void {
    const m = viewProjection.m;
    if (m.length < FLOATS_PER_INSTANCE) return;
    for (let index = 0; index < FLOATS_PER_INSTANCE; index += 1) {
      this.viewProjection[index] = m[index] ?? 0;
    }
    this.hasCamera = true;
  }

  recordDraw(
    meshId: number,
    mesh: MeshGpuRecord,
    materialId: number,
    material: MaterialGpuRecord,
    transform: Mat4,
  ): void {
    if (!this.reserveCommand()) return;
    const start = this.reserveInstances(1);
    if (start < 0) {
      this.stats.droppedCommands += 1;
      return;
    }
    const index = this.commandCount;
    const base = start * FLOATS_PER_INSTANCE;
    const m = transform.m;
    for (let float = 0; float < FLOATS_PER_INSTANCE; float += 1) {
      this.instancePool[base + float] = m[float] ?? 0;
    }
    this.meshes[index] = mesh;
    this.materials[index] = material;
    this.meshIds[index] = meshId >>> 0;
    this.materialIds[index] = materialId >>> 0;
    this.kinds[index] = 0;
    this.instanceStarts[index] = start;
    this.instanceCounts[index] = 1;
    this.variantKeys[index] = pipelineVariantIndex(
      mesh.layout,
      material.alphaMode,
      material.unlit,
      material.doubleSided,
    );
    this.commandCount += 1;
  }

  recordDrawInstanced(
    meshId: number,
    mesh: MeshGpuRecord,
    materialId: number,
    material: MaterialGpuRecord,
    transforms: Float32Array,
    count: number,
  ): void {
    if (!Number.isInteger(count) || count < 0) {
      this.stats.droppedCommands += 1;
      return;
    }
    if (count === 0) return;
    if (!this.reserveCommand()) return;
    const start = this.reserveInstances(count);
    if (start < 0) {
      this.stats.droppedCommands += 1;
      return;
    }
    const index = this.commandCount;
    const needed = count * FLOATS_PER_INSTANCE;
    const available = Math.min(needed, transforms.length);
    const base = start * FLOATS_PER_INSTANCE;
    for (let float = 0; float < available; float += 1) {
      this.instancePool[base + float] = transforms[float] ?? 0;
    }
    for (let float = available; float < needed; float += 1) {
      this.instancePool[base + float] = 0;
    }
    this.meshes[index] = mesh;
    this.materials[index] = material;
    this.meshIds[index] = meshId >>> 0;
    this.materialIds[index] = materialId >>> 0;
    this.kinds[index] = 1;
    this.instanceStarts[index] = start;
    this.instanceCounts[index] = count;
    this.variantKeys[index] = pipelineVariantIndex(
      mesh.layout,
      material.alphaMode,
      material.unlit,
      material.doubleSided,
    );
    this.commandCount += 1;
  }

  /** Culls, compacts and sorts; returns the number of drawable commands. */
  finish(): number {
    if (this.commandCount === 0) return 0;
    if (this.hasCamera) {
      this.extractFrustum();
      this.cullAndKey();
    }
    for (let index = 0; index < this.commandCount; index += 1) {
      this.order[index] = index;
    }
    this.partitionByBlend();
    this.sortOpaque();
    this.sortTransparent();
    return this.commandCount;
  }

  get count(): number {
    return this.commandCount;
  }

  meshAt(orderIndex: number): MeshGpuRecord | null {
    return this.meshes[this.order[orderIndex] ?? 0] ?? null;
  }

  materialAt(orderIndex: number): MaterialGpuRecord | null {
    return this.materials[this.order[orderIndex] ?? 0] ?? null;
  }

  kindAt(orderIndex: number): CommandKind {
    return (this.kinds[this.order[orderIndex] ?? 0] ?? 0) === 1 ? 1 : 0;
  }

  instanceStartAt(orderIndex: number): number {
    return this.instanceStarts[this.order[orderIndex] ?? 0] ?? 0;
  }

  instanceCountAt(orderIndex: number): number {
    return this.instanceCounts[this.order[orderIndex] ?? 0] ?? 0;
  }

  /** The pool block for a command; the device uploads from here. */
  instanceBlock(start: number, count: number): Float32Array {
    return this.instancePool.subarray(start * FLOATS_PER_INSTANCE, (start + count) * FLOATS_PER_INSTANCE);
  }

  /** Full pool plus element offsets, so uploads never create a subarray. */
  get instancePoolData(): Float32Array {
    return this.instancePool;
  }

  static instanceFloatOffset(start: number): number {
    return start * FLOATS_PER_INSTANCE;
  }

  static readonly floatsPerInstance = FLOATS_PER_INSTANCE;

  private reserveCommand(): boolean {
    if (this.commandCount >= MAX_COMMANDS) {
      this.stats.droppedCommands += 1;
      return false;
    }
    return true;
  }

  private reserveInstances(count: number): number {
    if (this.instanceCursor + count > MAX_FRAME_INSTANCES) return -1;
    const start = this.instanceCursor;
    this.instanceCursor += count;
    return start;
  }

  private extractFrustum(): void {
    const m = this.viewProjection;
    const f = this.frustum;
    // Gribb–Hartmann for a column-major view-projection matrix, WebGL clip z.
    const row0x = m[0] ?? 0;
    const row0y = m[4] ?? 0;
    const row0z = m[8] ?? 0;
    const row0w = m[12] ?? 0;
    const row1x = m[1] ?? 0;
    const row1y = m[5] ?? 0;
    const row1z = m[9] ?? 0;
    const row1w = m[13] ?? 0;
    const row2x = m[2] ?? 0;
    const row2y = m[6] ?? 0;
    const row2z = m[10] ?? 0;
    const row2w = m[14] ?? 0;
    const row3x = m[3] ?? 0;
    const row3y = m[7] ?? 0;
    const row3z = m[11] ?? 0;
    const row3w = m[15] ?? 0;

    this.writePlane(0, row3x + row0x, row3y + row0y, row3z + row0z, row3w + row0w);
    this.writePlane(1, row3x - row0x, row3y - row0y, row3z - row0z, row3w - row0w);
    this.writePlane(2, row3x + row1x, row3y + row1y, row3z + row1z, row3w + row1w);
    this.writePlane(3, row3x - row1x, row3y - row1y, row3z - row1z, row3w - row1w);
    this.writePlane(4, row3x + row2x, row3y + row2y, row3z + row2z, row3w + row2w);
    this.writePlane(5, row3x - row2x, row3y - row2y, row3z - row2z, row3w - row2w);
    void f;
  }

  private writePlane(plane: number, x: number, y: number, z: number, w: number): void {
    const offset = plane * PLANE_COMPONENTS;
    const length = Math.hypot(x, y, z);
    const scale = length > 0 ? 1 / length : 0;
    this.frustum[offset] = x * scale;
    this.frustum[offset + 1] = y * scale;
    this.frustum[offset + 2] = z * scale;
    this.frustum[offset + 3] = w * scale;
  }

  private sphereVisible(x: number, y: number, z: number, radius: number): boolean {
    const f = this.frustum;
    for (let plane = 0; plane < PLANE_COUNT; plane += 1) {
      const offset = plane * PLANE_COMPONENTS;
      const distance =
        (f[offset] ?? 0) * x +
        (f[offset + 1] ?? 0) * y +
        (f[offset + 2] ?? 0) * z +
        (f[offset + 3] ?? 0);
      if (distance < -radius) return false;
    }
    return true;
  }

  private cullAndKey(): void {
    const pool = this.instancePool;
    for (let command = 0; command < this.commandCount; command += 1) {
      const mesh = this.meshes[command];
      if (mesh === null || mesh === undefined) continue;
      const material = this.materials[command];
      const start = this.instanceStarts[command] ?? 0;
      const count = this.instanceCounts[command] ?? 0;
      const centerX = mesh.bounds.center.x;
      const centerY = mesh.bounds.center.y;
      const centerZ = mesh.bounds.center.z;
      const radius = mesh.bounds.radius;
      let kept = 0;
      for (let instance = 0; instance < count; instance += 1) {
        const source = (start + instance) * FLOATS_PER_INSTANCE;
        const write = (start + kept) * FLOATS_PER_INSTANCE;
        const worldX =
          (pool[source] ?? 0) * centerX +
          (pool[source + 4] ?? 0) * centerY +
          (pool[source + 8] ?? 0) * centerZ +
          (pool[source + 12] ?? 0);
        const worldY =
          (pool[source + 1] ?? 0) * centerX +
          (pool[source + 5] ?? 0) * centerY +
          (pool[source + 9] ?? 0) * centerZ +
          (pool[source + 13] ?? 0);
        const worldZ =
          (pool[source + 2] ?? 0) * centerX +
          (pool[source + 6] ?? 0) * centerY +
          (pool[source + 10] ?? 0) * centerZ +
          (pool[source + 14] ?? 0);
        const scale = Math.max(
          Math.hypot(pool[source] ?? 0, pool[source + 1] ?? 0, pool[source + 2] ?? 0),
          Math.hypot(pool[source + 4] ?? 0, pool[source + 5] ?? 0, pool[source + 6] ?? 0),
          Math.hypot(pool[source + 8] ?? 0, pool[source + 9] ?? 0, pool[source + 10] ?? 0),
        );
        if (!this.sphereVisible(worldX, worldY, worldZ, radius * scale)) {
          this.stats.culledInstances += 1;
          continue;
        }
        if (kept !== instance) {
          for (let float = 0; float < FLOATS_PER_INSTANCE; float += 1) {
            pool[write + float] = pool[source + float] ?? 0;
          }
        }
        kept += 1;
      }
      this.instanceCounts[command] = kept;
      if (kept === 0) {
        // The command is dropped from the sorted draw list.
        this.materials[command] = null;
        continue;
      }
      this.depthKeys[command] = this.depthKeyFor(mesh, start);
      this.variantKeys[command] = pipelineVariantIndex(
        mesh.layout,
        material == null ? "opaque" : material.alphaMode,
        material == null ? false : material.unlit,
        material == null ? false : material.doubleSided,
      );
    }
  }

  private depthKeyFor(mesh: MeshGpuRecord, start: number): number {
    const m = this.viewProjection;
    const pool = this.instancePool;
    const base = start * FLOATS_PER_INSTANCE;
    const x = mesh.bounds.center.x;
    const y = mesh.bounds.center.y;
    const z = mesh.bounds.center.z;
    const worldX =
      (pool[base] ?? 0) * x +
      (pool[base + 4] ?? 0) * y +
      (pool[base + 8] ?? 0) * z +
      (pool[base + 12] ?? 0);
    const worldY =
      (pool[base + 1] ?? 0) * x +
      (pool[base + 5] ?? 0) * y +
      (pool[base + 9] ?? 0) * z +
      (pool[base + 13] ?? 0);
    const worldZ =
      (pool[base + 2] ?? 0) * x +
      (pool[base + 6] ?? 0) * y +
      (pool[base + 10] ?? 0) * z +
      (pool[base + 14] ?? 0);
    const clipZ =
      (m[2] ?? 0) * worldX + (m[6] ?? 0) * worldY + (m[10] ?? 0) * worldZ + (m[14] ?? 0);
    const clipW =
      (m[3] ?? 0) * worldX + (m[7] ?? 0) * worldY + (m[11] ?? 0) * worldZ + (m[15] ?? 0);
    const ndcZ = clipW !== 0 ? clipZ / clipW : 0;
    const normalized = Math.max(0, Math.min(1, (ndcZ + 1) * 0.5));
    return Math.round(normalized * 65535);
  }

  private partitionByBlend(): void {
    const count = this.commandCount;
    this.bucketCounts.fill(0, 0, 2);
    for (let index = 0; index < count; index += 1) {
      const command = this.order[index] ?? 0;
      const material = this.materials[command];
      const bucket = material != null && material.alphaMode === "blend" ? 1 : 0;
      this.bucketCounts[bucket] = (this.bucketCounts[bucket] ?? 0) + 1;
    }
    this.opaqueCount = this.bucketCounts[0] ?? 0;
    let opaqueCursor = 0;
    let blendCursor = this.opaqueCount;
    for (let index = 0; index < count; index += 1) {
      const command = this.order[index] ?? 0;
      const material = this.materials[command];
      const blended = material != null && material.alphaMode === "blend";
      if (blended) {
        this.sortScratch[blendCursor] = command;
        blendCursor += 1;
      } else {
        this.sortScratch[opaqueCursor] = command;
        opaqueCursor += 1;
      }
    }
    this.copyRange(this.sortScratch, this.order, 0, count);
  }

  private sortOpaque(): void {
    const start = 0;
    const end = this.opaqueCount;
    if (end - start < 2) return;
    this.passDepth(start, end, true);
    this.passKey(start, end, this.meshIds);
    this.passKey(start, end, this.materialIds);
    this.passKey(start, end, this.variantKeys);
  }

  private sortTransparent(): void {
    const start = this.opaqueCount;
    const end = this.commandCount;
    if (end - start < 2) return;
    this.passKey(start, end, this.meshIds);
    this.passKey(start, end, this.materialIds);
    this.passKey(start, end, this.variantKeys);
    this.passDepth(start, end, false);
  }

  private passDepth(start: number, end: number, ascending: boolean): void {
    for (let index = start; index < end; index += 1) {
      const command = this.order[index] ?? 0;
      this.keyScratch[index] = this.depthKeys[command] ?? 0;
    }
    this.countingPass(start, end, 65536, ascending);
  }

  private passKey(start: number, end: number, source: Uint32Array): void {
    const bucketCount = Math.min(MAX_COMMANDS, end - start + 1);
    for (let index = start; index < end; index += 1) {
      const command = this.order[index] ?? 0;
      const key = source[command] ?? 0;
      this.keyScratch[index] = key < bucketCount ? key : bucketCount - 1;
    }
    this.countingPass(start, end, bucketCount, true);
  }

  /**
   * Stable counting pass over `order[start,end)` using `keyScratch`. Equal
   * keys keep their incoming order for both ascending and descending modes.
   */
  private countingPass(
    start: number,
    end: number,
    bucketCount: number,
    ascending: boolean,
  ): void {
    if (bucketCount < 1) return;
    const counts = this.bucketCounts;
    counts.fill(0, 0, bucketCount);
    for (let index = start; index < end; index += 1) {
      const key = this.keyScratch[index] ?? 0;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    if (ascending) {
      let offset = start;
      for (let bucket = 0; bucket < bucketCount; bucket += 1) {
        const count = counts[bucket] ?? 0;
        counts[bucket] = offset;
        offset += count;
      }
    } else {
      let offset = end;
      for (let bucket = 0; bucket < bucketCount; bucket += 1) {
        const count = counts[bucket] ?? 0;
        offset -= count;
        counts[bucket] = offset;
      }
    }
    for (let index = start; index < end; index += 1) {
      const command = this.order[index] ?? 0;
      const key = this.keyScratch[index] ?? 0;
      const target = counts[key] ?? 0;
      this.sortScratch[target] = command;
      counts[key] = target + 1;
    }
    this.copyRange(this.sortScratch, this.order, start, end);
  }

  private copyRange(source: Uint32Array, target: Uint32Array, start: number, end: number): void {
    for (let index = start; index < end; index += 1) {
      target[index] = source[index] ?? 0;
    }
  }
}
