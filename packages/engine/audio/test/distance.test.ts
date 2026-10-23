/**
 * Spatial fallbacks — ER-09-02, ER-09-03 (unit half).
 *
 * `distanceGain` mirrors the three Web Audio distance models and runs only
 * when `createPanner` is absent. The fixture values come from spec 09 §7:
 * at ref 1 m, max 100 m, rolloff 1 the inverse model gives
 * 1 → 1, 5 → 0.2, 20 → 0.05, 200 → 0.01.
 *
 * `equalPowerGains` and `panForSource` back the stereo-panner fallback. The
 * offline-render checks in ER-09-02/03 (measured pan and attenuation samples)
 * stay PENDING; these tests prove the arithmetic only.
 */

import { describe, expect, test } from "vitest";
import { quatCreate } from "@lanpad/engine-core";
import { EngineListener } from "../src/spatial/Listener.js";
import { distanceGain, equalPowerGains, panForSource } from "../src/spatial/distance.js";
import { FakeContext, FakeListener, FakeNode, FakeParam } from "./support/fakeAudio.js";
import type { HostAudioListener } from "../src/host/types.js";

const FORWARD = { x: 0, y: 0, z: -1 };
const UP = { x: 0, y: 1, z: 0 };

function panAt(x: number, y: number, z: number): number {
  return panForSource(x, y, z, 0, 0, 0, FORWARD.x, FORWARD.y, FORWARD.z, UP.x, UP.y, UP.z);
}

describe("distance attenuation fallback", () => {
  test("[ER-09-03] inverse model matches the fixture values", () => {
    expect(distanceGain("inverse", 1, 1, 100, 1)).toBeCloseTo(1, 6);
    expect(distanceGain("inverse", 5, 1, 100, 1)).toBeCloseTo(0.2, 6);
    expect(distanceGain("inverse", 20, 1, 100, 1)).toBeCloseTo(0.05, 6);
    expect(distanceGain("inverse", 200, 1, 100, 1)).toBeCloseTo(0.01, 6);
  });

  test("[ER-09-03] linear model falls to zero at maxDistance", () => {
    expect(distanceGain("linear", 1, 1, 101, 1)).toBeCloseTo(1, 6);
    expect(distanceGain("linear", 51, 1, 101, 1)).toBeCloseTo(0.5, 6);
    expect(distanceGain("linear", 101, 1, 101, 1)).toBeCloseTo(0, 6);
    expect(distanceGain("linear", 500, 1, 101, 1)).toBeCloseTo(0, 6);
  });

  test("[ER-09-03] exponential model follows (d / ref) ^ −rolloff", () => {
    expect(distanceGain("exponential", 1, 1, 100, 1)).toBeCloseTo(1, 6);
    expect(distanceGain("exponential", 5, 1, 100, 1)).toBeCloseTo(0.2, 6);
    expect(distanceGain("exponential", 4, 2, 100, 2)).toBeCloseTo(0.25, 6);
  });

  test("[ER-09-03] inside refDistance is always 1 and never negative", () => {
    for (const model of ["inverse", "linear", "exponential"] as const) {
      expect(distanceGain(model, 0, 1, 100, 1)).toBe(1);
      expect(distanceGain(model, 0.5, 1, 100, 1)).toBe(1);
      expect(distanceGain(model, -3, 1, 100, 1)).toBe(1);
    }
  });

  test("[ER-09-03] the curve is monotonic non-increasing", () => {
    const distances = [0, 0.5, 1, 2, 5, 10, 20, 50, 100, 200];
    for (const model of ["inverse", "linear", "exponential"] as const) {
      let previous = Number.POSITIVE_INFINITY;
      for (const distance of distances) {
        const gain = distanceGain(model, distance, 1, 100, 1);
        expect(gain).toBeLessThanOrEqual(previous + 1e-12);
        expect(gain).toBeGreaterThanOrEqual(0);
        previous = gain;
      }
    }
  });
});

describe("equal-power panning", () => {
  test("[ER-09-02] hard left, centre and hard right", () => {
    expect(equalPowerGains(-1)).toEqual({ left: 1, right: 0 });
    const centre = equalPowerGains(0);
    expect(centre.left).toBeCloseTo(Math.SQRT1_2, 6);
    expect(centre.right).toBeCloseTo(Math.SQRT1_2, 6);
    expect(equalPowerGains(1).left).toBeCloseTo(0, 6);
    expect(equalPowerGains(1).right).toBeCloseTo(1, 6);
  });

  test("[ER-09-02] constant power across the pan range", () => {
    for (let pan = -1; pan <= 1; pan += 0.1) {
      const gains = equalPowerGains(pan);
      expect(gains.left * gains.left + gains.right * gains.right).toBeCloseTo(1, 6);
    }
  });

  test("[ER-09-02] out-of-range pans clamp", () => {
    expect(equalPowerGains(-4)).toEqual({ left: 1, right: 0 });
    const high = equalPowerGains(4);
    expect(high.left).toBeCloseTo(0, 6);
    expect(high.right).toBeCloseTo(1, 6);
  });
});

