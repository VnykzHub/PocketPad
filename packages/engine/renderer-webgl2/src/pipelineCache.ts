/**
 * Pipeline and program cache (05 §4.2, §5.8).
 *
 * The key is the exact string `"pipeline/1|" + programId|colorFormat|…`; its
 * FNV-1a 32 hash is carried alongside for compact logging. Programs are the
 * fixed forward-lit variants only and are compiled at init, never in a frame.
 * A compile/link failure is recorded and rethrown, never retried in a frame.
 *
 * The M0 WebGL2 pass renders the default swapchain target only, so every
 * built-in pipeline uses `colorFormat: "swapchain"` and `depth24plus`.
 */

import type { AlphaMode } from "@lanpad/engine-core";
import { rendererError } from "./errors.js";
import {
  FORWARD_DEFINES,
  FRAME_UBO_BINDING,
  MATERIAL_UBO_BINDING,
  forwardLitFragmentSource,
  forwardLitVertexSource,
} from "./shaders/forwardLit.js";
import type { MeshLayoutId } from "./mesh.js";
import type { MutableRenderStats } from "./stats.js";
import type { StateCache } from "./state.js";

export const PROGRAM_FORWARD_LIT_ID = "forward-lit";
export const SWAPCHAIN_COLOR_FORMAT = "swapchain";
export const DEFAULT_DEPTH_FORMAT = "depth24plus";
export const MAX_PIPELINES = 128;
export const PIPELINE_VARIANT_COUNT = 24;

export type CullMode = "none" | "back" | "front";

export interface PipelineKeyParts {
  readonly programId: string;
  readonly colorFormat: string;
  readonly depthFormat: string;
  readonly blendMode: string;
  readonly depthTest: boolean;
  readonly depthWrite: boolean;
  readonly cullMode: CullMode;
  readonly topology: string;
  readonly sampleCount: number;
  readonly vertexLayoutId: string;
  readonly defineMask: number;
}

const bit = (value: boolean): string => (value ? "1" : "0");

/** Exact 05 §4.2 key string. Field order is frozen. */
export function pipelineKey(parts: PipelineKeyParts): string {
  return (
    "pipeline/1|" +
    parts.programId +
    "|" +
    parts.colorFormat +
    "|" +
    parts.depthFormat +
    "|" +
    parts.blendMode +
    "|" +
    bit(parts.depthTest) +
    "|" +
    bit(parts.depthWrite) +
    "|" +
    parts.cullMode +
    "|" +
    parts.topology +
    "|" +
    parts.sampleCount +
    "|" +
    parts.vertexLayoutId +
    "|" +
    parts.defineMask
  );
}

/** FNV-1a 32 over the UTF-16 low bytes of an ASCII key. */
export function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const ALPHA_ORDER: readonly AlphaMode[] = ["opaque", "mask", "blend"];

function alphaIndex(alphaMode: AlphaMode): number {
  if (alphaMode === "opaque") return 0;
  if (alphaMode === "mask") return 1;
  return 2;
}

function layoutIndex(layout: MeshLayoutId): number {
  return layout === "instanced-transform-v1" ? 1 : 0;
}

/**
 * Numeric index into the precompiled default table. Frame sorting uses this
 * integer so it never hashes or allocates in the frame path.
 */
export function pipelineVariantIndex(
  layout: MeshLayoutId,
  alphaMode: AlphaMode,
  unlit: boolean,
  doubleSided: boolean,
): number {
  return (
    layoutIndex(layout) * 12 +
    alphaIndex(alphaMode) * 4 +
    (unlit ? 2 : 0) +
    (doubleSided ? 1 : 0)
  );
}

export function defineMaskFor(layout: MeshLayoutId, alphaMode: AlphaMode, unlit: boolean): number {
  let mask = 0;
  if (layout === "instanced-transform-v1") mask |= FORWARD_DEFINES.USE_INSTANCING;
  if (alphaMode === "mask") mask |= FORWARD_DEFINES.ALPHA_TEST;
  if (unlit) mask |= FORWARD_DEFINES.UNLIT;
  return mask;
}

export interface PipelineGpuRecord {
  readonly key: string;
  readonly hash: number;
  readonly variant: number;
  readonly program: WebGLProgram;
  readonly layout: MeshLayoutId;
  readonly alphaMode: AlphaMode;
  readonly unlit: boolean;
  readonly doubleSided: boolean;
  readonly depthTest: boolean;
  readonly depthWrite: boolean;
  readonly cullMode: CullMode;
  readonly topology: "triangle-list";
  readonly sampleCount: 1;
  readonly defineMask: number;
  /** Resolved once at creation; null for instanced variants. */
  readonly uModelLocation: WebGLUniformLocation | null;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  label: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) {
    throw rendererError("E_PIPELINE_COMPILE", `Could not allocate a shader for ${label}.`);
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  const status = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
  if (status !== true) {
    const log = String(gl.getShaderInfoLog(shader) ?? "").slice(0, 512);
    gl.deleteShader(shader);
    throw rendererError("E_PIPELINE_COMPILE", `${label} failed to compile: ${log}`);
  }
  return shader;
}

