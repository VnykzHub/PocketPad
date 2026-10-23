/**
 * Host tick order conformance (01 §3.7, §7 ER-01-12).
 *
 * The fixture is the normative order. This suite also runs the hooks and
 * asserts the engine-only step 7 is a no-op for a host without a scene.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import type { HostTickSteps } from "../../src/time/index.js";
import { HOST_TICK_STEP_IDS, runHostTick } from "../../src/time/index.js";

interface TickOrderEntry {
  readonly order: number;
  readonly id: string;
  readonly description: string;
  readonly engineOnly: boolean;
}

interface TickOrderFixture {
  readonly formatVersion: number;
  readonly synthetic: boolean;
  readonly source: string;
  readonly note: string;
  readonly tickOrder: readonly TickOrderEntry[];
}

const FIXTURE = JSON.parse(
  readFileSync(new URL("../conformance/tick-order.json", import.meta.url), "utf8"),
) as TickOrderFixture;

test("[ER-01-12] the declared host tick order matches the normative fixture", () => {
  expect(FIXTURE.formatVersion).toBe(1);
  expect(FIXTURE.tickOrder).toHaveLength(7);
  expect(FIXTURE.tickOrder.map((entry) => entry.order)).toEqual([
    1, 2, 3, 4, 5, 6, 7,
  ]);
  expect(FIXTURE.tickOrder.map((entry) => entry.id)).toEqual([
    ...HOST_TICK_STEP_IDS,
  ]);
  expect(
    FIXTURE.tickOrder
      .filter((entry) => entry.engineOnly)
      .map((entry) => entry.id),
  ).toEqual(["scene-world-transforms"]);
});

test("[ER-01-12] runHostTick calls the seven hooks in fixture order", () => {
  const calls: string[] = [];
  let polledTick = -1;
  let simulatedDt = -1;

  const steps: HostTickSteps = {
    updateTilt: (dt) => {
      calls.push("tilt-update");
      expect(dt).toBeCloseTo(1 / 60, 12);
    },
    pollInput: (tick) => {
      calls.push("input-poll");
      polledTick = tick;
    },
    updateInputReader: () => {
      calls.push("input-reader-update");
    },
    drainControllerEvents: () => {
      calls.push("controller-events");
    },
    simulate: (dt) => {
      calls.push("game-simulate");
      simulatedDt = dt;
    },
    applyJobResults: () => {
      calls.push("apply-job-results");
    },
    updateWorldTransforms: () => {
      calls.push("scene-world-transforms");
    },
  };

  runHostTick(steps, 1 / 60, 42);

  expect(calls).toEqual(FIXTURE.tickOrder.map((entry) => entry.id));
  expect(polledTick).toBe(42);
  expect(simulatedDt).toBe(1 / 60);
});

test("[ER-01-12] step 7 is a no-op when the host has no engine scene", () => {
  const calls: string[] = [];

  runHostTick(
    {
      simulate: () => {
        calls.push("game-simulate");
      },
      applyJobResults: () => {
        calls.push("apply-job-results");
      },
    },
    1 / 60,
    7,
  );

  expect(calls).toEqual(["game-simulate", "apply-job-results"]);
  expect(() => runHostTick({}, 1 / 60, 0)).not.toThrow();
});
