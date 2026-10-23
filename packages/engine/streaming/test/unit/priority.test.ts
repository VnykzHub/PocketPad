/**
 * Focus scoring, class assignment, sort order and the LOD2 cap for distant
 * focuses (spec 12 §5.3/§5.4, ER-12-11).
 *
 * All distances here are XZ distances to the cell rectangle, so a cell that
 * contains the focus scores 0 and neighbouring rings step by the uncovered
 * span (54 m, 118 m, 182 m, ... for 64 m cells with the focus at 10,10).
 */

import { describe, expect, it } from "vitest";
import type { CellKey, Lod, PriorityCandidate, StreamView } from "../../src/index.js";
import {
  PriorityPlanner,
  clampFocusWeight,
  comparePriorityCandidates,
  lookAheadPosition,
} from "../../src/index.js";
import { createTestWorld, expectCode } from "../support/world-fixture.js";

const world = createTestWorld({ size: 8 });

function view(
  focus: StreamView["focus"],
  cameraPosition = { x: 10, y: 0, z: 10 },
  cameraForward = { x: 1, y: 0, z: 0 },
): StreamView {
  return { focus, cameraPosition, cameraForward, cameraHalfFovRad: 0.6 };
}

function find(
  candidates: readonly PriorityCandidate[],
  key: string,
  kind: "sim" | "visual",
): PriorityCandidate | undefined {
  return candidates.find((candidate) => candidate.key === key && candidate.kind === kind);
}

function lodOf(
  candidates: readonly PriorityCandidate[],
  key: string,
): Lod | null | undefined {
  return find(candidates, key, "visual")?.lod;
}

describe("focus weights and look-ahead", () => {
  it("[ER-12-11] clamps weights to [0.25, 4] and defaults to 1", () => {
    expect(clampFocusWeight(undefined)).toBe(1);
    expect(clampFocusWeight(0)).toBe(0.25);
    expect(clampFocusWeight(0.25)).toBe(0.25);
    expect(clampFocusWeight(2)).toBe(2);
    expect(clampFocusWeight(4)).toBe(4);
    expect(clampFocusWeight(9)).toBe(4);
  });

  it("[ER-12-11] rejects a non-finite weight", async () => {
    await expectCode(() => clampFocusWeight(Number.NaN), "E_STREAM_STATE");
    await expectCode(() => clampFocusWeight(Number.POSITIVE_INFINITY), "E_STREAM_STATE");
  });

  it("[ER-12-11] projects 2 s of travel and clamps it to 64 m", () => {
    expect(lookAheadPosition({ x: 0, z: 0 }, { x: 10, z: 0 })).toEqual({ x: 20, z: 0 });
    // 40 m/s * 2 s = 80 m, clamped to 64 m along the same heading.
    const fast = lookAheadPosition({ x: 0, z: 0 }, { x: 40, z: 0 });
    expect(fast?.x).toBeCloseTo(64, 9);
    expect(fast?.z).toBeCloseTo(0, 9);
    // Diagonal clamp preserves the heading.
    const diagonal = lookAheadPosition({ x: 100, z: 100 }, { x: 30, z: 40 });
    expect(Math.hypot((diagonal?.x ?? 0) - 100, (diagonal?.z ?? 0) - 100)).toBeCloseTo(64, 9);
    expect(diagonal?.x).toBeCloseTo(100 + 38.4, 9);
    expect(diagonal?.z).toBeCloseTo(100 + 51.2, 9);
    expect(lookAheadPosition({ x: 0, z: 0 }, { x: 0, z: 0 })).toBeUndefined();
    expect(lookAheadPosition({ x: 0, z: 0 }, undefined)).toBeUndefined();
  });

  it("[ER-12-11] rejects a non-finite velocity", async () => {
    await expectCode(
      () => lookAheadPosition({ x: 0, z: 0 }, { x: Number.NaN, z: 0 }),
      "E_STREAM_STATE",
    );
  });
});

