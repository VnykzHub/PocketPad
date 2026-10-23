/**
 * Probe limit reading, context attributes and the core `DeviceLimits`
 * projection (05 §3.3, §4.5, Appendix A).
 */

import type { DeviceLimits } from "@lanpad/engine-core";
import type {
  WebGL2ContextAttributes,
  WebGL2Limits,
} from "./contracts/webgl2.js";

/** TV profile backing-store height cap (05 §5.11). */
export const TV_MAX_RENDER_HEIGHT = 1080;

/** Design cap: the only ABI-1 vertex buffer count (04 §4.3). */
const ABI_VERTEX_BUFFERS = 2;
const ABI_BIND_GROUPS = 4;
const MIN_UBO_OFFSET_ALIGNMENT = 256;
/** WebGL2 exposes no query for this; the browser cap is far below 2 GiB. */
const MAX_BUFFER_SIZE = 2147483648;

export interface ContextAttributeInput {
  readonly tvProfile: boolean;
  readonly antialias?: boolean;
  readonly depth?: boolean;
  readonly stencil?: boolean;
  readonly powerPreference?: "high-performance" | "default" | "low-power";
  readonly desynchronized?: boolean;
  readonly failIfMajorPerformanceCaveat?: boolean;
}

/**
 * Resolved context attributes. Appendix A fixes the defaults; the caller may
 * override antialias/depth/stencil/powerPreference and the performance caveat.
 */
export function resolveContextAttributes(
  input: ContextAttributeInput,
): WebGL2ContextAttributes {
  return Object.freeze({
    alpha: false,
    depth: input.depth ?? true,
    stencil: input.stencil ?? false,
    antialias: input.antialias ?? !input.tvProfile,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: input.powerPreference ?? "high-performance",
    // Chromium-only hint; ignored everywhere else (05 §3.2).
    desynchronized: input.desynchronized ?? true,
    // Appendix A fixes this false even outside the TV profile.
    failIfMajorPerformanceCaveat: input.failIfMajorPerformanceCaveat ?? false,
  });
}

function parameter(gl: WebGL2RenderingContext, name: number): number {
  const value: unknown = gl.getParameter(name);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Reads every conformance limit exactly once (05 §3.3). */
export function readLimits(
  gl: WebGL2RenderingContext,
  maxAnisotropy: number,
): WebGL2Limits {
  return Object.freeze({
    maxTextureSize: parameter(gl, gl.MAX_TEXTURE_SIZE),
    maxCubeMapTextureSize: parameter(gl, gl.MAX_CUBE_MAP_TEXTURE_SIZE),
    max3DTextureSize: parameter(gl, gl.MAX_3D_TEXTURE_SIZE),
    maxArrayTextureLayers: parameter(gl, gl.MAX_ARRAY_TEXTURE_LAYERS),
    maxTextureImageUnits: parameter(gl, gl.MAX_TEXTURE_IMAGE_UNITS),
    maxVertexTextureImageUnits: parameter(gl, gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
    maxCombinedTextureImageUnits: parameter(gl, gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
    maxVertexAttributes: parameter(gl, gl.MAX_VERTEX_ATTRIBS),
    maxUniformBufferBindings: parameter(gl, gl.MAX_UNIFORM_BUFFER_BINDINGS),
    maxUniformBlockSize: parameter(gl, gl.MAX_UNIFORM_BLOCK_SIZE),
    maxDrawBuffers: parameter(gl, gl.MAX_DRAW_BUFFERS),
    maxColorAttachments: parameter(gl, gl.MAX_COLOR_ATTACHMENTS),
    maxSamples: parameter(gl, gl.MAX_SAMPLES),
    maxAnisotropy,
  });
}

/** Maps the WebGL2 conformance profile onto the frozen core limits. */
export function toDeviceLimits(limits: WebGL2Limits): DeviceLimits {
  return Object.freeze({
    maxTextureDimension2D: limits.maxTextureSize,
    maxTextureArrayLayers: limits.maxArrayTextureLayers,
    maxBindGroups: ABI_BIND_GROUPS,
    maxUniformBufferBindingSize: limits.maxUniformBlockSize,
    // WebGL2 has no storage buffers (05 §3.3).
    maxStorageBufferBindingSize: 0,
    maxBufferSize: MAX_BUFFER_SIZE,
    maxVertexBuffers: ABI_VERTEX_BUFFERS,
    maxColorAttachments: limits.maxColorAttachments,
    maxSamplerAnisotropy: limits.maxAnisotropy,
    minUniformBufferOffsetAlignment: MIN_UBO_OFFSET_ALIGNMENT,
    // No compute on Tier B.
    maxComputeWorkgroupSizeX: 0,
  });
}
