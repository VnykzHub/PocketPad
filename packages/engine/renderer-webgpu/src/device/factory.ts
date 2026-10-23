/**
 * WebGPU factory (04 §3.6, §5.2). Probes `navigator.gpu`, acquires an
 * adapter/device, selects the preferred canvas format, and returns a device
 * that is still `uninitialized` until the runtime calls `init(surface)`.
 *
 * A failure after the GPU device was acquired destroys it before throwing so
 * a fallback backend never inherits a live, unreferenced device.
 */

import type { WebGpuDeviceInitResult } from "../contracts/webgpu.js";
import type { WebGpuDeviceOptions } from "../contracts/webgpu.js";
import { acquireErrorToRendererError, acquireWebGpuDevice } from "./adapter.js";
import { normalizeOptions, preferredCanvasFormat } from "./capabilities.js";
import { WebGpuRendererDevice } from "./WebGpuDevice.js";
import type { WebGpuDeviceDependencies } from "./WebGpuDevice.js";
import { rendererError, WebGpuRendererError } from "../errors.js";

function probeGpu(): GPU | null {
  const navigatorValue = (
    globalThis as {
      readonly navigator?: { readonly gpu?: unknown };
    }
  ).navigator;
  const candidate = navigatorValue?.gpu;
  return typeof candidate === "object" && candidate !== null
    ? (candidate as GPU)
    : null;
}

/**
 * Creates the WebGPU backend. `init(surface, options?)` is still required
 * before any create call (04 §5.2 step 7).
 */
export async function createWebGpuDevice(
  options?: WebGpuDeviceOptions,
): Promise<WebGpuDeviceInitResult> {
  const gpu = probeGpu();
  if (gpu === null) {
    throw rendererError(
      "E_DEVICE_UNAVAILABLE",
      "WebGPU is not available in this browser",
      { label: "webgpu", recoverable: true },
    );
  }
  const normalized = normalizeOptions(options);
  let acquired;
  try {
    acquired = await acquireWebGpuDevice(gpu, normalized);
  } catch (error) {
    throw acquireErrorToRendererError(error);
  }

  let device: WebGpuRendererDevice;
  try {
    // Validate the adapter's preferred format before construction; a
    // non-bgra8/rgba8 value is a hard contract failure, never a silent
    // downcast to a different format.
    preferredCanvasFormat(gpu);
    const dependencies: WebGpuDeviceDependencies = {
      gpu,
      adapter: acquired.adapter,
      device: acquired.device,
      requestedFeatures: acquired.requestedFeatures,
      limits: acquired.limits,
      capabilities: acquired.capabilities,
      options: options ?? {},
    };
    device = new WebGpuRendererDevice(dependencies);
  } catch (error) {
    acquired.device.destroy();
    throw error instanceof WebGpuRendererError
      ? error
      : rendererError("E_BACKEND_INIT", "WebGPU device construction failed", {
          label: "webgpu",
          recoverable: true,
          cause: error,
        });
  }

  return {
    backend: "webgpu",
    capabilities: device.capabilities,
    adapterInfo: device.adapterInfo,
    device,
  };
}
