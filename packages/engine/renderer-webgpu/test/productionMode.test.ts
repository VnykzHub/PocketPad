/**
 * Production-mode fallback tests (04 §5.12, ER-04-04, ER-04-07, ER-04-10,
 * ER-04-15).
 *
 * Production builds never throw contract errors into the game loop: misuses
 * are counted in `stats.gpuErrors` or `stats.droppedDraws` and rendering
 * continues with safe defaults. `IS_DEV` is fixed at module evaluation, so
 * this file sets `NODE_ENV=production` before dynamically importing the
 * backend. Node-only fake-GPU evidence; no browser build is exercised.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TextureDesc } from "@lanpad/engine-core";

type DeviceModule = typeof import("../src/device/WebGpuDevice.js");
type FakesModule = typeof import("./fakes/webgpu.js");
type HelpersModule = typeof import("./helpers.js");
type Device = InstanceType<DeviceModule["WebGpuRendererDevice"]>;
type Harness = ReturnType<FakesModule["createHarness"]>;

let helpers: HelpersModule;
const originalNodeEnv = process.env["NODE_ENV"];

beforeAll(async () => {
  process.env["NODE_ENV"] = "production";
  // Import order matters: every backend module must first evaluate after the
  // environment switch so `IS_DEV` is false for this file's device instances.
  await import("../src/device/WebGpuDevice.js");
  await import("./fakes/webgpu.js");
  helpers = await import("./helpers.js");
});

afterAll(() => {
  if (originalNodeEnv === undefined) {
    delete process.env["NODE_ENV"];
  } else {
    process.env["NODE_ENV"] = originalNodeEnv;
  }
});

function fullInstances(count: number): Float32Array {
  const out = new Float32Array(count * 16);
  for (let index = 0; index < count; index += 1) {
    const base = index * 16;
    out[base] = 1;
    out[base + 5] = 1;
    out[base + 10] = 1;
    out[base + 15] = 1;
    out[base + 14] = -50;
  }
  return out;
}

function readbackTextureDesc(): TextureDesc {
  return {
    label: "production-readback",
    width: 1,
    height: 1,
    format: "rgba8unorm-srgb",
    usage: ["sample", "copy-dst"],
    data: [
      {
        mipLevel: 0,
        layer: 0,
        bytes: new Uint8Array([1, 2, 3, 4]),
        bytesPerRow: 4,
      },
    ],
  };
}

async function begin(): Promise<{
  harness: Harness;
  device: Device;
  frame: ReturnType<Device["beginFrame"]>;
}> {
  const { harness, device } = await helpers.initialized();
  const frame = device.beginFrame();
  frame.setCamera(helpers.orthoProjection());
  return { harness, device, frame };
}

describe("production contract fallbacks", () => {
  test("[ER-04-07] a stale handle is counted instead of thrown", async () => {
    const { device, frame } = await begin();
    const mesh = device.createMesh(helpers.staticMeshDesc());
    const material = device.createMaterial(helpers.materialDesc());
    device.destroy(mesh);

    expect(() =>
      frame.draw(mesh, material, helpers.translation(0, 0, -50)),
    ).not.toThrow();
    expect(device.stats.drawCalls).toBe(0);
    expect(device.stats.gpuErrors).toBe(1);
    device.endFrame();
  });

  test("[ER-04-07] drawing without a camera uses identity and counts once", async () => {
    const { device } = await helpers.initialized();
    const frame = device.beginFrame();
    const mesh = device.createMesh(helpers.staticMeshDesc());
    const material = device.createMaterial(helpers.materialDesc());

    expect(() =>
      frame.draw(mesh, material, helpers.translation(0, 0, -50)),
    ).not.toThrow();
    expect(device.stats.drawCalls).toBe(1);
    expect(device.stats.gpuErrors).toBe(1);

    // The camera is now set (identity), so a second draw is not counted again.
    frame.draw(mesh, material, helpers.translation(1, 0, -50));
    expect(device.stats.drawCalls).toBe(2);
    expect(device.stats.gpuErrors).toBe(1);
    device.endFrame();
  });

  test("[ER-04-07] drawing after endFrame is a silent no-op", async () => {
    const { device, frame } = await begin();
    const mesh = device.createMesh(helpers.staticMeshDesc());
    const material = device.createMaterial(helpers.materialDesc());
    frame.draw(mesh, material, helpers.translation(0, 0, -50));
    expect(device.stats.drawCalls).toBe(1);
    device.endFrame();

    expect(() =>
      frame.draw(mesh, material, helpers.translation(0, 0, -50)),
    ).not.toThrow();
    expect(device.stats.drawCalls).toBe(1);
    expect(device.stats.gpuErrors).toBe(0);
  });

  test("[ER-04-07] a second beginFrame aborts the previous frame", async () => {
    const { harness, device } = await helpers.initialized();
    device.beginFrame();
    expect(() => device.beginFrame()).not.toThrow();
    expect(harness.device.encoders.length).toBe(2);
    expect(harness.device.encoders[0]?.passes[0]?.ended).toBe(false);
    expect(harness.device.encoders[1]?.passes[0]?.ended).toBe(false);
    device.endFrame();
    expect(harness.device.queue.submitCalls.length).toBe(1);
    expect(harness.device.encoders[1]?.passes[0]?.ended).toBe(true);
  });

  test("[ER-04-07] a non-finite transform substitutes identity and counts", async () => {
    const { harness, device, frame } = await begin();
    const mesh = device.createMesh(helpers.staticMeshDesc());
    const material = device.createMaterial(helpers.materialDesc());
    const model = helpers.translation(7, 8, -50);
    model.m[14] = Number.NaN;

    expect(() => frame.draw(mesh, material, model)).not.toThrow();
    expect(device.stats.gpuErrors).toBe(1);
    expect(device.stats.drawCalls).toBe(1);

    const upload = harness.device.queue.writeBufferCalls.find(
      (call) => call.buffer.label === "object-ring" && call.bufferOffset === 0,
    );
    if (upload === undefined) {
      throw new Error("expected the object uniform upload");
    }
    const floats = new Float32Array(
      upload.bytes.buffer,
      upload.bytes.byteOffset,
      64,
    );
    expect(floats[0]).toBe(1);
    expect(floats[5]).toBe(1);
    expect(floats[10]).toBe(1);
    expect(floats[12]).toBe(0);
    expect(floats[13]).toBe(0);
    expect(floats[14]).toBe(0);
    expect(floats[15]).toBe(1);
    device.endFrame();
  });
});

describe("production draw clamping", () => {
  test("[ER-04-10] 65,537 instances clamp to 65,536 and count one drop", async () => {
    const { device, frame } = await begin();
    const mesh = device.createMesh(helpers.instancedMeshDesc());
    const material = device.createMaterial(helpers.materialDesc());

    frame.drawInstanced(mesh, material, fullInstances(65_537), 65_537);
    expect(device.stats.drawCalls).toBe(1);
    expect(device.stats.instances).toBe(65_536);
    expect(device.stats.droppedDraws).toBe(1);
    expect(device.stats.gpuErrors).toBe(0);
    device.endFrame();
  });

  test("[ER-04-10] a short transform buffer clamps to the available count", async () => {
    const { device, frame } = await begin();
    const mesh = device.createMesh(helpers.instancedMeshDesc());
    const material = device.createMaterial(helpers.materialDesc());
    const transforms = fullInstances(1);

    frame.drawInstanced(mesh, material, transforms, 2);
    expect(device.stats.drawCalls).toBe(1);
    expect(device.stats.instances).toBe(1);
    expect(device.stats.droppedDraws).toBe(1);
    device.endFrame();
  });

  test("[ER-04-10] a static mesh in drawInstanced is dropped without throwing", async () => {
    const { device, frame } = await begin();
    const mesh = device.createMesh(helpers.staticMeshDesc());
    const material = device.createMaterial(helpers.materialDesc());

    expect(() =>
      frame.drawInstanced(mesh, material, fullInstances(1), 1),
    ).not.toThrow();
    expect(device.stats.drawCalls).toBe(0);
    expect(device.stats.droppedDraws).toBe(1);
    device.endFrame();
  });

  test("[ER-04-10] non-positive and fractional counts are dropped", async () => {
    const { device, frame } = await begin();
    const mesh = device.createMesh(helpers.instancedMeshDesc());
    const material = device.createMaterial(helpers.materialDesc());
    const transforms = fullInstances(1);

    expect(() =>
      frame.drawInstanced(mesh, material, transforms, 0),
    ).not.toThrow();
    expect(() =>
      frame.drawInstanced(mesh, material, transforms, -1),
    ).not.toThrow();
    expect(() =>
      frame.drawInstanced(mesh, material, transforms, 1.5),
    ).not.toThrow();
    expect(device.stats.drawCalls).toBe(0);
    expect(device.stats.droppedDraws).toBe(3);
    device.endFrame();
  });

  test("[ER-04-15] readback still rejects in production", async () => {
    const { device } = await helpers.initialized();
    const texture = device.createTexture(readbackTextureDesc());
    const error = await helpers.errorOfAsync(
      device.readTexture(texture, { width: 1, height: 1 }),
    );
    expect(error.code).toBe("E_UNSUPPORTED_FEATURE");
    const frameError = await helpers.errorOfAsync(device.captureFrame());
    expect(frameError.code).toBe("E_UNSUPPORTED_FEATURE");
  });
});