describe("demand planning", () => {
  it("[ER-12-11] classes the focus ring and picks bands from rectangle distance", () => {
    const planner = new PriorityPlanner(world.index);
    const candidates = planner.plan(view([{ position: { x: 10, y: 0, z: 10 } }]));

    const focusSim = find(candidates, "0,0", "sim");
    expect(focusSim?.priorityClass).toBe(0);
    expect(focusSim?.lod).toBeNull();
    expect(focusSim?.score).toBe(0);
    expect(focusSim?.distanceMeters).toBe(0);

    // Adjacent cells are class-0 simulation too; their visual LOD0 is class 0.
    const adjacent = find(candidates, "1,0", "sim");
    expect(adjacent?.priorityClass).toBe(0);
    expect(adjacent?.distanceMeters).toBe(54);
    expect(lodOf(candidates, "1,0")).toBe(0);
    expect(find(candidates, "1,0", "visual")?.priorityClass).toBe(0);

    // 118 m -> LOD1/class 2; 182 m -> LOD2/class 3; 246 m -> LOD2.
    expect(lodOf(candidates, "2,0")).toBe(1);
    expect(find(candidates, "2,0", "visual")?.priorityClass).toBe(2);
    expect(lodOf(candidates, "3,0")).toBe(2);
    expect(find(candidates, "3,0", "visual")?.priorityClass).toBe(3);
    expect(lodOf(candidates, "4,0")).toBe(2);
    expect(lodOf(candidates, "5,0")).toBe(3);
    expect(find(candidates, "5,0", "visual")?.priorityClass).toBe(4);

    // Beyond the 272 m simulation radius: visual only.
    expect(find(candidates, "5,0", "sim")).toBeUndefined();
    expect(find(candidates, "4,0", "sim")?.priorityClass).toBe(1);

    // Past the 472 m unload distance (cell 7 spans 448..512 m; distance 438).
    expect(lodOf(candidates, "7,0")).toBe(3);
    expect(find(candidates, "7,0", "sim")).toBeUndefined();
  });

  it("[ER-12-11] divides the score by the focus weight", () => {
    const planner = new PriorityPlanner(world.index);
    const weighted = planner.plan(
      view([{ position: { x: 10, y: 0, z: 10 }, weight: 4 }]),
    );
    expect(find(weighted, "2,0", "visual")?.score).toBe(29.5);
    expect(find(weighted, "2,0", "visual")?.distanceMeters).toBe(118);
    expect(lodOf(weighted, "2,0")).toBe(1);

    const light = planner.plan(
      view([{ position: { x: 10, y: 0, z: 10 }, weight: 0 }]),
    );
    expect(find(light, "2,0", "visual")?.score).toBe(472); // 118 / 0.25
  });

  it("[ER-12-11] adds a look-ahead sample at half weight", () => {
    const planner = new PriorityPlanner(world.index);
    const still = planner.plan(view([{ position: { x: 10, y: 0, z: 10 } }]));
    expect(lodOf(still, "2,0")).toBe(1);

    const moving = planner.plan(
      view([
        {
          position: { x: 10, y: 0, z: 10 },
          velocity: { x: 40, y: 0, z: 0 },
        },
      ]),
    );
    expect(lodOf(moving, "2,0")).toBe(0);
    // min(118 / 1, 54 / 0.5) = 108.
    expect(find(moving, "2,0", "visual")?.score).toBe(108);
    expect(find(moving, "2,0", "sim")?.priorityClass).toBe(1);
  });

  it("[ER-12-11] applies the behind-camera penalty to the cell center", () => {
    const planner = new PriorityPlanner(world.index);
    const candidates = planner.plan(
      view([{ position: { x: 96, y: 0, z: 32 } }], { x: 160, y: 0, z: 32 }),
    );
    // Cell 0,0 is 32 m behind the focus and its center is behind the camera.
    expect(find(candidates, "0,0", "visual")?.score).toBe(48);
    // Cell 2,0 is also 32 m from the focus but in front of the camera.
    expect(find(candidates, "2,0", "visual")?.score).toBe(32);
    // No forward vector: no penalty.
    const noForward = planner.plan(
      view(
        [{ position: { x: 96, y: 0, z: 32 } }],
        { x: 160, y: 0, z: 32 },
        { x: 0, y: 0, z: 0 },
      ),
    );
    expect(find(noForward, "0,0", "visual")?.score).toBe(32);
  });

  it("[ER-12-11] honours current LODs inside a hysteresis dead band", () => {
    const planner = new PriorityPlanner(world.index);
    const current = new Map<CellKey, Lod>([["4,0", 3]]);
    const candidates = planner.plan(view([{ position: { x: 10, y: 0, z: 10 } }]), current);
    // 246 m is inside the LOD2 dead band (240, 272]; never-loaded -> LOD2,
    // currently LOD3 -> stays LOD3.
    expect(lodOf(candidates, "4,0")).toBe(3);
    const fresh = planner.plan(view([{ position: { x: 10, y: 0, z: 10 } }]));
    expect(lodOf(fresh, "4,0")).toBe(2);
  });

  it("[ER-12-11] honours a custom simulation radius", () => {
    const planner = new PriorityPlanner(world.index, { simRadiusMeters: 100 });
    const candidates = planner.plan(view([{ position: { x: 10, y: 0, z: 10 } }]));
    expect(find(candidates, "1,0", "sim")).toBeDefined();
    expect(find(candidates, "2,0", "sim")).toBeUndefined();
  });
});

