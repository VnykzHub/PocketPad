/**
 * Blend trees, crossfades, layer masks, additive math and the palette
 * hierarchy (spec 08 §5.5, §5.6, §5.9, ER-08-03).
 *
 * The golden blend fixture is generated independently in f64 by
 * `test/fixtures/generate.mjs`; this test drives the public API and compares
 * recovered model-space joint positions.
 */

import { describe, expect, test } from "vitest";
import {
  mat4Compose,
  mat4Multiply,
  quatFromAxisAngle,
  quatIdentity,
  quatInvert,
  quatMultiply,
  quatNlerp,
  createScene,
} from "@lanpad/engine-core";
import type { Mat4, Quat } from "@lanpad/engine-core";
import { createAnimationApi } from "../../src/api/AnimationApi.js";
import { AnimationInstanceImpl } from "../../src/api/AnimationInstance.js";
import type {
  AnimationClip,
  BlendTree1D,
  JointPalette,
  PoseBuffer,
} from "../../src/contracts/animation.js";
import { evaluateBlend1D } from "../../src/blend/blend1d.js";
import {
  applyAdditiveLayer,
  createAdditiveScratch,
} from "../../src/layer/layers.js";
import { createPoseBuffer } from "../../src/sample/PoseBuffer.js";
import { sampleClipInto } from "../../src/sample/sampleClip.js";
import {
  loadClip,
  loadGoldenBlend,
  palettePositions,
  skeleton,
} from "../helpers/fixtures.js";

const STEP = 1 / 60;
const GOLDEN_TOLERANCE = 1e-4;
const POSE_TOLERANCE = 1e-5;

function createPalette(): JointPalette {
  return {
    jointCount: skeleton.jointCount,
    matrices: new Float32Array(skeleton.jointCount * 16),
  };
}

function resetToRest(pose: PoseBuffer): void {
  pose.translations.set(skeleton.restPose.translations);
  pose.rotations.set(skeleton.restPose.rotations);
  pose.scales.set(skeleton.restPose.scales);
}

function sampledPose(clip: AnimationClip, time: number): PoseBuffer {
  const pose = createPoseBuffer(skeleton.jointCount);
  resetToRest(pose);
  sampleClipInto(clip, time, pose, null);
  return pose;
}

function quatAt(values: Float32Array, offset: number): Quat {
  return {
    x: values[offset]!,
    y: values[offset + 1]!,
    z: values[offset + 2]!,
    w: values[offset + 3]!,
  };
}

/** nlerp(identity, b, t), shortest arc and normalized, matching §5.5. */
function nlerpFromIdentity(b: Quat, t: number): Quat {
  const dot = b.w;
  const sign = dot < 0 ? -1 : 1;
  let x = b.x * sign * t;
  let y = b.y * sign * t;
  let z = b.z * sign * t;
  let w = 1 + (b.w * sign - 1) * t;
  const norm = Math.hypot(x, y, z, w);
  if (!(norm > 0) || !Number.isFinite(norm)) {
    x = 0;
    y = 0;
    z = 0;
    w = 1;
  } else {
    x /= norm;
    y /= norm;
    z /= norm;
    w /= norm;
  }
  return { x, y, z, w };
}

/**
 * Blends the active clip actions in creation order using cumulative
 * normalization, mirroring §5.5 without touching the instance's own buffers.
 */
function expectedClipBlend(impl: AnimationInstanceImpl): PoseBuffer {
  const active = impl.actions
    .filter(
      (action) =>
        action.active &&
        action.sourceInternal !== null &&
        !("kind" in action.sourceInternal),
    )
    .sort((a, b) => a.order - b.order);
  const out = createPoseBuffer(skeleton.jointCount);
  resetToRest(out);
  let cumulative = 0;
  for (const action of active) {
    const weight = Math.min(1, Math.max(0, action.weight));
    if (weight <= 0) continue;
    const source = action.sourceInternal as AnimationClip;
    const sample = sampledPose(source, action.time);
    cumulative += weight;
    const fraction = cumulative > 0 ? weight / cumulative : 1;
    for (let joint = 0; joint < skeleton.jointCount; joint += 1) {
      for (let i = 0; i < 3; i += 1) {
        const t = joint * 3 + i;
        out.translations[t] =
          out.translations[t]! +
          (sample.translations[t]! - out.translations[t]!) * fraction;
        out.scales[t] =
          out.scales[t]! + (sample.scales[t]! - out.scales[t]!) * fraction;
      }
      const r = joint * 4;
      const a = quatAt(out.rotations, r);
      const b = quatAt(sample.rotations, r);
      const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
      const sign = dot < 0 ? -1 : 1;
      let x = a.x + (b.x * sign - a.x) * fraction;
      let y = a.y + (b.y * sign - a.y) * fraction;
      let z = a.z + (b.z * sign - a.z) * fraction;
      let w = a.w + (b.w * sign - a.w) * fraction;
      const norm = Math.hypot(x, y, z, w);
      if (!(norm > 0) || !Number.isFinite(norm)) {
        x = 0;
        y = 0;
        z = 0;
        w = 1;
      } else {
        x /= norm;
        y /= norm;
        z /= norm;
        w /= norm;
      }
      out.rotations[r] = x;
      out.rotations[r + 1] = y;
      out.rotations[r + 2] = z;
      out.rotations[r + 3] = w;
    }
  }
  return out;
}

