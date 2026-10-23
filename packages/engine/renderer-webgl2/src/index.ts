/**
 * `@lanpad/engine-renderer-webgl2` public 3D entry.
 *
 * Exports the frozen WebGL2 contract types plus the M0 Tier B implementation:
 * probe, classifier, device factory, feature refusals, failure copy and the
 * canonical texture-format table. The Canvas2D entry lives in `./canvas2d`.
 */

export type * from "./contracts/webgl2.js";

export { WEBGL2_DESIGN_CAPS } from "./version.js";
export { probeWebGL2, buildCapabilities, readProbeData } from "./capability.js";
export { classifyWebGL2, EXT } from "./classify.js";
export { missingFeatures, describeMissingFeature } from "./features.js";
export { createBackendFailureNotice } from "./failure.js";
export { createWebGL2Device } from "./device.js";
export { RendererEngineError, rendererError } from "./errors.js";
export {
  TEXTURE_FORMATS,
  WEBGL2_TEXTURE_FORMAT_MAP,
  supportedTextureFormats,
  textureFormatEntry,
} from "./texture.js";
export { ABI_LAYOUTS, ABI_VERTEX_STRIDE, ABI_INSTANCE_STRIDE } from "./mesh.js";
export { fnv1a32, pipelineKey } from "./pipelineCache.js";
