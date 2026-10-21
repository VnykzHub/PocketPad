/**
 * WebGL2 capability probing (D3-RT-02, FR-9.3, FR-12.1).
 *
 * Kept separate from `Renderer.ts` so the concrete renderers can use the
 * extension list without importing the factory that constructs them (no
 * module cycle). Capability decisions are feature detection only; the UA
 * string is never consulted here.
 */

/** The WebGL2 probe result. `available=false` zeroes the other fields. */
export interface Webgl2Capability {
  readonly available: boolean;
  readonly maxTextureSize: number;
  readonly compressedFormats: string[];
}

/** Extensions E1 records; the order is stable for screenshots and tests. */
export const COMPRESSED_TEXTURE_EXTENSIONS = [
  "WEBGL_compressed_texture_astc",
  "WEBGL_compressed_texture_etc",
  "WEBGL_compressed_texture_etc1",
  "WEBGL_compressed_texture_s3tc",
  "WEBGL_compressed_texture_s3tc_srgb",
  "EXT_texture_compression_bptc",
  "EXT_texture_compression_rgtc",
] as const;

const MAX_TEXTURE_SIZE_ENUM = 0x0d33;

export function unavailableCapability(): Webgl2Capability {
  return { available: false, maxTextureSize: 0, compressedFormats: [] };
}

function defaultCreateCanvas(): HTMLCanvasElement | null {
  if (typeof document === "undefined") {
    return null;
  }
  return document.createElement("canvas");
}

/**
 * Feature-detects WebGL2 (FR-12.1). The injected `createCanvas` exists for
 * tests and for callers that want to probe a specific canvas. Any exception
 * (blocked context, lost context) counts as "unavailable", never a crash.
 */
export function detectWebgl2(
  createCanvas: () => HTMLCanvasElement | null = defaultCreateCanvas,
): Webgl2Capability {
  let canvas: HTMLCanvasElement | null;
  try {
    canvas = createCanvas();
  } catch {
    return unavailableCapability();
  }
  if (canvas === null) {
    return unavailableCapability();
  }

  let gl: WebGL2RenderingContext | null;
  try {
    gl = canvas.getContext("webgl2");
  } catch {
    gl = null;
  }
  if (gl === null) {
    return unavailableCapability();
  }

  let maxTextureSize = 0;
  try {
    const value = gl.getParameter(MAX_TEXTURE_SIZE_ENUM);
    if (typeof value === "number" && Number.isFinite(value)) {
      maxTextureSize = value;
    }
  } catch {
    maxTextureSize = 0;
  }

  return {
    available: true,
    maxTextureSize,
    compressedFormats: listCompressedFormats(readSupportedExtensions(gl)),
  };
}

/** Reads `getSupportedExtensions()` defensively (some browsers return null). */
export function readSupportedExtensions(gl: WebGL2RenderingContext): string[] {
  try {
    const extensions = gl.getSupportedExtensions();
    return extensions === null ? [] : extensions;
  } catch {
    return [];
  }
}

/** Filters the E1 extension list, preserving a stable order. */
export function listCompressedFormats(supported: readonly string[]): string[] {
  const formats: string[] = [];
  for (const name of COMPRESSED_TEXTURE_EXTENSIONS) {
    if (supported.includes(name)) {
      formats.push(name);
    }
  }
  return formats;
}

/** Reads `MAX_TEXTURE_SIZE` defensively. */
export function readMaxTextureSize(gl: WebGL2RenderingContext): number {
  try {
    const value = gl.getParameter(MAX_TEXTURE_SIZE_ENUM);
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}