describe("pan against the listener basis", () => {
  test("[ER-09-02] +X is right and −X is left", () => {
    expect(panAt(1, 0, 0)).toBeCloseTo(1, 6);
    expect(panAt(-1, 0, 0)).toBeCloseTo(-1, 6);
    expect(panAt(2, 0, 0)).toBeCloseTo(1, 6);
    expect(panAt(-3, 0, 0)).toBeCloseTo(-1, 6);
  });

  test("[ER-09-02] front and back centre the source", () => {
    expect(panAt(0, 0, -5)).toBeCloseTo(0, 6);
    expect(panAt(0, 0, 5)).toBeCloseTo(0, 6);
  });

  test("[ER-09-02] a source at the listener has no direction", () => {
    expect(panAt(0, 0, 0)).toBe(0);
  });

  test("[ER-09-02] a degenerate basis yields centre, not NaN", () => {
    const pan = panForSource(1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0);
    expect(pan).toBe(0);
    const noUp = panForSource(1, 0, 0, 0, 0, 0, 0, 0, -1, 0, 0, -1);
    expect(Number.isNaN(noUp)).toBe(false);
  });

  test("[ER-09-02] a rotated listener turns the same source around", () => {
    // Yaw +90° about +Y: forward becomes (−1, 0, 0), right becomes (0, 0, −1).
    // The source at +X is now behind (pan 0); the source at +Z is now left.
    const behind = panForSource(1, 0, 0, 0, 0, 0, -1, 0, 0, 0, 1, 0);
    expect(behind).toBeCloseTo(0, 6);
    const left = panForSource(0, 0, 1, 0, 0, 0, -1, 0, 0, 0, 1, 0);
    expect(left).toBeCloseTo(-1, 6);
  });
});

describe("EngineListener", () => {
  test("[ER-09-02] writer yaw +90° looks down −X with +Y up", () => {
    const listener = new EngineListener(() => undefined);
    const halfTurn = Math.PI / 2;
    listener.setFromTransform(
      { x: 0, y: 0, z: 0 },
      quatCreate(0, Math.sin(halfTurn / 2), 0, Math.cos(halfTurn / 2)),
    );
    expect(listener.forwardX).toBeCloseTo(-1, 6);
    expect(listener.forwardY).toBeCloseTo(0, 6);
    expect(listener.forwardZ).toBeCloseTo(0, 6);
    expect(listener.upX).toBeCloseTo(0, 6);
    expect(listener.upY).toBeCloseTo(1, 6);
    expect(listener.upZ).toBeCloseTo(0, 6);
  });

  test("[ER-09-02] attach writes position and orientation AudioParams", () => {
    const context = new FakeContext({ currentTime: 4 });
    const listener = new EngineListener(() => undefined);
    listener.attach(context);
    listener.setPosition(1, 2, 3);

    const host = context.listener as FakeListener;
    // `setTargetAtTime` schedules; the fake records the value rather than
    // resolving the approach, exactly like a real AudioParam's `value`.
    expect(host.positionX.writes.at(-1)?.value).toBe(1);
    expect(host.positionY.writes.at(-1)?.value).toBe(2);
    expect(host.positionZ.writes.at(-1)?.value).toBe(3);
    expect(host.forwardZ.writes.at(-1)?.value).toBe(-1);
    expect(host.upY.writes.at(-1)?.value).toBe(1);
    const lastY = host.positionY.writes.at(-1);
    expect(lastY?.type).toBe("target");
    expect(lastY?.time).toBe(4);
    expect(listener.x).toBe(1);
    expect(listener.y).toBe(2);
    expect(listener.z).toBe(3);
  });

  test("[ER-09-02] non-finite input is ignored", () => {
    const context = new FakeContext();
    const listener = new EngineListener(() => undefined);
    listener.attach(context);
    listener.setPosition(Number.NaN, 0, 0);
    listener.setOrientation(0, 0, 0, 0, 1, 0);
    expect(listener.x).toBe(0);
    expect(listener.forwardZ).toBe(-1);
  });

  test("[ER-09-02] a listener with only setPosition/setOrientation still updates", () => {
    const calls: number[][] = [];
    const legacy: HostAudioListener = {
      setPosition: (x, y, z) => calls.push([x, y, z]),
      setOrientation: (fx, fy, fz, ux, uy, uz) => calls.push([fx, fy, fz, ux, uy, uz]),
    };
    const context = {
      currentTime: 1,
      state: "running" as const,
      destination: new FakeNode(),
      listener: legacy,
      createGain: () => {
        throw new Error("unused");
      },
      createBufferSource: () => {
        throw new Error("unused");
      },
    };
    const listener = new EngineListener(() => undefined);
    listener.attach(context as unknown as FakeContext);
    listener.setPosition(5, 6, 7);
    expect(calls.at(-2)).toEqual([5, 6, 7]);
    expect(calls.at(-1)).toEqual([0, 0, -1, 0, 1, 0]);
  });

  test("[ER-09-02] a change notifies the owner exactly once", () => {
    let changes = 0;
    const listener = new EngineListener(() => {
      changes += 1;
    });
    listener.attach(new FakeContext());
    changes = 0;
    listener.setPosition(1, 0, 0);
    expect(changes).toBe(1);
    listener.setOrientation(0, 0, -1, 0, 1, 0);
    expect(changes).toBe(2);
  });

  test("[ER-09-02] position params are written alongside orientation", () => {
    const param = new FakeParam();
    const split: HostAudioListener = {
      positionX: param,
      positionY: new FakeParam(),
      positionZ: new FakeParam(),
      forwardX: new FakeParam(),
      forwardY: new FakeParam(),
      forwardZ: new FakeParam(),
      upX: new FakeParam(),
      upY: new FakeParam(),
      upZ: new FakeParam(),
    };
    const context = new FakeContext();
    (context as unknown as { listener: HostAudioListener }).listener = split;
    const listener = new EngineListener(() => undefined);
    listener.attach(context);
    listener.setPosition(2, 3, 4);
    expect(param.writes.at(-1)?.value).toBe(2);
  });
});
