/**
 * Readback and capture tests (04 §5.14, ER-04-15 partial).
 *
 * The M0 WebGPU backend rejects both readback entry points with
 * `E_UNSUPPORTED_FEATURE`; `gpuFrameMs` stays null because timestamp queries
 * are not requested. Node-only evidence against the fake GPU.
 *
 * Deliberately not covered: ER-04-15's RGBA8 golden fixture, the fifth
 * in-flight readback limit and one-frame-later timestamp publication. Those
 * remain PENDING until readback is implemented; no `readback-rgba8.json`
 * fixture exists in this package yet.
 */

import { describe, expect, test } from "vitest";
import type { TextureDesc } from "@lanpad/engine-core";
import {
  errorOfAsync,
  initialized,
  materialDesc,
  orthoProjection,
  staticMeshDesc,
  translation,
} from "./helpers.js";

function textureDesc(): TextureDesc {
  return {
    label: "readback-texture",
    width: 1,
    height: 1,
    format: "rgba8unorm-srgb",
    usage: ["sample", "copy-dst"],
    data: [
      {
        mipLevel: 0,
        layer: 0,
        bytes: new Uint8Array([255, 255, 255, 255]),
        bytesPerRow: 4,
      },
    ],
  };
}

describe("M0 readback surface", () => {
  test("[ER-04-15] readTexture rejects E_UNSUPPORTED_FEATURE asynchronously", async () => {
    const { device } = await initialized();
    const texture = device.createTexture(textureDesc());
    let settled = false;
    const promise = device.readTexture(texture, { width: 1, height: 1 });
    promise.catch(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    const error = await errorOfAsync(promise);
    expect(error.code).toBe("E_UNSUPPORTED_FEATURE");
    expect(error.message).toContain("readTexture");
  });

  test("[ER-04-15] captureFrame rejects E_UNSUPPORTED_FEATURE asynchronously", async () => {
    const { device } = await initialized();
    let thrown: unknown = null;
    let probe: Promise<unknown> | undefined;
    try {
      probe = device.captureFrame();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeNull();
    if (probe === undefined) {
      throw new Error("captureFrame returned no promise");
    }
    const error = await errorOfAsync(probe);
    expect(error.code).toBe("E_UNSUPPORTED_FEATURE");
    expect(error.message).toContain("captureFrame");
  });

  test("[ER-04-15] no timestamp capability or timing figure is published", async () => {
    const { device } = await initialized();
    expect(device.capabilities.supportsTimestamps).toBe(false);
    expect(device.capabilities.supportsPost).toBe(false);
    expect(device.stats.gpuFrameMs).toBeNull();
    const frame = device.beginFrame();
    frame.setCamera(orthoProjection());
    const mesh = device.createMesh(staticMeshDesc());
    const material = device.createMaterial(materialDesc());
    frame.draw(mesh, material, translation(0, 0, -50));
    device.endFrame();
    expect(device.stats.gpuFrameMs).toBeNull();
    expect(typeof device.stats.cpuFrameMs).toBe("number");
    expect(device.stats.cpuFrameMs).toBeGreaterThanOrEqual(0);
  });

  test("[ER-04-15] readback rejection is not a synchronous throw", async () => {
    const { device } = await initialized();
    const texture = device.createTexture(textureDesc());
    let thrown: unknown = null;
    let probe: Promise<Uint8Array> | undefined;
    try {
      probe = device.readTexture(texture, { width: 1, height: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeNull();
    if (probe === undefined) {
      throw new Error("readTexture returned no promise");
    }
    await errorOfAsync(probe);
    // A forged handle behaves identically: validation never runs because the
    // feature is rejected before the handle is inspected.
    const forged = { ...texture, index: texture.index + 10_000 };
    const error = await errorOfAsync(
      device.readTexture(forged, { width: 1, height: 1 }),
    );
    expect(error.code).toBe("E_UNSUPPORTED_FEATURE");
  });
});