function expectPoseClose(
  actual: PoseBuffer,
  expected: PoseBuffer,
  label: string,
  tolerance: number = POSE_TOLERANCE,
): void {
  for (let joint = 0; joint < actual.jointCount; joint += 1) {
    for (let i = 0; i < 3; i += 1) {
      const t = joint * 3 + i;
      expect(
        Math.abs(actual.translations[t]! - expected.translations[t]!),
        `${label}: joint ${joint} translation[${i}]`,
      ).toBeLessThanOrEqual(tolerance);
      expect(
        Math.abs(actual.scales[t]! - expected.scales[t]!),
        `${label}: joint ${joint} scale[${i}]`,
      ).toBeLessThanOrEqual(tolerance);
    }
    const r = joint * 4;
    const a = quatAt(actual.rotations, r);
    const b = quatAt(expected.rotations, r);
    const dot =
      Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w) /
      (Math.hypot(a.x, a.y, a.z, a.w) * Math.hypot(b.x, b.y, b.z, b.w));
    expect(
      Math.abs(dot - 1),
      `${label}: joint ${joint} rotation`,
    ).toBeLessThanOrEqual(tolerance);
  }
}

describe("[ER-08-03] 1D blending", () => {
  test("[ER-08-03] golden walk→run blend matches at ticks 0/150/300/450/600", () => {
    const scene = createScene();
    const entity = scene.createEntity();
    const api = createAnimationApi({ scene });
    const instance = api.createInstance(entity, skeleton);
    const walk = loadClip("walk-1.0.json");
    const run = loadClip("run-0.6.json");
    const tree: BlendTree1D = {
      kind: "1d",
      samples: [
        { threshold: 0, clip: walk },
        { threshold: 1, clip: run },
      ],
      syncPhase: true,
    };
    const action = instance.play(tree, { fadeOutPreviousSeconds: 0 });
    const golden = loadGoldenBlend();
    const palette = createPalette();

    let sampleIndex = 0;
    const first = golden.samples[0]!;
    expect(first.tick).toBe(0);
    // Tick 0 is the rest pose: playback has not sampled yet.
    instance.computePalette(palette, 1);
    const restPositions = palettePositions(palette);
    for (let i = 0; i < restPositions.length; i += 1) {
      expect(
        Math.abs(restPositions[i]! - first.positions[i]!),
        `tick 0 component ${i}`,
      ).toBeLessThanOrEqual(GOLDEN_TOLERANCE);
    }
    sampleIndex = 1;

    for (let tick = 1; tick <= golden.ticks; tick += 1) {
      action.setParameter(tick / golden.ticks);
      api.update(STEP);
      const sample = golden.samples[sampleIndex];
      if (sample === undefined || sample.tick !== tick) continue;
      instance.computePalette(palette, 1);
      const positions = palettePositions(palette);
      for (let i = 0; i < positions.length; i += 1) {
        expect(
          Math.abs(positions[i]! - sample.positions[i]!),
          `tick ${tick} component ${i}`,
        ).toBeLessThanOrEqual(GOLDEN_TOLERANCE);
      }
      sampleIndex += 1;
    }
    expect(sampleIndex).toBe(golden.samples.length);
    api.dispose();
    scene.dispose();
  });

  test("[ER-08-03] 1D weights bracket, clamp and sum to one", () => {
    const walk = loadClip("walk-1.0.json");
    const run = loadClip("run-0.6.json");
    const tree: BlendTree1D = {
      kind: "1d",
      samples: [
        { threshold: 0, clip: walk },
        { threshold: 1, clip: run },
      ],
    };
    const weights = new Float32Array(4);
    const cases: readonly [number, number, number][] = [
      [-1, 1, 0],
      [0, 1, 0],
      [0.25, 0.75, 0.25],
      [0.5, 0.5, 0.5],
      [1, 0, 1],
      [2, 0, 1],
    ];
    for (const [parameter, expectedWalk, expectedRun] of cases) {
      const count = evaluateBlend1D(tree, parameter, weights);
      expect(count).toBeGreaterThanOrEqual(1);
      expect(weights[0]).toBeCloseTo(expectedWalk, 6);
      expect(weights[1]).toBeCloseTo(expectedRun, 6);
      expect(weights[0]! + weights[1]!).toBeCloseTo(1, 6);
    }
    // A NaN parameter is treated as 0 rather than poisoning the pose.
    evaluateBlend1D(tree, Number.NaN, weights);
    expect(weights[0]).toBe(1);
    expect(weights[1]).toBe(0);
  });
});

