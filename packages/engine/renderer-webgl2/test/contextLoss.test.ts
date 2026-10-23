/**
 * ER-05-06: context loss and restore.
 *
 * The fake canvas dispatches `webglcontextlost`/`webglcontextrestored` and the
 * fake `WEBGL_lose_context` only sets flags. These tests prove epoch, dropped
 * frame and listener semantics; real driver loss behaviour stays PENDING and
 * needs browser/hardware evidence.
 */

import { describe, expect, test } from "vitest";
import { createWebGL2Device } from "../src/device.js";
import type { MutableRenderStats } from "../src/stats.js";
import {
  errorCodeOf,
  identity,
  materialDesc,
  textureDesc,
  triangleMesh,
} from "./helpers.js";
import { wireWebGL2 } from "./fake/canvas.js";

async function makeDevice() {
  const wired = wireWebGL2();
  const callbacks = { lost: 0, restored: 0 };
  const init = await createWebGL2Device({
    canvas: wired.canvas.asCanvas(),
    onContextLost: () => {
      callbacks.lost += 1;
    },
    onContextRestored: () => {
      callbacks.restored += 1;
    },
  });
  return { ...wired, init, device: init.device, callbacks };
}

interface LostEventLike {
  preventDefault(): void;
}

function dispatchLost(
  canvas: ReturnType<typeof wireWebGL2>["canvas"],
  fake: ReturnType<typeof wireWebGL2>["fake"],
  event: LostEventLike = { preventDefault: () => {} },
): LostEventLike {
  fake.contextLost = true;
  canvas.dispatch("webglcontextlost", event);
  return event;
}

function dispatchRestored(
  canvas: ReturnType<typeof wireWebGL2>["canvas"],
  fake: ReturnType<typeof wireWebGL2>["fake"],
): void {
  fake.contextLost = false;
  canvas.dispatch("webglcontextrestored", {});
}

function internalStats(device: { readonly stats: unknown }): MutableRenderStats {
  return device.stats as MutableRenderStats;
}

describe("[ER-05-06] context loss", () => {
  test("[ER-05-06] loss prevents the default, bumps the epoch and notifies once", async () => {
    const { device, canvas, fake, callbacks } = await makeDevice();
    const notices: Array<{ reason: string; message: string }> = [];
    device.onDeviceLost((info) => {
      notices.push({ reason: info.reason, message: info.message });
    });
    let prevented = 0;
    expect(device.contextEpoch).toBe(0);
    expect(device.lost).toBe(false);
    dispatchLost(canvas, fake, {
      preventDefault: () => {
        prevented += 1;
      },
    });
    expect(prevented).toBe(1);
    expect(device.lost).toBe(true);
    expect(device.contextEpoch).toBe(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.reason).toBe("unknown");
    expect(notices[0]?.message.length).toBeGreaterThan(0);
    expect(callbacks.lost).toBe(1);
  });

  test("[ER-05-06] a repeated loss event does not double-count", async () => {
    const { device, canvas, fake, callbacks } = await makeDevice();
    let notified = 0;
    device.onDeviceLost(() => {
      notified += 1;
    });
    let prevented = 0;
    const event = {
      preventDefault: () => {
        prevented += 1;
      },
    };
    dispatchLost(canvas, fake, event);
    dispatchLost(canvas, fake, event);
    expect(prevented).toBe(2);
    expect(device.contextEpoch).toBe(1);
    expect(notified).toBe(1);
    expect(callbacks.lost).toBe(1);
  });

  test("[ER-05-06] a throwing listener does not stop later listeners", async () => {
    const { device, canvas, fake } = await makeDevice();
    const order: string[] = [];
    device.onDeviceLost(() => {
      order.push("first");
      throw new Error("listener failure");
    });
    device.onDeviceLost(() => {
      order.push("second");
    });
    dispatchLost(canvas, fake);
    expect(order).toEqual(["first", "second"]);
  });

  test("[ER-05-06] unsubscribing a lost listener removes it", async () => {
    const { device, canvas, fake } = await makeDevice();
    let notified = 0;
    const unsubscribe = device.onDeviceLost(() => {
      notified += 1;
    });
    unsubscribe();
    dispatchLost(canvas, fake);
    expect(notified).toBe(0);
  });

  test("[ER-05-06] frames while lost are invalid, counted and draw nothing", async () => {
    const { device, canvas, fake } = await makeDevice();
    const mesh = device.createMesh(triangleMesh());
    const material = device.createMaterial(materialDesc());
    dispatchLost(canvas, fake);

    const frame = device.beginFrame();
    expect(frame.valid).toBe(false);
    expect(internalStats(device).lostFrames).toBe(1);
    frame.draw(mesh, material, identity());
    expect(device.stats.drawCalls).toBe(0);
    expect(device.stats.droppedDraws).toBe(1);
    device.endFrame();

    device.beginFrame();
    device.endFrame();
    expect(internalStats(device).lostFrames).toBe(2);
  });

  test("[ER-05-06] creators refuse E_DEVICE_LOST while the context is lost", async () => {
    const { device, canvas, fake } = await makeDevice();
    dispatchLost(canvas, fake);
    expect(errorCodeOf(() => device.createBuffer({ size: 16 }))).toBe("E_DEVICE_LOST");
    expect(errorCodeOf(() => device.createTexture(textureDesc()))).toBe("E_DEVICE_LOST");
    expect(errorCodeOf(() => device.createMesh(triangleMesh()))).toBe("E_DEVICE_LOST");
    expect(errorCodeOf(() => device.createMaterial(materialDesc()))).toBe("E_DEVICE_LOST");
    expect(device.beginFrame().valid).toBe(false);
    device.endFrame();
  });

  test("[ER-05-06] restore while lost requests the context and reports device-lost", async () => {
    const { device, canvas, fake } = await makeDevice();
    dispatchLost(canvas, fake);
    expect(await device.restore()).toEqual({
      ok: false,
      reason: "device-lost",
      restoredHandles: 0,
      staleHandles: 0,
    });
    expect(fake.restoreRequested).toBe(true);
    expect(device.lost).toBe(true);
    expect(device.contextEpoch).toBe(1);
  });
});

