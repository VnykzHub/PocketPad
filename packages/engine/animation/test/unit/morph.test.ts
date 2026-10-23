/**
 * Morph-target weights from clips and gameplay, clamping, clipping to the
 * instance target count and hash visibility (spec 08 §3.2, ER-08-10).
 *
 * ER-08-10 is an M2 acceptance that also requires WebGPU/WebGL2 frames. This
 * file is CPU-only evidence for the weight path; the GPU half stays PENDING.
 */

import { describe, expect, test } from "vitest";
import { createScene } from "@lanpad/engine-core";
import { createAnimationApi } from "../../src/api/AnimationApi.js";
import { loadClip, skeleton } from "../helpers/fixtures.js";

const STEP = 1 / 60;

/** Fixture weight for target `target` at normalized time `t` (§5.4 linear). */
function expectedWeight(target: number, t: number): number {
  const start = target / 7;
  const end = 1 - target / 7;
  return start + (end - start) * t;
}

describe("[ER-08-10] morph weights", () => {
  test("[ER-08-10] a clip drives all eight targets and the weights are exposed", () => {
    const scene = createScene();
    const entity = scene.createEntity();
    const api = createAnimationApi({ scene });
    const instance = api.createInstance(entity, skeleton, { morphTargets: 8 });
    instance.play(loadClip("morph-8.json"), { fadeOutPreviousSeconds: 0 });
    api.update(STEP);

    expect(instance.morphWeights).toHaveLength(8);
    for (let target = 0; target < 8; target += 1) {
      expect(
        instance.morphWeights[target],
        `target ${target} after one tick`,
      ).toBeCloseTo(expectedWeight(target, STEP), 6);
    }
    api.dispose();
    scene.dispose();
  });

  test("[ER-08-10] targets beyond the instance count are ignored", () => {
    const scene = createScene();
    const entity = scene.createEntity();
    const api = createAnimationApi({ scene });
    const instance = api.createInstance(entity, skeleton, { morphTargets: 4 });
    instance.play(loadClip("morph-8.json"), { fadeOutPreviousSeconds: 0 });
    api.update(STEP);

    expect(instance.morphWeights).toHaveLength(4);
    for (let target = 0; target < 4; target += 1) {
      expect(instance.morphWeights[target]).toBeCloseTo(
        expectedWeight(target, STEP),
        6,
      );
    }
    api.dispose();
    scene.dispose();
  });

  test("[ER-08-10] setMorphWeight clamps and combines with the clip", () => {
    const scene = createScene();
    const entity = scene.createEntity();
    const api = createAnimationApi({ scene });
    const instance = api.createInstance(entity, skeleton, { morphTargets: 8 });
    instance.play(loadClip("morph-8.json"), { fadeOutPreviousSeconds: 0 });
    api.update(STEP);

    instance.setMorphWeight(0, 0.25);
    expect(instance.morphWeights[0]).toBeCloseTo(
      expectedWeight(0, STEP) + 0.25,
      6,
    );

    // Gameplay weights clamp to [0, 1] and the sum clamps to [0, 1].
    instance.setMorphWeight(1, 0.9);
    expect(instance.morphWeights[1]).toBe(1);
    instance.setMorphWeight(2, -0.5);
    expect(instance.morphWeights[2]).toBeCloseTo(expectedWeight(2, STEP), 6);
    instance.setMorphWeight(3, 2);
    expect(instance.morphWeights[3]).toBe(1);

    expect(() => instance.setMorphWeight(8, 0)).toThrow(/morph target/);
    expect(() => instance.setMorphWeight(-1, 0)).toThrow(/morph target/);
    expect(() => instance.setMorphWeight(1.5, 0)).toThrow(/morph target/);
    api.dispose();
    scene.dispose();
  });

  test("[ER-08-10] morph weights are part of the state hash", () => {
    const scene = createScene();
    const entity = scene.createEntity();
    const api = createAnimationApi({ scene });
    const instance = api.createInstance(entity, skeleton, { morphTargets: 8 });
    instance.play(loadClip("morph-8.json"), { fadeOutPreviousSeconds: 0 });
    api.update(STEP);

    const before = api.stateHash();
    instance.setMorphWeight(0, 0.25);
    const changed = api.stateHash();
    expect(changed).not.toBe(before);
    // Setting the same weight back restores the exact pre-change state.
    instance.setMorphWeight(0, 0);
    expect(api.stateHash()).toBe(before);
    // The same scenario in a second API hashes identically.
    const otherScene = createScene();
    const otherEntity = otherScene.createEntity();
    const otherApi = createAnimationApi({ scene: otherScene });
    const other = otherApi.createInstance(otherEntity, skeleton, {
      morphTargets: 8,
    });
    other.play(loadClip("morph-8.json"), { fadeOutPreviousSeconds: 0 });
    otherApi.update(STEP);
    expect(otherApi.stateHash()).toBe(before);
    api.dispose();
    scene.dispose();
    otherApi.dispose();
    otherScene.dispose();
  });

  test("[ER-08-10] the target count defaults to zero and validates its range", () => {
    const scene = createScene();
    const api = createAnimationApi({ scene });
    const plain = api.createInstance(scene.createEntity(), skeleton);
    expect(plain.morphWeights).toHaveLength(0);

    expect(() =>
      api.createInstance(scene.createEntity(), skeleton, { morphTargets: -1 }),
    ).toThrow(/morphTargets/);
    expect(() =>
      api.createInstance(scene.createEntity(), skeleton, {
        morphTargets: 1.5,
      }),
    ).toThrow(/morphTargets/);
    expect(() =>
      api.createInstance(scene.createEntity(), skeleton, { morphTargets: 33 }),
    ).toThrow(/morphTargets/);
    api.dispose();
    scene.dispose();
  });
});