describe("[ER-08-03] crossfade", () => {
  test("[ER-08-03] default crossfade ramps weights, sums to one and never pops to rest", () => {
    const scene = createScene();
    const entity = scene.createEntity();
    const api = createAnimationApi({ scene });
    const instance = api.createInstance(entity, skeleton);
    const impl = instance as AnimationInstanceImpl;
    const walk = loadClip("walk-1.0.json");
    const run = loadClip("run-0.6.json");
    instance.play(walk, { fadeOutPreviousSeconds: 0 });
    for (let tick = 0; tick < 10; tick += 1) api.update(STEP);

    instance.play(run);
    const activeAfterPlay = impl.actions.filter((action) => action.active);
    expect(activeAfterPlay).toHaveLength(2);
    const outgoing = activeAfterPlay.find((action) => action.source === walk)!;
    const incoming = activeAfterPlay.find((action) => action.source === run)!;
    expect(outgoing.weight).toBe(1);
    expect(incoming.weight).toBe(0);

    let midWeights: [number, number] | null = null;
    for (let tick = 1; tick <= 13; tick += 1) {
      api.update(STEP);
      const active = impl.actions.filter((action) => action.active);
      const weights = active.map((action) => action.weight);
      if (active.length === 2) {
        expect(weights[0]! + weights[1]!).toBeCloseTo(1, 6);
      }
      const expected = expectedClipBlend(impl);
      expectPoseClose(instance.currentPose, expected, `crossfade tick ${tick}`);
      if (tick === 6) {
        midWeights = [outgoing.weight, incoming.weight];
        // The blended pose must differ from the rest pose somewhere, so the
        // equality above is not a T-pose pop dressed up as a blend.
        let differs = false;
        for (let joint = 0; joint < skeleton.jointCount; joint += 1) {
          const r = joint * 4;
          const quat = quatAt(expected.rotations, r);
          const restQuat = quatAt(skeleton.restPose.rotations, r);
          const dot =
            quat.x * restQuat.x +
            quat.y * restQuat.y +
            quat.z * restQuat.z +
            quat.w * restQuat.w;
          if (Math.abs(Math.abs(dot) - 1) > 1e-4) {
            differs = true;
            break;
          }
        }
        expect(differs).toBe(true);
      }
    }
    expect(midWeights).not.toBeNull();
    expect(midWeights![0]).toBeGreaterThan(0.45);
    expect(midWeights![0]).toBeLessThan(0.55);
    expect(midWeights![1]).toBeCloseTo(1 - midWeights![0], 6);
    // After 0.2 s the outgoing action is gone and the new one owns the layer.
    const finalActive = impl.actions.filter((action) => action.active);
    expect(finalActive).toHaveLength(1);
    expect(finalActive[0]!.source).toBe(run);
    expect(finalActive[0]!.weight).toBe(1);
    api.dispose();
    scene.dispose();
  });
});

