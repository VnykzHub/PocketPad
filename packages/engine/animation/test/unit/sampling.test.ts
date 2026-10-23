/**
 * Skeleton/clip compile validation and §5.4 sampling (ER-08-03).
 *
 * Exact-key, interpolated, step, endpoint and loop behaviour are checked
 * against the checked-in analytic fixtures. Browser/skinning rows stay
 * PENDING; this file claims unit evidence only.
 */

import { describe, expect, test } from "vitest";
import { createScene } from "@lanpad/engine-core";
import { compileSkeleton } from "../../src/skeleton/compileSkeleton.js";
import { compileClip } from "../../src/clip/compileClip.js";
import { sampleClipInto } from "../../src/sample/sampleClip.js";
import { createPoseBuffer } from "../../src/sample/PoseBuffer.js";
import { sampleTrackInto } from "../../src/clip/track.js";
import { canonicalizeQuatAt, nlerpInto } from "../../src/sample/interpolate.js";
import { createAnimationApi } from "../../src/api/AnimationApi.js";
import type { AnimationSource } from "../../src/contracts/sources.js";
import {
  clipSourceFromJson,
  loadClip,
  loadClipJson,
  loadSkeletonJson,
  skeleton,
  skeletonSourceFromJson,
} from "../helpers/fixtures.js";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return "no-throw";
}

describe("[ER-08-03] skeleton compile", () => {
  test("[ER-08-03] the 24-joint fixture compiles with one root", () => {
    expect(skeleton.jointCount).toBe(24);
    expect(Array.from(skeleton.parents).filter((parent) => parent === -1)).toEqual([
      -1,
    ]);
    expect(skeleton.rootJoint).toBe(0);
    expect(skeleton.jointNames[5]).toBe("leftUpperArm");
    const translation = Array.from(skeleton.restPose.translations.slice(0, 3));
    expect(translation).toEqual([0, 1, 0]);
  });

  test("[ER-08-03] a non-topological parent is E_ASSET_FORMAT", () => {
    const source = skeletonSourceFromJson(loadSkeletonJson());
    const parents = new Int16Array(source.parents);
    parents[2] = 5;
    const code = codeOf(() => compileSkeleton({ ...source, parents }));
    expect(code).toBe("E_ASSET_FORMAT");
  });

  test("[ER-08-03] compiled arrays are copies of the source", () => {
    const source = skeletonSourceFromJson(loadSkeletonJson());
    const compiled = compileSkeleton(source);
    const before = compiled.parents[5];
    const mutable = source.parents as Int16Array;
    mutable[5] = -1;
    expect(compiled.parents[5]).toBe(before);
  });

  test("[ER-08-03] the walk and run clips compile against the rig", () => {
    const walk = loadClip("walk-1.0.json");
    const run = loadClip("run-0.6.json");
    expect(walk.name).toBe("walk-1.0");
    expect(walk.duration).toBeCloseTo(1, 6);
    expect(run.duration).toBeCloseTo(0.6, 6);
    expect(walk.rootJoint).toBe(0);
    expect(walk.loop).toBe("repeat");
    // Tracks are sorted translation, rotation, scale, weights.
    const ranks = walk.tracks.map((track) =>
      track.path === "translation"
        ? 0
        : track.path === "rotation"
          ? 1
          : track.path === "scale"
            ? 2
            : 3,
    );
    for (let i = 1; i < ranks.length; i += 1) {
      expect(ranks[i]!).toBeGreaterThanOrEqual(ranks[i - 1]!);
    }
  });

  test("[ER-08-03] CUBICSPLINE interpolation is rejected", () => {
    const source = clipSourceFromJson(loadClipJson("walk-1.0.json"));
    const tracks = source.tracks.map((track, index) =>
      index === 0 ? { ...track, interpolation: "cubicspline" } : track,
    );
    const code = codeOf(() =>
      compileClip(
        { ...source, tracks } as unknown as AnimationSource,
        skeleton,
      ),
    );
    expect(code).toBe("E_ASSET_FORMAT");
  });

  test("[ER-08-03] non-ascending key times are rejected", () => {
    const source = clipSourceFromJson(loadClipJson("walk-1.0.json"));
    const times = new Float32Array(source.tracks[0]!.times);
    times[2] = times[1]!;
    const tracks = source.tracks.map((track, index) =>
      index === 0 ? { ...track, times } : track,
    );
    expect(codeOf(() => compileClip({ ...source, tracks }, skeleton))).toBe(
      "E_ASSET_FORMAT",
    );
  });

  test("[ER-08-03] a track beyond the skeleton joint count is rejected", () => {
    const source = clipSourceFromJson(loadClipJson("walk-1.0.json"));
    const tracks = source.tracks.map((track, index) =>
      index === 0 ? { ...track, target: 24 } : track,
    );
    expect(codeOf(() => compileClip({ ...source, tracks }, skeleton))).toBe(
      "E_ASSET_FORMAT",
    );
  });
});