export class PipelineCache {
  private readonly gl: WebGL2RenderingContext;
  private readonly state: StateCache;
  private readonly stats: MutableRenderStats;
  private readonly programs = new Map<number, WebGLProgram>();
  private readonly failedMasks = new Map<number, string>();
  private readonly pipelines = new Map<string, PipelineGpuRecord>();
  private readonly defaults: Array<PipelineGpuRecord | null> = [];

  constructor(gl: WebGL2RenderingContext, state: StateCache, stats: MutableRenderStats) {
    this.gl = gl;
    this.state = state;
    this.stats = stats;
    for (let index = 0; index < PIPELINE_VARIANT_COUNT; index += 1) {
      this.defaults.push(null);
    }
    for (let layout = 0; layout < 2; layout += 1) {
      const layoutId: MeshLayoutId =
        layout === 0 ? "static-pbr-v1" : "instanced-transform-v1";
      for (let alpha = 0; alpha < ALPHA_ORDER.length; alpha += 1) {
        const alphaMode = ALPHA_ORDER[alpha] ?? "opaque";
        for (let unlit = 0; unlit < 2; unlit += 1) {
          const mask = defineMaskFor(layoutId, alphaMode, unlit === 1);
          this.program(mask);
          for (let doubleSided = 0; doubleSided < 2; doubleSided += 1) {
            const variant = pipelineVariantIndex(layoutId, alphaMode, unlit === 1, doubleSided === 1);
            const record = this.build(layoutId, alphaMode, unlit === 1, doubleSided === 1, mask, variant);
            this.defaults[variant] = record;
            this.pipelines.set(record.key, record);
            this.stats.pipelinesCreated += 1;
          }
        }
      }
    }
    void this.state;
  }

  /** Precompiled default pipeline for a variant index, or null. */
  defaultPipeline(variant: number): PipelineGpuRecord | null {
    if (variant < 0 || variant >= this.defaults.length) return null;
    return this.defaults[variant] ?? null;
  }

  /** Looks up (and lazily registers) a supported descriptor subset. */
  ensure(parts: PipelineKeyParts): PipelineGpuRecord | null {
    if (
      parts.programId !== PROGRAM_FORWARD_LIT_ID ||
      parts.colorFormat !== SWAPCHAIN_COLOR_FORMAT ||
      parts.depthFormat !== DEFAULT_DEPTH_FORMAT ||
      parts.topology !== "triangle-list" ||
      parts.sampleCount !== 1
    ) {
      return null;
    }
    if (parts.vertexLayoutId !== "static-pbr-v1" && parts.vertexLayoutId !== "instanced-transform-v1") {
      return null;
    }
    if (parts.blendMode !== "opaque" && parts.blendMode !== "mask" && parts.blendMode !== "blend") {
      return null;
    }
    const key = pipelineKey(parts);
    const cached = this.pipelines.get(key);
    if (cached !== undefined) {
      this.stats.pipelineCacheHits += 1;
      return cached;
    }
    if (this.failedMasks.has(parts.defineMask)) {
      this.stats.pipelineMisses += 1;
      return null;
    }
    if (this.pipelines.size >= MAX_PIPELINES) {
      this.stats.pipelineMisses += 1;
      return null;
    }
    const layoutId = parts.vertexLayoutId;
    const alphaMode = parts.blendMode;
    const unlit = (parts.defineMask & FORWARD_DEFINES.UNLIT) !== 0;
    const doubleSided = parts.cullMode === "none";
    const variant = pipelineVariantIndex(layoutId, alphaMode, unlit, doubleSided);
    const program = this.programs.get(parts.defineMask);
    if (program === undefined) {
      this.stats.pipelineMisses += 1;
      return null;
    }
    const record: PipelineGpuRecord = {
      key,
      hash: fnv1a32(key),
      variant,
      program,
      layout: layoutId,
      alphaMode,
      unlit,
      doubleSided,
      depthTest: parts.depthTest,
      depthWrite: parts.depthWrite,
      cullMode: parts.cullMode,
      topology: "triangle-list",
      sampleCount: 1,
      defineMask: parts.defineMask,
      uModelLocation:
        (parts.defineMask & FORWARD_DEFINES.USE_INSTANCING) !== 0
          ? null
          : this.gl.getUniformLocation(program, "uModel"),
    };
    this.pipelines.set(key, record);
    this.stats.pipelineMisses += 1;
    this.stats.pipelinesCreated += 1;
    return record;
  }

  /** Builds a key for a material/mesh pair without touching GL. */
  keyFor(
    layout: MeshLayoutId,
    alphaMode: AlphaMode,
    unlit: boolean,
    doubleSided: boolean,
    depthTest: boolean,
    depthWrite: boolean,
  ): string {
    return pipelineKey({
      programId: PROGRAM_FORWARD_LIT_ID,
      colorFormat: SWAPCHAIN_COLOR_FORMAT,
      depthFormat: DEFAULT_DEPTH_FORMAT,
      blendMode: alphaMode,
      depthTest,
      depthWrite,
      cullMode: doubleSided ? "none" : "back",
      topology: "triangle-list",
      sampleCount: 1,
      vertexLayoutId: layout,
      defineMask: defineMaskFor(layout, alphaMode, unlit),
    });
  }

