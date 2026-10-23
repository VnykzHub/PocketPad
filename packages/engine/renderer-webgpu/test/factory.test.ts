/**
 * WebGPU factory tests (04 §3.6, §5.2, ER-04-17 partial).
 *
 * `createWebGpuDevice` is driven with a stubbed `navigator.gpu`; no browser
 * WebGPU implementation is involved. The shared core conformance suite and
 * the real-device browser run remain PENDING.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { WebGpuRendererDevice } from "../src/device/WebGpuDevice.js";
import { createWebGpuDevice } from "../src/device/factory.js";
import { FakeAdapter, FakeGpu, fakeLimits } from "./fakes/webgpu.js";
import { errorOfAsync } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubGpu(gpu: FakeGpu): void {
  vi.stubGlobal("navigator", { gpu });
}

describe("WebGPU availability", () => {
  test("[ER-04-17] a missing navigator.gpu is E_DEVICE_UNAVAILABLE", async () => {
    vi.stubGlobal("navigator", {});
    const missing = await errorOfAsync(createWebGpuDevice());
    expect(missing.code).toBe("E_DEVICE_UNAVAILABLE");
    expect(missing.recoverable).toBe(true);

    vi.stubGlobal("navigator", { gpu: null });
    expect((await errorOfAsync(createWebGpuDevice())).code).toBe(
      "E_DEVICE_UNAVAILABLE",
    );
  });
});

describe("adapter acquisition", () => {
  test("[ER-04-17] a successful call returns an uninitialized device", async () => {
    const gpu = new FakeGpu();
    stubGpu(gpu);
    const result = await createWebGpuDevice();

    expect(result.backend).toBe("webgpu");
    expect(result.device).toBeInstanceOf(WebGpuRendererDevice);
    expect(result.device.deviceState).toBe("uninitialized");
    expect(result.adapterInfo).toBe("Fake GPU fake test fake-device");
    expect(result.capabilities).toEqual(result.device.capabilities);

    expect(gpu.requestAdapterCalls).toEqual([
      { powerPreference: "high-performance" },
    ]);
    const adapter = gpu.adapters[0];
    if (adapter === undefined) {
      throw new Error("expected an acquired fake adapter");
    }
    expect(adapter.requestDeviceCalls.length).toBe(1);
  });

  test("[ER-04-17] a null adapter fails without a retry", async () => {
    const gpu = new FakeGpu();
    gpu.returnNullAdapter = true;
    stubGpu(gpu);
    const error = await errorOfAsync(createWebGpuDevice());
    expect(error.code).toBe("E_DEVICE_UNAVAILABLE");
    expect(gpu.requestAdapterCalls.length).toBe(1);
  });

  test("[ER-04-17] a thrown requestAdapter retries once at low power", async () => {
    const gpu = new FakeGpu();
    gpu.requestAdapterFailuresRemaining = 1;
    stubGpu(gpu);
    const result = await createWebGpuDevice();
    expect(result.backend).toBe("webgpu");
    expect(gpu.requestAdapterCalls).toEqual([
      { powerPreference: "high-performance" },
      { powerPreference: "low-power" },
    ]);
  });

  test("[ER-04-17] two requestAdapter failures surface as E_DEVICE_UNAVAILABLE", async () => {
    const gpu = new FakeGpu();
    gpu.requestAdapterFailuresRemaining = 1;
    gpu.failRequestAdapter = true;
    stubGpu(gpu);
    const error = await errorOfAsync(createWebGpuDevice());
    expect(error.code).toBe("E_DEVICE_UNAVAILABLE");
    expect(gpu.requestAdapterCalls.length).toBe(2);
    expect(gpu.adapters.length).toBe(0);
  });

  test("[ER-04-17] a requestDevice failure is reported", async () => {
    const gpu = new FakeGpu();
    const adapters: FakeAdapter[] = [];
    gpu.makeAdapter = () => {
      const adapter = new FakeAdapter();
      adapter.failRequestDevice = true;
      adapters.push(adapter);
      return adapter;
    };
    stubGpu(gpu);
    const error = await errorOfAsync(createWebGpuDevice());
    expect(error.code).toBe("E_DEVICE_UNAVAILABLE");
    expect(error.message).toContain("requestDevice failed");
    const adapter = adapters[0];
    if (adapter === undefined) {
      throw new Error("expected an adapter attempt");
    }
    expect(adapter.requestDeviceCalls.length).toBe(1);
    expect(adapter.devices.length).toBe(0);
  });

  test("[ER-04-17] an invalid preferred format destroys the acquired device", async () => {
    const gpu = new FakeGpu();
    gpu.preferredFormat = "rgba16float";
    stubGpu(gpu);
    const error = await errorOfAsync(createWebGpuDevice());
    expect(error.code).toBe("E_BACKEND_INIT");
    const adapter = gpu.adapters[0];
    if (adapter === undefined) {
      throw new Error("expected an acquired fake adapter");
    }
    const device = adapter.devices[0];
    if (device === undefined) {
      throw new Error("expected an acquired fake device");
    }
    expect(device.counts.destroy).toBe(1);
  });

  test("[ER-04-17] options feed the capability report", async () => {
    const gpu = new FakeGpu();
    stubGpu(gpu);
    const result = await createWebGpuDevice({
      quality: "low",
      anisotropy: 32,
      retainCpuCopies: false,
    });
    expect(result.capabilities.quality).toBe("low");
    expect(result.capabilities.anisotropy).toBe(16);
    expect(result.device.capabilities).toBe(result.capabilities);
  });

  test("[ER-04-17] adapter info is sanitized at the factory boundary", async () => {
    const gpu = new FakeGpu();
    gpu.makeAdapter = () =>
      new FakeAdapter(fakeLimits(), new Set(), {
        description: "Nice GPU https://secret.test token=abc123",
        vendor: "Vendor",
        architecture: "arch",
        device: "device",
      });
    stubGpu(gpu);
    const result = await createWebGpuDevice();
    expect(result.adapterInfo).toBe("Nice GPU Vendor arch device");
    expect(result.adapterInfo).not.toContain("token=abc123");
  });

  test("[ER-04-09] a non-sRGB canvas selects the shader-encode fallback", async () => {
    const gpu = new FakeGpu();
    gpu.preferredFormat = "bgra8unorm";
    stubGpu(gpu);
    const result = await createWebGpuDevice();
    expect(result.device.canvasFormat).toBe("bgra8unorm");
    expect(result.device.canvasFormat.endsWith("-srgb")).toBe(false);
  });

  test("[ER-04-09] an sRGB canvas format is refused instead of double-encoding", async () => {
    const gpu = new FakeGpu();
    gpu.preferredFormat = "bgra8unorm-srgb";
    stubGpu(gpu);
    const error = await errorOfAsync(createWebGpuDevice());
    expect(error.code).toBe("E_BACKEND_INIT");
  });
});