describe("many focuses and distant players", () => {
  it("[ER-12-11] caps distant focus cells at LOD2 while keeping simulation demand", () => {
    const big = createTestWorld({ size: 32 });
    const planner = new PriorityPlanner(big.index);
    // Camera far from the distant player; the near player sits at the camera.
    const candidates = planner.plan(
      view(
        [
          { position: { x: 0, y: 0, z: 0 } }, // cell 0,0 — distant
          { position: { x: 1000, y: 0, z: 32 } }, // cell 15,0 — at the camera
        ],
        { x: 1000, y: 0, z: 32 },
      ),
    );
    expect(find(candidates, "0,0", "sim")?.priorityClass).toBe(0);
    expect(lodOf(candidates, "0,0")).toBe(2);
    expect(lodOf(candidates, "15,0")).toBe(0);
    expect(find(candidates, "15,0", "sim")?.priorityClass).toBe(0);
  });

  it("[ER-12-11] accepts ten focus points and rejects eleven", async () => {
    const planner = new PriorityPlanner(world.index);
    const ten = Array.from({ length: 10 }, (_, index) => ({
      position: { x: 10 + index * 4, y: 0, z: 10 },
    }));
    expect(() => planner.plan(view(ten))).not.toThrow();

    const eleven = Array.from({ length: 11 }, (_, index) => ({
      position: { x: 10 + index * 4, y: 0, z: 10 },
    }));
    await expectCode(() => planner.plan(view(eleven)), "E_STREAM_STATE");
  });

  it("[ER-12-11] produces a total deterministic order", () => {
    const planner = new PriorityPlanner(world.index);
    const focus = [{ position: { x: 10, y: 0, z: 10 } }];
    const first = planner.plan(view(focus)).map((candidate) => ({ ...candidate }));
    const second = planner.plan(view(focus)).map((candidate) => ({ ...candidate }));
    expect(second).toEqual(first);

    // Reversing focus order cannot change the min-score demand set.
    const summarize = (candidates: readonly PriorityCandidate[]) =>
      candidates.map((candidate) => ({
        key: candidate.key,
        kind: candidate.kind,
        lod: candidate.lod,
        score: candidate.score,
      }));
    const reversed = summarize(
      planner.plan(
        view([
          { position: { x: 400, y: 0, z: 10 } },
          { position: { x: 10, y: 0, z: 10 } },
        ]),
      ),
    );
    const forward = summarize(
      planner.plan(
        view([
          { position: { x: 10, y: 0, z: 10 } },
          { position: { x: 400, y: 0, z: 10 } },
        ]),
      ),
    );
    expect(reversed).toEqual(forward);

    for (let index = 1; index < first.length; index += 1) {
      const previous = first[index - 1] as PriorityCandidate;
      const current = first[index] as PriorityCandidate;
      expect(comparePriorityCandidates(previous, current)).toBeLessThanOrEqual(0);
    }
  });

  it("[ER-12-11] returns an empty plan without focus points", () => {
    const planner = new PriorityPlanner(world.index);
    expect(planner.plan(view([])).length).toBe(0);
  });
});

describe("candidate comparator", () => {
  const base: PriorityCandidate = {
    key: "1,1",
    cx: 1,
    cy: 1,
    kind: "visual",
    lod: 1,
    priorityClass: 2,
    score: 10,
    distanceMeters: 10,
  };

  it("[ER-12-11] orders by class, score, cx, cy, kind and lod", () => {
    expect(comparePriorityCandidates({ ...base, priorityClass: 1 }, base)).toBeLessThan(0);
    expect(comparePriorityCandidates({ ...base, score: 9 }, base)).toBeLessThan(0);
    expect(comparePriorityCandidates({ ...base, cx: 0 }, base)).toBeLessThan(0);
    expect(comparePriorityCandidates({ ...base, cy: 2 }, base)).toBeGreaterThan(0);
    expect(comparePriorityCandidates({ ...base, kind: "sim", lod: null }, base)).toBeLessThan(0);
    expect(comparePriorityCandidates({ ...base, lod: 2 }, base)).toBeGreaterThan(0);
    expect(comparePriorityCandidates(base, { ...base })).toBe(0);
  });
});
