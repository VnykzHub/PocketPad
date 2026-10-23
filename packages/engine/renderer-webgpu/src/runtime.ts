/**
 * Runtime constants that TypeScript's WebGPU declarations do not provide.
 *
 * TS 6 `lib.dom` declares WebGPU types but not the numeric global singletons
 * (`GPUTextureUsage`, `GPUBufferUsage`, `GPUShaderStage`, `GPUMapMode`). The
 * browser provides them; the fallbacks keep Node fake-device tests executable.
 * Values are the WebGPU specification constants, not measurements.
 */

interface UsageConstants {
  readonly [name: string]: number;
}

function readGlobal(name: string): UsageConstants | undefined {
  return (globalThis as Record<string, unknown>)[name] as
    | UsageConstants
    | undefined;
}

const textureUsageGlobal = readGlobal("GPUTextureUsage");
const bufferUsageGlobal = readGlobal("GPUBufferUsage");
const shaderStageGlobal = readGlobal("GPUShaderStage");
const mapModeGlobal = readGlobal("GPUMapMode");

export const TEXTURE_USAGE = {
  COPY_SRC: textureUsageGlobal?.["COPY_SRC"] ?? 0x01,
  COPY_DST: textureUsageGlobal?.["COPY_DST"] ?? 0x02,
  TEXTURE_BINDING: textureUsageGlobal?.["TEXTURE_BINDING"] ?? 0x04,
  STORAGE_BINDING: textureUsageGlobal?.["STORAGE_BINDING"] ?? 0x08,
  RENDER_ATTACHMENT: textureUsageGlobal?.["RENDER_ATTACHMENT"] ?? 0x10,
} as const;

export const BUFFER_USAGE = {
  MAP_READ: bufferUsageGlobal?.["MAP_READ"] ?? 0x01,
  MAP_WRITE: bufferUsageGlobal?.["MAP_WRITE"] ?? 0x02,
  COPY_SRC: bufferUsageGlobal?.["COPY_SRC"] ?? 0x04,
  COPY_DST: bufferUsageGlobal?.["COPY_DST"] ?? 0x08,
  INDEX: bufferUsageGlobal?.["INDEX"] ?? 0x10,
  VERTEX: bufferUsageGlobal?.["VERTEX"] ?? 0x20,
  UNIFORM: bufferUsageGlobal?.["UNIFORM"] ?? 0x40,
  STORAGE: bufferUsageGlobal?.["STORAGE"] ?? 0x80,
  INDIRECT: bufferUsageGlobal?.["INDIRECT"] ?? 0x100,
  QUERY_RESOLVE: bufferUsageGlobal?.["QUERY_RESOLVE"] ?? 0x200,
} as const;

export const SHADER_STAGE = {
  VERTEX: shaderStageGlobal?.["VERTEX"] ?? 0x01,
  FRAGMENT: shaderStageGlobal?.["FRAGMENT"] ?? 0x02,
  COMPUTE: shaderStageGlobal?.["COMPUTE"] ?? 0x04,
} as const;

export const MAP_MODE = {
  READ: mapModeGlobal?.["READ"] ?? 0x01,
  WRITE: mapModeGlobal?.["WRITE"] ?? 0x02,
} as const;

/**
 * Dev builds enforce contract errors. Matches core's rule (02 §3.2): anything
 * other than `NODE_ENV=production` is dev, and `?debug=1` forces dev.
 */
export const IS_DEV: boolean = (() => {
  const env = (
    globalThis as { process?: { env?: { NODE_ENV?: string } } }
  ).process?.env?.NODE_ENV;
  if (env !== undefined && env !== "production") {
    return true;
  }
  if (typeof location !== "undefined" && location.search.includes("debug=1")) {
    return true;
  }
  return env === undefined;
})();

/** Milliseconds for CPU frame accounting only; never a GPU-time substitute. */
export function nowMs(): number {
  const perf = (globalThis as { performance?: { now(): number } })
    .performance;
  return perf ? perf.now() : 0;
}