  get size(): number {
    return this.pipelines.size;
  }

  /** Deletes every GL program; descriptor records are dropped. */
  dispose(): void {
    for (const program of this.programs.values()) {
      this.gl.deleteProgram(program);
    }
    this.programs.clear();
    this.failedMasks.clear();
    this.pipelines.clear();
    for (let index = 0; index < this.defaults.length; index += 1) {
      this.defaults[index] = null;
    }
  }

  private build(
    layout: MeshLayoutId,
    alphaMode: AlphaMode,
    unlit: boolean,
    doubleSided: boolean,
    mask: number,
    variant: number,
  ): PipelineGpuRecord {
    const depthWrite = alphaMode !== "blend";
    const key = pipelineKey({
      programId: PROGRAM_FORWARD_LIT_ID,
      colorFormat: SWAPCHAIN_COLOR_FORMAT,
      depthFormat: DEFAULT_DEPTH_FORMAT,
      blendMode: alphaMode,
      depthTest: true,
      depthWrite,
      cullMode: doubleSided ? "none" : "back",
      topology: "triangle-list",
      sampleCount: 1,
      vertexLayoutId: layout,
      defineMask: mask,
    });
    const program = this.programs.get(mask);
    if (program === undefined) {
      throw rendererError("E_PIPELINE_COMPILE", "Forward-lit program variant is missing.");
    }
    return {
      key,
      hash: fnv1a32(key),
      variant,
      program,
      layout,
      alphaMode,
      unlit,
      doubleSided,
      depthTest: true,
      depthWrite,
      cullMode: doubleSided ? "none" : "back",
      topology: "triangle-list",
      sampleCount: 1,
      defineMask: mask,
      uModelLocation:
        (mask & FORWARD_DEFINES.USE_INSTANCING) !== 0
          ? null
          : this.gl.getUniformLocation(program, "uModel"),
    };
  }

  /**
   * Associates the std140 blocks with their fixed buffer binding indices.
   *
   * GLSL ES 3.00 has no explicit `binding` qualifier for uniform blocks, so
   * every block defaults to index 0. Without this association MaterialBlock
   * and FrameBlock both read the frame UBO: the material base colour becomes a
   * column of the view-projection matrix (camera-dependent colour), unlit
   * output inherits it, and a solid texture can multiply to black.
   */
  private bindUniformBlocks(program: WebGLProgram): void {
    const gl = this.gl;
    const frame = gl.getUniformBlockIndex(program, "FrameBlock");
    if (frame !== gl.INVALID_INDEX) {
      gl.uniformBlockBinding(program, frame, FRAME_UBO_BINDING);
    }
    const material = gl.getUniformBlockIndex(program, "MaterialBlock");
    if (material !== gl.INVALID_INDEX) {
      gl.uniformBlockBinding(program, material, MATERIAL_UBO_BINDING);
    }
  }

  private program(mask: number): WebGLProgram {
    const cached = this.programs.get(mask);
    if (cached !== undefined) return cached;
    const failed = this.failedMasks.get(mask);
    if (failed !== undefined) {
      throw rendererError("E_PIPELINE_COMPILE", failed);
    }
    const vertexSource = forwardLitVertexSource(mask);
    const fragmentSource = forwardLitFragmentSource(mask);
    try {
      const vertex = compileShader(this.gl, this.gl.VERTEX_SHADER, vertexSource, "forward-lit vertex");
      let fragment: WebGLShader;
      try {
        fragment = compileShader(this.gl, this.gl.FRAGMENT_SHADER, fragmentSource, "forward-lit fragment");
      } catch (error) {
        this.gl.deleteShader(vertex);
        throw error;
      }
      const program = this.gl.createProgram();
      if (program === null) {
        this.gl.deleteShader(vertex);
        this.gl.deleteShader(fragment);
        throw rendererError("E_PIPELINE_COMPILE", "Could not allocate a GL program.");
      }
      this.gl.attachShader(program, vertex);
      this.gl.attachShader(program, fragment);
      this.gl.linkProgram(program);
      this.gl.deleteShader(vertex);
      this.gl.deleteShader(fragment);
      const status = this.gl.getProgramParameter(program, this.gl.LINK_STATUS);
      if (status !== true) {
        const log = String(this.gl.getProgramInfoLog(program) ?? "").slice(0, 512);
        this.gl.deleteProgram(program);
        throw rendererError("E_PIPELINE_COMPILE", `forward-lit failed to link: ${log}`);
      }
      this.stats.shaderModulesCreated += 2;
      this.bindUniformBlocks(program);
      this.programs.set(mask, program);
      return program;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failedMasks.set(mask, message);
      throw error;
    }
  }
}
