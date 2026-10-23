/**
 * `@lanpad/engine-renderer-webgpu` public entry.
 *
 * The frozen contract types are re-exported unchanged. The runtime value
 * `createWebGpuDevice` probes WebGPU, acquires an adapter/device and returns
 * a device that still needs `init(surface)`. ABI constants stay owned by
 * `@lanpad/engine-core`.
 */

import type { RenderDevice } from "@lanpad/engine-core";
import type { WebGpuDevice } from "./contracts/webgpu.js";

export type * from "./contracts/webgpu.js";

export {
  RENDERER_ABI_VERSION,
  SHADER_ABI_VERSION,
} from "@lanpad/engine-core";
export { PIPELINE_CACHE_VERSION } from "./version.js";
export { createWebGpuDevice } from "./device/factory.js";
export { WebGpuRendererDevice } from "./device/WebGpuDevice.js";
export type { WebGpuDeviceDependencies } from "./device/WebGpuDevice.js";

/**
 * Compile-time proof that `WebGpuDevice` is usable wherever the frozen core
 * `RenderDevice` is required (04 §3.2). If the contract and core diverge,
 * `npm run typecheck` fails here instead of at a runtime call site.
 */
const _webGpuDeviceSatisfiesRenderDevice: RenderDevice =
  null as unknown as WebGpuDevice;
void _webGpuDeviceSatisfiesRenderDevice;
