/**
 * ER-07-09 — 2D migration parity (07 §5.15, 07 §8).
 *
 * The checked-in `fixtures/coin-run-300.json` was generated on 2026-10-23 by
 * running `harness.ts` against the pre-migration
 * `packages/runtime/src/physics` code. This test runs the identical scenario
 * against `src/two-d` and requires exact equality of every one of the 300 tick
 * hashes plus the sampled and final positions/velocities. No tolerance is
 * applied: a single changed bit in the solver fails here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import * as twoD from "../../src/two-d/index.js";
import {
  runScenario,
  type RunSample,
  type Scenario,
} from "./harness.js";

interface FixtureExpected {
  readonly mode: string;
  readonly tickHashes: readonly string[];
  readonly samples: readonly RunSample[];
  readonly final: RunSample;
}

interface Fixture {
  readonly formatVersion: number;
  readonly requirement: string;
  readonly scenario: Scenario;
  readonly expected: FixtureExpected;
}

const fixturePath = fileURLToPath(
  new URL("./fixtures/coin-run-300.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
const result = runScenario(twoD, fixture.scenario);

describe("2D migration parity [ER-07-09]", () => {
  test("[ER-07-09] the golden fixture is the pre-migration Coin Run trace", () => {
    expect(fixture.formatVersion).toBe(1);
    expect(fixture.requirement).toBe("ER-07-09");
    expect(fixture.expected.mode).toBe("exact");
    expect(fixture.scenario.ticks).toBe(300);
    expect(fixture.expected.tickHashes).toHaveLength(300);
    expect(fixture.expected.final.tick).toBe(300);
  });

  test("[ER-07-09] every tick hash matches the pre-migration golden", () => {
    expect(result.hashes).toHaveLength(300);
    for (let tick = 0; tick < fixture.expected.tickHashes.length; tick += 1) {
      expect(
        result.hashes[tick],
        `tick ${tick + 1} hash diverged from the pre-migration code`,
      ).toBe(fixture.expected.tickHashes[tick]);
    }
  });

  test("[ER-07-09] tick-300 positions and velocities are bit-identical", () => {
    expect(result.final).toEqual(fixture.expected.final);
    expect(result.final.tick).toBe(300);
    expect(result.hashes[299]).toBe(fixture.expected.tickHashes[299]);
  });

  test("[ER-07-09] sampled intermediate states are bit-identical", () => {
    expect(result.samples).toEqual(fixture.expected.samples);
  });

  test("[ER-07-09] the moved solver keeps every body finite for 300 ticks", () => {
    for (const body of result.final.bodies) {
      expect(Number.isFinite(body.x), `body ${body.id} x`).toBe(true);
      expect(Number.isFinite(body.y), `body ${body.id} y`).toBe(true);
      expect(Number.isFinite(body.vx), `body ${body.id} vx`).toBe(true);
      expect(Number.isFinite(body.vy), `body ${body.id} vy`).toBe(true);
    }
  });
});
