/**
 * Determinism of the whole instance/scene state (spec 08 §4.6, ER-08-02).
 *
 * Two identical 600-tick runs over 32 instances must produce the same
 * canonical hash. A speed or fade change must change it. The scenario uses
 * all three fixture clips, a 1D tree, crossfades at ticks 120/240 and a
 * pending event queue.
 */

import { describe, expect, test } from "vitest";
import { createScene } from "@lanpad/engine-core";
import { createAnimationApi } from "../../src/api/AnimationApi.js";
import type {
  AnimationInstance,
  BlendTree1D,
} from "../../src/contracts/animation.js";
import { loadClip, loadDeterminism, skeleton } from "../helpers/fixtures.js";

interface ScenarioOptions {
  readonly ticks: number;
  /** Multiplier applied to clips started by a crossfade. */
  readonly speedScale?: number;
  /** Replaces the fixture's crossfade duration. */
  readonly fadeSeconds?: number;
}

interface ScenarioResult {
  readonly hash: number;
  readonly instanceCount: number;
  readonly emitted: number;
  readonly dropped: number;
  readonly firstTickTracks: number;
  readonly afterCrossfadeTracks: number;
}

function runScenario(options: ScenarioOptions): ScenarioResult {
  const fixture = loadDeterminism();
  const scene = createScene();
  const api = createAnimationApi({ scene, fixedStep: fixture.fixedStep });
  const walk = loadClip("walk-1.0.json");
  const run = loadClip("run-0.6.json");
  const eventsClip = loadClip("events-loop.json");
  const clipsByName = new Map([
    [walk.name, walk],
    [run.name, run],
    [eventsClip.name, eventsClip],
  ]);

  const treeClips = fixture.tree.clips.map((name) => {
    const clip = clipsByName.get(name);
    return clip ?? loadClip(`${name}.json`);
  });
  const tree: BlendTree1D = {
    kind: "1d",
    samples: fixture.tree.clips.map((_, index) => ({
      threshold: fixture.tree.thresholds[index]!,
      clip: treeClips[index]!,
    })),
    syncPhase: fixture.tree.syncPhase,
  };

  const instances: AnimationInstance[] = [];
  for (let i = 0; i < fixture.instanceCount; i += 1) {
    const entity = scene.createEntity();
    const instance = api.createInstance(entity, skeleton);
    if (i % 3 === 0) {
      instance.play(eventsClip, { fadeOutPreviousSeconds: 0 });
    } else {
      // Spread the tree parameter so both samples contribute across instances.
      instance.play(tree, {
        parameter: (i % 16) / 15,
        fadeOutPreviousSeconds: 0,
      });
    }
    instances.push(instance);
  }

  let firstTickTracks = 0;
  let afterCrossfadeTracks = 0;
  for (let tick = 1; tick <= options.ticks; tick += 1) {
    for (const crossfade of fixture.crossfades) {
      if (crossfade.tick !== tick) continue;
      const clip = clipsByName.get(crossfade.clip);
      if (clip === undefined) {
        throw new Error(`unknown determinism clip ${crossfade.clip}`);
      }
      const fade = options.fadeSeconds ?? crossfade.fadeOutPreviousSeconds;
      for (const instance of instances) {
        instance.play(clip, {
          fadeOutPreviousSeconds: fade,
          speed: options.speedScale ?? 1,
        });
      }
    }
    api.update(fixture.fixedStep);
    if (tick === 1) firstTickTracks = api.stats.sampledTrackCount;
    if (tick === 121) afterCrossfadeTracks = api.stats.sampledTrackCount;
  }

  const hash = api.stateHash();
  const stats = api.stats;
  const result: ScenarioResult = {
    hash,
    instanceCount: stats.instanceCount,
    emitted: stats.eventsEmitted,
    dropped: stats.eventsDropped,
    firstTickTracks,
    afterCrossfadeTracks,
  };
  api.dispose();
  scene.dispose();
  return result;
}

describe("[ER-08-02] determinism", () => {
  test("[ER-08-02] two identical 600-tick runs hash identically", () => {
    const first = runScenario({ ticks: 600 });
    const second = runScenario({ ticks: 600 });
    expect(first.instanceCount).toBe(32);
    expect(first.emitted).toBeGreaterThan(0);
    expect(first.dropped).toBe(0);
    expect(first.firstTickTracks).toBeGreaterThan(0);
    expect(first.afterCrossfadeTracks).toBeGreaterThan(0);
    expect(first.hash).toBe(second.hash);
    expect(second.emitted).toBe(first.emitted);
  });

  test("[ER-08-02] a different crossfade speed changes the hash", () => {
    const fixture = loadDeterminism();
    const base = runScenario({ ticks: fixture.ticks });
    const faster = runScenario({
      ticks: fixture.ticks,
      speedScale: fixture.speedChange,
    });
    expect(faster.instanceCount).toBe(base.instanceCount);
    expect(faster.hash).not.toBe(base.hash);
  });

  test("[ER-08-02] a different crossfade duration changes the hash", () => {
    const fixture = loadDeterminism();
    // Hash during the first fade: by tick 600 both runs would have converged
    // to the same final action weights.
    const base = runScenario({ ticks: 130 });
    const slower = runScenario({ ticks: 130, fadeSeconds: fixture.fadeChange });
    expect(slower.instanceCount).toBe(base.instanceCount);
    expect(slower.hash).not.toBe(base.hash);
  });
});