describe("[ER-08-03] layers", () => {
  test("[ER-08-03] an override layer touches only masked joints and respects its weight", () => {
    const scene = createScene();
    const entity = scene.createEntity();
    const api = createAnimationApi({ scene });
    const mask = { joints: Uint32Array.of(1 << 5) };
    const instance = api.createInstance(entity, skeleton, {
      layers: [
        { name: "base", mode: "base" },
        { name: "upper", mode: "override", mask, weight: 0.5 },
      ],
    });
    const impl = instance as AnimationInstanceImpl;
    const walk = loadClip("walk-1.0.json");
    const run = loadClip("run-0.6.json");
    instance.play(walk, { fadeOutPreviousSeconds: 0 });
    instance.play(run, { layer: 1, fadeOutPreviousSeconds: 0 });
    api.update(STEP);

    const walkPose = sampledPose(walk, impl.getAction(0)!.time);
    const runPose = sampledPose(run, impl.getAction(1)!.time);

    // Joint 1 is outside the mask and must be exactly the base pose.
    for (let i = 0; i < 3; i += 1) {
      expect(instance.currentPose.translations[3 + i]).toBe(
        walkPose.translations[3 + i],
      );
      expect(instance.currentPose.scales[3 + i]).toBe(walkPose.scales[3 + i]);
    }
    for (let i = 0; i < 4; i += 1) {
      expect(instance.currentPose.rotations[4 + i]).toBe(walkPose.rotations[4 + i]);
    }

    // Joint 5 is masked at layer weight 0.5: lerp T/S, nlerp R.
    const masked = 5;
    for (let i = 0; i < 3; i += 1) {
      const expected =
        walkPose.translations[masked * 3 + i]! +
        (runPose.translations[masked * 3 + i]! -
          walkPose.translations[masked * 3 + i]!) *
          0.5;
      expect(instance.currentPose.translations[masked * 3 + i]).toBeCloseTo(
        expected,
        6,
      );
    }
    const a = quatAt(walkPose.rotations, masked * 4);
    const b = quatAt(runPose.rotations, masked * 4);
    const expectedQuat = quatNlerp(
      quatIdentity({ x: 0, y: 0, z: 0, w: 1 }),
      a,
      b,
      0.5,
    );
    const actualQuat = quatAt(instance.currentPose.rotations, masked * 4);
    const dot = Math.abs(
      actualQuat.x * expectedQuat.x +
        actualQuat.y * expectedQuat.y +
        actualQuat.z * expectedQuat.z +
        actualQuat.w * expectedQuat.w,
    );
    expect(dot).toBeCloseTo(1, 6);

    // The layer copied the mask at creation: mutating the caller's object now
    // must not change which joint is overridden.
    mask.joints[0] = 0;
    api.update(STEP);
    const walkPose2 = sampledPose(walk, impl.getAction(0)!.time);
    const runPose2 = sampledPose(run, impl.getAction(1)!.time);
    const expected2 =
      walkPose2.translations[masked * 3]! +
      (runPose2.translations[masked * 3]! - walkPose2.translations[masked * 3]!) *
        0.5;
    expect(instance.currentPose.translations[masked * 3]).toBeCloseTo(
      expected2,
      6,
    );

    // Weight zero disables the layer for the next tick.
    instance.setLayerWeight(1, 0);
    api.update(STEP);
    const walkPose3 = sampledPose(walk, impl.getAction(0)!.time);
    expect(instance.currentPose.translations[masked * 3]).toBe(
      walkPose3.translations[masked * 3],
    );
    api.dispose();
    scene.dispose();
  });
});

