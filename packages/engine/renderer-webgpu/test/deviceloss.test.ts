/**
 * Device-loss recovery tests (04 §5.11, ER-04-05).
 *
 * The fake GPU resolves its `lost` promise on demand; `restore()` re-acquires a
 * replacement device from the same fake adapter. These are Node-only facts:
 * no real GPU fallback, TDR or browser device-loss event is exercised here.
 * Timing of recovery is not measured.
 */

import { describe, expect, test } from "vitest";
import type { BufferDesc, TextureDesc } from "@lanpad/engine-core";
import { forceWebGpuDeviceLost } from "../src/dev.js";
import { WebGpuRendererDevice } from "../src/device/WebGpuDevice.js";
import { createHarness } from "./fakes/webgpu.js";
import {
  errorOf,
  errorOfAsync,
  initialized,
  materialDesc,
  orthoProjection,
  staticMeshDesc,
  translation,
} from "./helpers.js";

/** Lets the `lost` promise reaction run before the next assertion. */
async function settleLoss(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function lossTextureDesc(): TextureDesc {
  return {
    label: "loss-texture",
    width: 4,
    height: 4,
    format: "rgba8unorm-srgb",
    usage: ["sample", "copy-dst"],
    data: [
      {
        mipLevel: 0,
        layer: 0,
        bytes: new Uint8Array(4 * 4 * 4),
        bytesPerRow: 16,
      },
    ],
  };
}

function lossBufferDesc(): BufferDesc {
  return {
    label: "loss-buffer",
    size: 64,
    usage: ["uniform", "copy-dst"],
    data: new Uint8Array(64),
  };
}

describe("loss reporting", () => {
  test("[ER-04-05] the dev hook destroys the real device and restore recovers", async () => {
    const { device } = await initialized();

    expect(forceWebGpuDeviceLost(device)).toBe(true);
    await settleLoss();
    expect(device.deviceState).toBe("lost");
    expect(forceWebGpuDeviceLost(device)).toBe(false);

    expect((await device.restore()).ok).toBe(true);
    expect(device.deviceState).toBe("running");
  });

  test("[ER-04-05] a forced loss is sanitized and zeroes byte counters", async () => {
    const { harness, device } = await initialized();
    device.createTexture(lossTextureDesc());
    device.createBuffer(lossBufferDesc());
    expect(device.stats.textureBytes).toBeGreaterThan(0);
    expect(device.stats.bufferBytes).toBeGreaterThan(0);

    const infos: { reason: string; message: string }[] = [];
    device.onDeviceLost((info) => {
      infos.push(info);
    });

    const frame = device.beginFrame();
    harness.device.lose(
      "destroyed",
      "GPU crashed at https://example.test/private?token=abc \u0001 \u0007 reset",
    );
    await settleLoss();

    expect(device.deviceState).toBe("lost");
    expect(device.stats.gpuErrors).toBe(1);
    expect(device.stats.textureBytes).toBe(0);
    expect(device.stats.bufferBytes).toBe(0);
    expect(frame.valid).toBe(false);
    expect(infos.length).toBe(1);
    expect(infos[0]?.reason).toBe("destroyed");
    const message = infos[0]?.message ?? "";
    expect(message).toContain("[url]");
    expect(message).not.toContain("https://");
    expect(message).not.toContain("token=abc");
    expect(/[\u0000-\u001f\u007f]/.test(message)).toBe(false);
    device.endFrame();
  });

  test("[ER-04-05] resource creation while lost throws E_DEVICE_LOST", async () => {
    const { harness, device } = await initialized();
    harness.device.lose("unknown", "hung");
    await settleLoss();
    expect(device.deviceState).toBe("lost");
    expect(errorOf(() => device.createMesh(staticMeshDesc())).code).toBe(
      "E_DEVICE_LOST",
    );
    expect(errorOf(() => device.createTexture(lossTextureDesc())).code).toBe(
      "E_DEVICE_LOST",
    );
    expect(device.beginFrame().valid).toBe(false);
    device.endFrame();
  });

  test("[ER-04-05] listeners are isolated and can be unsubscribed", async () => {
    const { harness, device } = await initialized();
    let throwingCalls = 0;
    let normalCalls = 0;
    device.onDeviceLost(() => {
      throwingCalls += 1;
      throw new Error("listener failure");
    });
    const unsubscribe = device.onDeviceLost(() => {
      normalCalls += 1;
    });
    unsubscribe();
    device.onDeviceLost(() => {
      normalCalls += 1;
    });

    harness.device.lose("unknown", "forced");
    await settleLoss();

    expect(throwingCalls).toBe(1);
    expect(normalCalls).toBe(1);
    expect(device.deviceState).toBe("lost");
  });
});

describe("one-attempt restore", () => {
  test("[ER-04-05] restore rebuilds builtins and keeps handles usable", async () => {
    const { harness, device } = await initialized();
    const mesh = device.createMesh(staticMeshDesc());
    const material = device.createMaterial(materialDesc());
    const originalDevice = harness.device;
    originalDevice.lose("unknown", "gpu hung");
    await settleLoss();
    expect(device.deviceState).toBe("lost");

    let restoredCalls = 0;
    device.onRestored(() => {
      restoredCalls += 1;
      throw new Error("restored listener failure");
    });

    const result = await device.restore();
    expect(result.ok).toBe(true);
    expect(result.restoredHandles).toBe(2);
    expect(result.staleHandles).toBe(0);
    expect(restoredCalls).toBe(1);
    expect(device.deviceState).toBe("running");

    const replacement = harness.adapter.devices[1];
    if (replacement === undefined) {
      throw new Error("expected a replacement fake device");
    }
    expect(replacement).not.toBe(originalDevice);
    expect(replacement.counts.createBuffer).toBeGreaterThan(0);
    expect(replacement.counts.createBindGroup).toBeGreaterThan(0);
    expect(device.stats.bufferBytes).toBeGreaterThan(0);

    // The same handles draw on the replacement device, and the swapchain is
    // reconfigured against it on the next frame.
    const frame = device.beginFrame();
    expect(frame.valid).toBe(true);
    frame.setCamera(orthoProjection());
    frame.draw(mesh, material, translation(0, 0, -50));
    expect(device.stats.drawCalls).toBe(1);
    expect(harness.context.configureCalls).toBe(2);
    device.endFrame();
    expect(replacement.queue.submitCalls.length).toBe(1);
  });

  test("[ER-04-05] non-restorable handles are reported stale and stay dead", async () => {
    const { harness, device } = await initialized({ retainCpuCopies: false });
    const mesh = device.createMesh(staticMeshDesc());
    const material = device.createMaterial(materialDesc());
    device.createShaderModule({
      label: "loss-vertex",
      stage: "vertex",
      language: "wgsl",
      code: "@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0); }",
      entryPoint: "vs_main",
      abiVersion: 1,
    });
    harness.device.lose("unknown", "forced");
    await settleLoss();

    const result = await device.restore();
    expect(result.ok).toBe(true);
    // Shader and material survive; the mesh had no CPU copy to rebuild.
    expect(result.restoredHandles).toBe(2);
    expect(result.staleHandles).toBe(1);

    const frame = device.beginFrame();
    frame.setCamera(orthoProjection());
    expect(
      errorOf(() => frame.draw(mesh, material, translation(0, 0, -50))).code,
    ).toBe("E_STALE_HANDLE");
    expect(device.stats.drawCalls).toBe(0);
    device.endFrame();
  });

  test("[ER-04-05] a second loss is terminal and restore refuses", async () => {
    const { harness, device } = await initialized();
    harness.device.lose("unknown", "first");
    await settleLoss();
    expect((await device.restore()).ok).toBe(true);
    const replacement = harness.adapter.devices[1];
    if (replacement === undefined) {
      throw new Error("expected a replacement fake device");
    }

    replacement.lose("destroyed", "second");
    await settleLoss();
    expect(device.deviceState).toBe("failed");
    expect(device.stats.gpuErrors).toBe(2);
    expect((await errorOfAsync(device.restore())).code).toBe("E_DEVICE_LOST");
    expect(device.deviceState).toBe("failed");
  });

  test("[ER-04-05] restore state rules cover before-init, running and disposed", async () => {
    const harness = createHarness();
    const fresh = new WebGpuRendererDevice(harness.dependencies);
    expect((await errorOfAsync(fresh.restore())).code).toBe("E_BACKEND_INIT");

    const { device } = await initialized();
    expect(await device.restore()).toEqual({
      ok: true,
      restoredHandles: 0,
      staleHandles: 0,
    });
    device.dispose();
    expect(await device.restore()).toEqual({
      ok: false,
      reason: "disposed",
      restoredHandles: 0,
      staleHandles: 0,
    });
  });

  test("[ER-04-05] an acquisition failure marks the device failed", async () => {
    const { harness, device } = await initialized();
    harness.device.lose("unknown", "forced");
    await settleLoss();

    harness.gpu.failRequestAdapter = true;
    const result = await device.restore();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("adapter-unavailable");
    expect(result.restoredHandles).toBe(0);
    expect(result.staleHandles).toBe(0);
    expect(device.deviceState).toBe("failed");
    // One error for the loss, one for the failed re-acquire.
    expect(device.stats.gpuErrors).toBe(2);
  });

  test("[ER-04-05] a requestDevice failure reports device-request-failed", async () => {
    const { harness, device } = await initialized();
    harness.device.lose("unknown", "forced");
    await settleLoss();

    harness.adapter.failRequestDevice = true;
    const result = await device.restore();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("device-request-failed");
    expect(device.deviceState).toBe("failed");
  });
});
