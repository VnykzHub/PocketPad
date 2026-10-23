/**
 * Event windows, ordering, overflow and dominant-action emission
 * (spec 08 §5.8, ER-08-04).
 */

import { describe, expect, test } from "vitest";
import { createScene } from "@lanpad/engine-core";
import { createAnimationApi } from "../../src/api/AnimationApi.js";
import type { AnimationEvent } from "../../src/contracts/animation.js";
import {
  loadClip,
  loadGoldenEvents,
  skeleton,
} from "../helpers/fixtures.js";

const STEP = 1 / 60;

function collect(
  api: ReturnType<typeof createAnimationApi>,
  out: AnimationEvent[],
  into: AnimationEvent[],
): void {
  const count = api.drainEvents(out);
  for (let i = 0; i < count; i += 1) into.push(out[i]!);
}

describe("[ER-08-04] event emission", () => {
  test("[ER-08-04] three loops fire exactly 12 events in order", () => {
    const scene = createScene();
    const entity = scene.createEntity();
    const api = createAnimationApi({ scene });
    const instance = api.createInstance(entity, skeleton);
    instance.play(loadClip("events-loop.json"), { fadeOutPreviousSeconds: 0 });
    const golden = loadGoldenEvents();
    const seen: AnimationEvent[] = [];
    const out: AnimationEvent[] = new Array(8);
    for (let tick = 0; tick < 180; tick += 1) {
      api.update(STEP);
      collect(api, out, seen);
    }
    expect(seen).toHaveLength(12);
    for (let i = 0; i < seen.length; i += 1) {
      const expected = golden.events[i % golden.events.length]!;
      expect(seen[i]!.name).toBe(expected.name);
      expect(seen[i]!.payload).toBe(expected.payload);
      expect(seen[i]!.time).toBeCloseTo(expected.time, 5);
      expect(seen[i]!.clip.name).toBe("events-loop");
      expect(seen[i]!.entity.id).toBe(entity.id);
    }
    expect(api.stats.eventsEmitted).toBe(12);
    expect(api.stats.eventsDropped).toBe(0);
    api.dispose();
    scene.dispose();
  });

  test("[ER-08-04] a tick at the event time fires it once", () => {
    const scene = createScene();
    const entity = scene.createEntity();
    const api = createAnimationApi({ scene });
    const instance = api.createInstance(entity, skeleton);
    instance.play(loadClip("events-loop.json"), { fadeOutPreviousSeconds: 0 });
    const seen: AnimationEvent[] = [];
    const out: AnimationEvent[] = new Array(8);
    // Event at 0.10 s is reached on tick 7 (six accumulated steps are just
    // below 0.1 in f64); it must not fire before its time.
    for (let tick = 0; tick < 6; tick += 1) {
      api.update(STEP);
      collect(api, out, seen);
    }
    expect(seen).toHaveLength(0);
    api.update(STEP);
    collect(api, out, seen);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.name).toBe("beat.one");
    api.update(STEP);
    collect(api, out, seen);
    expect(seen).toHaveLength(1);
    api.dispose();
    scene.dispose();
  });

  test("[ER-08-04] pausing between ticks does not advance or duplicate", () => {
    const scene = createScene();
    const entity = scene.createEntity();
    const api = createAnimationApi({ scene });
    const instance = api.createInstance(entity, skeleton);
    instance.play(loadClip("events-loop.json"), { fadeOutPreviousSeconds: 0 });
    const seen: AnimationEvent[] = [];
    const out: AnimationEvent[] = new Array(8);
    for (let tick = 0; tick < 30; tick += 1) {
      api.update(STEP);
      collect(api, out, seen);
    }
    expect(seen).toHaveLength(2);
    expect(api.drainEvents(out)).toBe(0);
    expect(api.drainEvents(out)).toBe(0);
    for (let tick = 0; tick < 150; tick += 1) {
      api.update(STEP);
      collect(api, out, seen);
    }
    expect(seen).toHaveLength(12);
    api.dispose();
    scene.dispose();
  });

  test("[ER-08-04] only the dominant action emits during a crossfade", () => {
    const scene = createScene();
    const entity = scene.createEntity();
    const api = createAnimationApi({ scene });
    const instance = api.createInstance(entity, skeleton);
    instance.play(loadClip("events-loop.json"), { fadeOutPreviousSeconds: 0 });
    const seen: AnimationEvent[] = [];
    const out: AnimationEvent[] = new Array(8);
    for (let tick = 0; tick < 12; tick += 1) {
      api.update(STEP);
      collect(api, out, seen);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.name).toBe("beat.one");
    // A 0.5 s crossfade at t=0.2: the outgoing clip is dominant until ~0.45
    // (event 0.40 fires), then the walk clip is dominant (no events).
    instance.play(loadClip("walk-1.0.json"), { fadeOutPreviousSeconds: 0.5 });
    for (let tick = 0; tick < 60; tick += 1) {
      api.update(STEP);
      collect(api, out, seen);
    }
    expect(seen).toHaveLength(2);
    expect(seen[1]!.name).toBe("beat.two");
    api.dispose();
    scene.dispose();
  });

  test("[ER-08-04] a full queue drops the newest event and counts it", () => {
    const scene = createScene();
    const entity = scene.createEntity();
    const api = createAnimationApi({ scene, eventCapacity: 2 });
    const instance = api.createInstance(entity, skeleton);
    instance.play(loadClip("events-loop.json"), { fadeOutPreviousSeconds: 0 });
    for (let tick = 0; tick < 180; tick += 1) api.update(STEP);
    expect(api.stats.eventsEmitted).toBe(12);
    expect(api.stats.eventsDropped).toBe(10);
    const out: AnimationEvent[] = new Array(8);
    const count = api.drainEvents(out);
    expect(count).toBe(2);
    expect(out[0]!.name).toBe("beat.one");
    expect(out[1]!.name).toBe("beat.two");
    api.dispose();
    scene.dispose();
  });

  test("[ER-08-04] drain copies at most the caller's capacity and keeps the rest", () => {
    const scene = createScene();
    const entity = scene.createEntity();
    const api = createAnimationApi({ scene });
    const instance = api.createInstance(entity, skeleton);
    instance.play(loadClip("events-loop.json"), { fadeOutPreviousSeconds: 0 });
    for (let tick = 0; tick < 60; tick += 1) api.update(STEP);
    const one: AnimationEvent[] = new Array(1);
    expect(api.drainEvents(one)).toBe(1);
    expect(one[0]!.name).toBe("beat.one");
    expect(api.drainEvents(one)).toBe(1);
    expect(one[0]!.name).toBe("beat.two");
    expect(api.drainEvents([])).toBe(0);
    api.dispose();
    scene.dispose();
  });
});