describe("[ER-08-03] clip sampling", () => {
  const walk = loadClip("walk-1.0.json");
  const translation = walk.tracks.find(
    (track) => track.path === "translation" && track.target === 0,
  )!;
  const stepTrack = walk.tracks.find(
    (track) => track.target === 23 && track.path === "rotation",
  )!;

  test("[ER-08-03] an exact key returns its stored value", () => {
    const pose = createPoseBuffer(skeleton.jointCount);
    sampleTrackInto(translation, translation.times[3]!, pose);
    expect(Array.from(pose.translations.slice(0, 3))).toEqual(
      Array.from(translation.values.slice(9, 12)),
    );
  });

  test("[ER-08-03] linear interpolation lerps translation", () => {
    const pose = createPoseBuffer(skeleton.jointCount);
    const t = (translation.times[2]! + translation.times[3]!) / 2;
    sampleTrackInto(translation, t, pose);
    for (let i = 0; i < 3; i += 1) {
      const a = translation.values[2 * 3 + i]!;
      const b = translation.values[3 * 3 + i]!;
      expect(pose.translations[i]!).toBeCloseTo((a + b) / 2, 6);
    }
  });

  test("[ER-08-03] step interpolation returns the left key", () => {
    const pose = createPoseBuffer(skeleton.jointCount);
    sampleTrackInto(stepTrack, walk.duration * 0.75, pose);
    expect(Array.from(pose.rotations.slice(23 * 4, 23 * 4 + 4))).toEqual(
      Array.from(stepTrack.values.slice(4, 8)),
    );
    sampleTrackInto(stepTrack, walk.duration * 0.25, pose);
    expect(Array.from(pose.rotations.slice(23 * 4, 23 * 4 + 4))).toEqual(
      Array.from(stepTrack.values.slice(0, 4)),
    );
  });

  test("[ER-08-03] time outside the track clamps to the endpoints", () => {
    const pose = createPoseBuffer(skeleton.jointCount);
    sampleTrackInto(translation, -5, pose);
    expect(pose.translations[0]!).toBe(translation.values[0]!);
    sampleTrackInto(translation, 5, pose);
    expect(pose.translations[0]!).toBe(
      translation.values[(translation.keyCount - 1) * 3]!,
    );
  });

  test("[ER-08-03] a sparse track leaves other joints at rest", () => {
    const pose = createPoseBuffer(skeleton.jointCount);
    pose.translations.set(skeleton.restPose.translations);
    pose.rotations.set(skeleton.restPose.rotations);
    pose.scales.set(skeleton.restPose.scales);
    sampleClipInto(walk, 0.37, pose, null);
    expect(Array.from(pose.translations.slice(3 * 3, 3 * 3 + 3))).toEqual(
      Array.from(skeleton.restPose.translations.slice(9, 12)),
    );
    expect(Array.from(pose.rotations.slice(3 * 4, 3 * 4 + 4))).toEqual(
      Array.from(skeleton.restPose.rotations.slice(12, 16)),
    );
  });

  test("[ER-08-03] a repeating action wraps at the duration", () => {
    const scene = createScene();
    const entity = scene.createEntity();
    const api = createAnimationApi({ scene });
    const instance = api.createInstance(entity, skeleton);
    const action = instance.play(walk, { fadeOutPreviousSeconds: 0 });
    for (let i = 0; i < 60; i += 1) api.update(1 / 60);
    expect(action.time).toBeCloseTo(0, 4);
    api.update(1 / 60);
    expect(action.time).toBeCloseTo(1 / 60, 4);
    api.dispose();
    scene.dispose();
  });

  test("[ER-08-03] a once action clamps at the duration", () => {
    const scene = createScene();
    const entity = scene.createEntity();
    const api = createAnimationApi({ scene });
    const instance = api.createInstance(entity, skeleton);
    const events = loadClip("events-loop.json");
    const action = instance.play(events, {
      loop: "once",
      fadeOutPreviousSeconds: 0,
    });
    for (let i = 0; i < 120; i += 1) api.update(1 / 60);
    expect(action.time).toBeCloseTo(events.duration, 5);
    expect(action.normalizedTime).toBeCloseTo(0, 5);
    api.dispose();
    scene.dispose();
  });
});

describe("[ER-08-03] quaternion interpolation", () => {
  test("[ER-08-03] nlerp takes the shortest arc", () => {
    const out = new Float32Array(4);
    const a = new Float32Array([0, 0, 0, 1]);
    const b = new Float32Array([0, 0, 0, -1]);
    nlerpInto(out, 0, a, 0, b, 0, 0.5);
    expect(Array.from(out)).toEqual([0, 0, 0, 1]);
  });

  test("[ER-08-03] canonical sign flips w<0 and the w=0, x<0 tie", () => {
    const values = new Float32Array([0.5, 0, 0, -0.8660254]);
    canonicalizeQuatAt(values, 0);
    expect(values[0]!).toBeCloseTo(-0.5, 6);
    expect(values[3]!).toBeCloseTo(0.8660254, 6);
    const tie = new Float32Array([-1, 0, 0, 0]);
    canonicalizeQuatAt(tie, 0);
    expect(tie[0]!).toBe(1);
  });
});
