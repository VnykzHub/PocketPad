/**
 * Adapter/device acquisition (04 §5.2 steps 2–5).
 *
 * The retry rule is exact: one low-power retry only when the first
 * `requestAdapter` call throws. A null adapter is a hard failure.
 */

import type { DeviceLimits } from "@lanpad/engine-core";
import type { WebGpuCapabilities } from "../contracts/webgpu.js";
import { rendererError } from "../errors.js";
import {
  capabilitiesFromAdapter,
  deviceLimits,
  requestedWebGpuFeatures,
  samplerAnisotropyLimit,
} from "./capabilities.js";
import type { NormalizedDeviceOptions } from "./capabilities.js";

export type AcquireFailureReason =
  | "adapter-unavailable"
  | "device-request-failed";

export class AcquireDeviceError extends Error {
  readonly reason: AcquireFailureReason;

  constructor(reason: AcquireFailureReason, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "AcquireDeviceError";
    this.reason = reason;
  }
}

export interface AcquiredWebGpuDevice {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly requestedFeatures: readonly GPUFeatureName[];
  readonly limits: DeviceLimits;
  readonly capabilities: WebGpuCapabilities;
}

function adapterOptions(
  preference: "high-performance" | "low-power",
): GPURequestAdapterOptions {
  return { powerPreference: preference, forceFallbackAdapter: false };
}

async function requestAdapterWithRetry(
  gpu: GPU,
  options: NormalizedDeviceOptions,
): Promise<GPUAdapter> {
  let firstError: unknown;
  try {
    const adapter = await gpu.requestAdapter(
      adapterOptions(options.powerPreference),
    );
    if (adapter === null) {
      throw new AcquireDeviceError(
        "adapter-unavailable",
        "no WebGPU adapter is available",
      );
    }
    return adapter;
  } catch (error) {
    if (error instanceof AcquireDeviceError) {
      throw error;
    }
    firstError = error;
  }

  // Exactly one retry, low power, and only because the first call threw.
  try {
    const adapter = await gpu.requestAdapter(adapterOptions("low-power"));
    if (adapter === null) {
      throw new AcquireDeviceError(
        "adapter-unavailable",
        "no WebGPU adapter is available after retry",
        firstError,
      );
    }
    return adapter;
  } catch (error) {
    if (error instanceof AcquireDeviceError) {
      throw error;
    }
    throw new AcquireDeviceError(
      "adapter-unavailable",
      "requestAdapter failed twice",
      error,
    );
  }
}

function requiredLimitsFor(adapter: GPUAdapter): Record<string, number> {
  const required: Record<string, number> = {
    maxTextureDimension2D: Math.min(8192, adapter.limits.maxTextureDimension2D),
    maxBufferSize: Math.min(256 * 1024 * 1024, adapter.limits.maxBufferSize),
    maxUniformBufferBindingSize: Math.min(
      65_536,
      adapter.limits.maxUniformBufferBindingSize,
    ),
  };
  // Only request the anisotropy limit when the adapter actually reports it.
  const anisotropy = (
    adapter.limits as GPUSupportedLimits & {
      readonly maxSamplerAnisotropy?: unknown;
    }
  ).maxSamplerAnisotropy;
  if (typeof anisotropy === "number" && Number.isFinite(anisotropy)) {
    required["maxSamplerAnisotropy"] = Math.min(
      16,
      samplerAnisotropyLimit(adapter.limits),
    );
  }
  return required;
}

export async function acquireWebGpuDevice(
  gpu: GPU,
  options: NormalizedDeviceOptions,
): Promise<AcquiredWebGpuDevice> {
  const adapter = await requestAdapterWithRetry(gpu, options);
  const requestedFeatures = requestedWebGpuFeatures(adapter);
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({
      label: "pocketpad-renderer",
      requiredFeatures: requestedFeatures,
      requiredLimits: requiredLimitsFor(adapter),
    });
  } catch (error) {
    throw new AcquireDeviceError(
      "device-request-failed",
      "requestDevice failed",
      error,
    );
  }

  const limits = deviceLimits(device.limits);
  const capabilities = capabilitiesFromAdapter(
    adapter,
    options,
    requestedFeatures,
    limits,
  );
  return {
    adapter,
    device,
    requestedFeatures,
    limits,
    capabilities,
  };
}

/** Used by the factory to convert acquisition failure into an EngineError. */
export function acquireErrorToRendererError(
  error: unknown,
): ReturnType<typeof rendererError> {
  if (error instanceof AcquireDeviceError) {
    return rendererError("E_DEVICE_UNAVAILABLE", error.message, {
      label: "device",
      recoverable: true,
      cause: error,
    });
  }
  return rendererError(
    "E_DEVICE_UNAVAILABLE",
    "WebGPU device acquisition failed",
    {
      label: "device",
      recoverable: true,
      cause: error,
    },
  );
}
