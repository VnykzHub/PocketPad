/**
 * Public API lifecycle, counters, stats, hashing and pooled storage
 * (spec 08 §3.5, §5.2, §5.13, §5.14, ER-08-01).
 *
 * ER-08-01 itself is the full-gate row; this file supplies the unit evidence
 * for the facade contract.
 */

import { describe, expect, test } from "vitest";
import { createScene } from "@lanpad/engine-core";
import { createAnimationApi } from "../../src/api/AnimationApi.js";
import type { AnimationApiImpl } from "../../src/api/AnimationApi.js";
import {
  AnimationInstanceImpl,
  type AnimationActionHandle,
} from "../../src/api/AnimationInstance.js";
import type { AnimationEvent } from "../../src/contracts/animation.js";
import { loadClip, skeleton } from "../helpers/fixtures.js";

const STEP = 1 / 60;

function expectAnimationError(
  fn: () => unknown,
  code: string,
  pattern: RegExp,
): void {
  try {
    fn();
  } catch (error) {
    const shaped = error as {
      name?: string;
      code?: string;
      layer?: string;
      message?: string;
    };
    expect(shaped.name).toBe("EngineError");
    expect(shaped.code).toBe(code);
    expect(shaped.layer).toBe("animation");
    expect(shaped.message).toMatch(pattern);
    return;
  }
  throw new Error(`expected ${code} but no error was thrown`);
}

describe("[ER-08-01] instance lifecycle", () => {
  test("[ER-08-01] createInstance binds an entity and destroyInstance unbinds it", () => {
    const scene = createScene();
    const api = createAnimationApi({ scene });
    const entity = scene.createEntity();
    const first = api.createInstance(entity, skeleton);
    expect(api.getInstance(entity)).toBe(first);
    expect(first.id).toBe(0);
    expect((first as AnimationInstanceImpl).slot).toBe(0);
    expect((api as AnimationApiImpl).liveInstanceCount).toBe(1);

    api.destroyInstance(first);
    expect(api.getInstance(entity)).toBeNull();
    expect((api as AnimationApiImpl).liveInstanceCount).toBe(0);
    expect(api.stats.instanceCount).toBe(0);
    api.update(STEP); // no live instance; must not throw

    // The same live entity may be rebound; the dense slot is reused while the
    // id stays monotonic.
    const second = api.createInstance(entity, skeleton);
    expect(api.getInstance(entity)).toBe(second);
    expect(second.id).toBe(1);
    expect((second as AnimationInstanceImpl).slot).toBe(0);
    expect((api as AnimationApiImpl).liveInstanceCount).toBe(1);

    // Double destroy and update-after-destroy are no-ops.
    api.destroyInstance(second);
    api.destroyInstance(second);
    expect((api as AnimationApiImpl).liveInstanceCount).toBe(0);
    expect(() => second.play(loadClip("walk-1.0.json"))).toThrow(
      /destroyed instance/,
    );
    api.dispose();
    scene.dispose();
  });

  test("[ER-08-01] duplicate entities and dead entities are rejected", () => {
    const scene = createScene();
    const api = createAnimationApi({ scene });
    const entity = scene.createEntity();
    api.createInstance(entity, skeleton);
    expectAnimationError(
      () => api.createInstance(entity, skeleton),
      "E_CONTRACT",
      /already has an animation instance/,
    );

    const dead = scene.createEntity();
    scene.destroyEntity(dead);
    expectAnimationError(
      () => api.createInstance(dead, skeleton),
      "E_STALE_HANDLE",
      /dead entity/,
    );
    expect((api as AnimationApiImpl).liveInstanceCount).toBe(1);
    api.dispose();
    scene.dispose();
  });

  test("[ER-08-01] exceeding maxInstances returns a detached no-op instance", () => {
    const scene = createScene();
    const api = createAnimationApi({ scene, maxInstances: 2 });
    const firstEntity = scene.createEntity();
    const first = api.createInstance(firstEntity, skeleton);
    api.createInstance(scene.createEntity(), skeleton);
    const thirdEntity = scene.createEntity();
    const third = api.createInstance(thirdEntity, skeleton);
    const walk = loadClip("walk-1.0.json");

    expect((third as AnimationInstanceImpl).detached).toBe(true);
    expect(api.getInstance(thirdEntity)).toBeNull();
    expect((api as AnimationApiImpl).liveInstanceCount).toBe(2);
    expect((api as AnimationApiImpl).counters.noOpInstance).toBe(1);

    first.play(walk, { fadeOutPreviousSeconds: 0 });
    third.play(walk, { fadeOutPreviousSeconds: 0 });
    api.update(STEP);
    // The live instance advances; the detached third is skipped entirely.
    expect(first.getAction(0)!.time).toBeCloseTo(STEP, 12);
    expect(third.getAction(0)!.time).toBe(0);
    expect(api.stats.instanceCount).toBe(2);
    api.destroyInstance(third);
    expect(api.stats.instanceCount).toBe(2);
    api.dispose();
    scene.dispose();
  });
});