describe("[ER-08-03] additive formula", () => {
  test("[ER-08-03] M2 additive formula applies T/S offset and delta rotation", () => {
    const rest = createPoseBuffer(1);
    const base = createPoseBuffer(1);
    const overlay = createPoseBuffer(1);
    overlay.translations[0] = 1;
    overlay.translations[1] = 2;
    overlay.translations[2] = 3;
    overlay.scales[0] = 2;
    overlay.scales[1] = 3;
    overlay.scales[2] = 4;
    const axis = { x: 0, y: 1, z: 0 };
    const overlayQuat = quatFromAxisAngle(
      quatIdentity({ x: 0, y: 0, z: 0, w: 1 }),
      axis,
      Math.PI / 2,
    );
    overlay.rotations.set([
      overlayQuat.x,
      overlayQuat.y,
      overlayQuat.z,
      overlayQuat.w,
    ]);
    const baseQuat = quatFromAxisAngle(
      quatIdentity({ x: 1, y: 0, z: 0, w: 0 }),
      { x: 1, y: 0, z: 0 },
      Math.PI / 6,
    );
    base.rotations.set([baseQuat.x, baseQuat.y, baseQuat.z, baseQuat.w]);

    applyAdditiveLayer(
      base,
      overlay,
      rest,
      undefined,
      0.5,
      createAdditiveScratch(),
    );

    expect(base.translations[0]).toBeCloseTo(0.5, 6);
    expect(base.translations[1]).toBeCloseTo(1, 6);
    expect(base.translations[2]).toBeCloseTo(1.5, 6);
    expect(base.scales[0]).toBeCloseTo(1.5, 6);
    expect(base.scales[1]).toBeCloseTo(2, 6);
    expect(base.scales[2]).toBeCloseTo(2.5, 6);

    const identity = quatIdentity({ x: 0, y: 0, z: 0, w: 1 });
    const inverseRest = quatInvert(identity, identity);
    const delta = quatMultiply(identity, overlayQuat, inverseRest);
    const expected = quatMultiply(
      identity,
      baseQuat,
      nlerpFromIdentity(delta, 0.5),
    );
    const actual = quatAt(base.rotations, 0);
    const dot = Math.abs(
      actual.x * expected.x +
        actual.y * expected.y +
        actual.z * expected.z +
        actual.w * expected.w,
    );
    expect(dot).toBeCloseTo(1, 6);
  });

  test("[ER-08-03] additive weight clamps and an empty mask is a no-op", () => {
    const rest = createPoseBuffer(1);
    const base = createPoseBuffer(1);
    const overlay = createPoseBuffer(1);
    overlay.translations[0] = 2;
    const scratch = createAdditiveScratch();

    applyAdditiveLayer(base, overlay, rest, Uint32Array.of(0), 1, scratch);
    expect(base.translations[0]).toBe(0);

    applyAdditiveLayer(base, overlay, rest, undefined, -1, scratch);
    expect(base.translations[0]).toBe(0);
    applyAdditiveLayer(base, overlay, rest, undefined, 2, scratch);
    expect(base.translations[0]).toBe(2);
    expect(base.scales[0]).toBe(1);
  });
});

describe("[ER-08-03] palette", () => {
  test("[ER-08-03] palette matrices match an independent W * inverseBind chain", () => {
    const scene = createScene();
    const entity = scene.createEntity();
    const api = createAnimationApi({ scene });
    const instance = api.createInstance(entity, skeleton);
    instance.play(loadClip("walk-1.0.json"), { fadeOutPreviousSeconds: 0 });
    for (let tick = 0; tick < 7; tick += 1) api.update(STEP);

    const palette = createPalette();
    instance.computePalette(palette, 1);
    const pose = instance.currentPose;
    const worlds: Mat4[] = [];
    const local: Mat4 = { m: new Float32Array(16) };
    for (let joint = 0; joint < skeleton.jointCount; joint += 1) {
      mat4Compose(
        local,
        {
          x: pose.translations[joint * 3]!,
          y: pose.translations[joint * 3 + 1]!,
          z: pose.translations[joint * 3 + 2]!,
        },
        {
          x: pose.rotations[joint * 4]!,
          y: pose.rotations[joint * 4 + 1]!,
          z: pose.rotations[joint * 4 + 2]!,
          w: pose.rotations[joint * 4 + 3]!,
        },
        {
          x: pose.scales[joint * 3]!,
          y: pose.scales[joint * 3 + 1]!,
          z: pose.scales[joint * 3 + 2]!,
        },
      );
      const world: Mat4 = { m: new Float32Array(16) };
      const parent = skeleton.parents[joint]!;
      if (parent < 0) {
        world.m.set(local.m);
      } else {
        mat4Multiply(world, worlds[parent]!, local);
      }
      worlds.push(world);
    }
    for (let joint = 0; joint < skeleton.jointCount; joint += 1) {
      const expected: Mat4 = { m: new Float32Array(16) };
      mat4Multiply(expected, worlds[joint]!, {
        m: skeleton.inverseBindMatrices.subarray(joint * 16, joint * 16 + 16),
      });
      for (let i = 0; i < 16; i += 1) {
        expect(
          Math.abs(palette.matrices[joint * 16 + i]! - expected.m[i]!),
          `joint ${joint} matrix element ${i}`,
        ).toBeLessThanOrEqual(1e-5);
      }
    }
    api.dispose();
    scene.dispose();
  });
});
