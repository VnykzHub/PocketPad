/**
 * Dev-only WebGPU testing entry (`@lanpad/engine-renderer-webgpu/dev`).
 *
 * The production host never imports this subpath. `forceWebGpuDeviceLost`
 * destroys the real `GPUDevice`; the real `device.lost` promise then runs the
 * normal loss/restore path (ER-04-05). It never synthesizes a loss event.
 */
import type { RenderDevice } from "@lanpad/engine-core";
import {
  FORCE_DEVICE_LOST,
  WebGpuRendererDevice,
} from "./device/WebGpuDevice.js";

/**
 * Destroys the device under test. Returns false when `device` is not a WebGPU
 * device or is not running (uninitialized, lost, restoring, failed, disposed).
 * Callers must wait for `onDeviceLost` before calling `restore()`.
 */
export function forceWebGpuDeviceLost(device: RenderDevice): boolean {
  if (!(device instanceof WebGpuRendererDevice)) return false;
  return device[FORCE_DEVICE_LOST]();
}