describe("[ER-08-01] update semantics", () => {
  test("[ER-08-01] a non-fixed dt is clamped and counted; invalid dt is ignored", () => {
    const scene = createScene();
    const api = createAnimationApi({ scene });
    const instance = api.createInstance(scene.createEntity(), skeleton);
    const action = instance.play(loadClip("walk-1.0.json"), {
      fadeOutPreviousSeconds: 0,
    });
    const counters = (api as AnimationApiImpl).counters;

    api.update(0.5);
    expect(counters.dtClamp).toBe(1);
    expect(action.time).toBeCloseTo(STEP, 12);
    api.update(0);
    api.update(-1);
    api.update(Number.NaN);
    expect(counters.dtClamp).toBe(1);
    expect(action.time).toBeCloseTo(STEP, 12);
    api.update(STEP);
    expect(action.time).toBeCloseTo(2 * STEP, 12);
    expect(counters.dtClamp).toBe(1);
    api.dispose();
    scene.dispose();
  });

  test("[ER-08-01] dispose is idempotent and shuts the facade down", () => {
    const scene = createScene();
    const api = createAnimationApi({ scene });
    const instance = api.createInstance(scene.createEntity(), skeleton);
    api.dispose();
    api.dispose();
    expect(api.stats.instanceCount).toBe(0);
    expect((api as AnimationApiImpl).liveInstanceCount).toBe(0);
    expect(api.drainEvents([])).toBe(0);
    expect(() => api.update(STEP)).not.toThrow();
    expect(() => api.destroyInstance(instance)).not.toThrow();
    expectAnimationError(
      () => api.createInstance(scene.createEntity(), skeleton),
      "E_CONTRACT",
      /dispose/,
    );
    scene.dispose();
  });

  test("[ER-08-01] stats report live instances, tracks, clips and pose bytes", () => {
    const scene = createScene();
    const api = createAnimationApi({ scene });
    const walk = loadClip("walk-1.0.json");
    const first = api.createInstance(scene.createEntity(), skeleton);
    const second = api.createInstance(scene.createEntity(), skeleton);
    first.play(walk, { fadeOutPreviousSeconds: 0 });
    second.play(walk, { fadeOutPreviousSeconds: 0 });
    api.update(STEP);

    const stats = api.stats;
    expect(stats.instanceCount).toBe(2);
    expect(stats.jointCount).toBe(2 * skeleton.jointCount);
    expect(stats.activeActionCount).toBe(2);
    expect(stats.sampledTrackCount).toBe(2 * walk.tracks.length);
    expect(stats.eventsEmitted).toBe(0);
    expect(stats.eventsDropped).toBe(0);
    expect(stats.updateMs).toBe(0);
    expect(stats.paletteMs).toBe(0);
    expect(stats.clipBytes).toBe(walk.sourceBytes);
    expect(stats.poseBytes).toBe(2 * skeleton.jointCount * 80);
    api.dispose();
    scene.dispose();
  });

  test("[ER-08-01] stateHash changes when the pending event queue is drained", () => {
    const scene = createScene();
    const api = createAnimationApi({ scene });
    const instance = api.createInstance(scene.createEntity(), skeleton);
    instance.play(loadClip("events-loop.json"), { fadeOutPreviousSeconds: 0 });
    for (let tick = 0; tick < 7; tick += 1) api.update(STEP);

    const pending = api.stateHash();
    expect(api.stateHash()).toBe(pending);
    const out: AnimationEvent[] = new Array(8);
    expect(api.drainEvents(out)).toBe(1);
    const drained = api.stateHash();
    expect(drained).not.toBe(pending);
    // Draining an empty queue changes nothing.
    expect(api.drainEvents(out)).toBe(0);
    expect(api.stateHash()).toBe(drained);
    api.dispose();
    scene.dispose();
  });
});

describe("[ER-08-01] pooled storage", () => {
  test("[ER-08-01] action slots and pose buffers are reused after warm-up", () => {
    const scene = createScene();
    const api = createAnimationApi({ scene });
    const instance = api.createInstance(scene.createEntity(), skeleton);
    const impl = instance as AnimationInstanceImpl;
    const walk = loadClip("walk-1.0.json");
    instance.play(walk, { fadeOutPreviousSeconds: 0 });
    api.update(STEP);

    const currentTranslations = impl.currentPose.translations;
    const currentRotations = impl.currentPose.rotations;
    const currentScales = impl.currentPose.scales;
    const previousTranslations = impl.previousPose.translations;
    const handleCount = impl.actions.length;
    const handleRefs: AnimationActionHandle[] = impl.actions.slice();

    for (let cycle = 0; cycle < 32; cycle += 1) {
      instance.play(walk, { fadeOutPreviousSeconds: 0 });
      api.update(STEP);
    }

    expect(impl.actions.length).toBe(handleCount);
    expect(impl.actions).toEqual(handleRefs);
    expect(impl.actions.filter((action) => action.active)).toHaveLength(1);
    expect(impl.currentPose.translations).toBe(currentTranslations);
    expect(impl.currentPose.rotations).toBe(currentRotations);
    expect(impl.currentPose.scales).toBe(currentScales);
    expect(impl.previousPose.translations).toBe(previousTranslations);
    expect(impl.previousPose.translations).not.toBe(currentTranslations);
    // Buffers stay sized for the skeleton; no per-tick growth.
    expect(impl.currentPose.translations.length).toBe(skeleton.jointCount * 3);
    expect(impl.currentPose.rotations.length).toBe(skeleton.jointCount * 4);
    expect(impl.currentPose.scales.length).toBe(skeleton.jointCount * 3);
    expect(api.stats.activeActionCount).toBe(1);
    api.dispose();
    scene.dispose();
  });
});