describe("[ER-05-06] context restore", () => {
  test("[ER-05-06] the restored event rebuilds resources under the same handles", async () => {
    const { device, canvas, fake, callbacks } = await makeDevice();
    const buffer = device.createBuffer({ size: 32 });
    const texture = device.createTexture(textureDesc());
    const mesh = device.createMesh(triangleMesh());
    const material = device.createMaterial(materialDesc());
    expect(device.stats.textureBytes).toBe(256);
    expect(device.stats.bufferBytes).toBe(32 + 102 + 64);

    dispatchLost(canvas, fake);
    expect(device.lost).toBe(true);
    expect(await device.restore()).toEqual({
      ok: false,
      reason: "device-lost",
      restoredHandles: 0,
      staleHandles: 0,
    });
    dispatchRestored(canvas, fake);

    expect(device.lost).toBe(false);
    expect(device.contextEpoch).toBe(1);
    expect(callbacks.restored).toBe(1);
    expect(device.stats.textureBytes).toBe(256);
    expect(device.stats.bufferBytes).toBe(32 + 102 + 64);

    device.writeBuffer(buffer, 0, new Uint8Array(4));
    device.destroy(texture);
    const frame = device.beginFrame();
    expect(frame.valid).toBe(true);
    frame.draw(mesh, material, identity());
    device.endFrame();
    expect(device.stats.drawCalls).toBe(1);
  });

  test("[ER-05-06] restored listeners run after a successful rebuild", async () => {
    const { device, canvas, fake, callbacks } = await makeDevice();
    const order: string[] = [];
    device.onRestored(() => {
      order.push("throwing");
      throw new Error("restored listener failure");
    });
    device.onRestored(() => {
      order.push("second");
    });
    dispatchLost(canvas, fake);
    dispatchRestored(canvas, fake);
    expect(order).toEqual(["throwing", "second"]);
    expect(callbacks.restored).toBe(1);
  });

  test("[ER-05-06] a second loss after restore bumps the epoch again", async () => {
    const { device, canvas, fake } = await makeDevice();
    dispatchLost(canvas, fake);
    dispatchRestored(canvas, fake);
    expect(device.contextEpoch).toBe(1);
    dispatchLost(canvas, fake);
    expect(device.contextEpoch).toBe(2);
    expect(device.lost).toBe(true);
  });

  test("[ER-05-06] dispose detaches context listeners", async () => {
    const { device, canvas, fake, callbacks } = await makeDevice();
    expect(canvas.listenerCount("webglcontextlost")).toBe(1);
    expect(canvas.listenerCount("webglcontextrestored")).toBe(1);
    device.dispose();
    expect(canvas.listenerCount("webglcontextlost")).toBe(0);
    expect(canvas.listenerCount("webglcontextrestored")).toBe(0);
    let prevented = 0;
    dispatchLost(canvas, fake, {
      preventDefault: () => {
        prevented += 1;
      },
    });
    expect(prevented).toBe(0);
    expect(device.contextEpoch).toBe(0);
    expect(callbacks.lost).toBe(0);
  });
});
