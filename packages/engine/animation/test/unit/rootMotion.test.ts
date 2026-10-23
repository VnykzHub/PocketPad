/**
 * Root-motion extraction, rejection, seam behaviour and apply parity
 * (spec 08 §5.7, ER-08-05). CPU-only evidence.
 */

import { describe, expect, test } from "vitest";
import {
  Transform,
  createScene,
  quatIdentity,
  quatMultiply,
  quatRotateVec3,
} from "@lanpad/engine-core";
import type { Quat, Vec3 } from "@lanpad/engine-core";
import { createAnimationApi } from "../../src/api/AnimationApi.js";
import type { AnimationInstance } from "../../src/contracts/animation.js";
import { loadClip, skeleton } from "../helpers/fixtures.js";

const STEP = 1 / 60;

interface Acc {
  position: Vec3;
  rotation: Quat;
}

function newAcc(): Acc {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: quatIdentity({ x: 0, y: 0, z: 0, w: 1 }),
  };
}

function yawOf(quat: Quat): number {
  return Math.atan2(
    2 * (quat.w * quat.y + quat.x * quat.z),
    1 - 2 * (quat.y * quat.y + quat.z * quat.z),
  );
}

function createRigInstance(mode: "extract" | "apply", clipName: string) {
  const scene = createScene();
  const entity = scene.createEntity();
  const api = createAnimationApi({ scene });
  const instance = api.createInstance(entity, skeleton);
  const clip = loadClip(clipName);
  instance.play(clip, { fadeOutPreviousSeconds: 0 });
  instance.setRootMotionMode(mode);
  return { scene, api, instance, clip };
}

function newDelta() {
  return {
    translation: { x: 0, y: 0, z: 0 },
    rotation: quatIdentity({ x: 0, y: 0, z: 0, w: 1 }),
    speed: 0,
    valid: false,
  };
}

describe("[ER-08-05] extraction", () => {
  test("[ER-08-05] first tick is invalid and zero", () => {
    const rig = createRigInstance("extract", "rootmotion-walk.json");
    rig.api.update(STEP);
    const delta = newDelta();
    expect(rig.instance.consumeRootMotion(delta)).toBe(false);
    expect(delta.valid).toBe(false);
    expect(delta.translation.x).toBe(0);
    expect(delta.translation.y).toBe(0);
    expect(delta.translation.z).toBe(0);
    expect(delta.rotation.w).toBe(1);
    rig.api.dispose();
    rig.scene.dispose();
  });

  test("[ER-08-05] 10 s of walk extracts 8 m within 1% and 90 deg within 0.5 deg", () => {
    const rig = createRigInstance("extract", "rootmotion-walk.json");
    const delta = newDelta();
    let travelled = 0;
    const yaw = quatIdentity({ x: 0, y: 0, z: 0, w: 1 });
    for (let tick = 0; tick < 599; tick += 1) {
      rig.api.update(STEP);
      if (!rig.instance.consumeRootMotion(delta)) continue;
      travelled += Math.hypot(
        delta.translation.x,
        delta.translation.y,
        delta.translation.z,
      );
      quatMultiply(yaw, yaw, delta.rotation);
    }
    expect(travelled).toBeGreaterThan(8 * 0.99);
    expect(travelled).toBeLessThan(8 * 1.01);
    const degrees = (yawOf(yaw) * 180) / Math.PI;
    expect(degrees).toBeGreaterThan(90 - 0.5);
    expect(degrees).toBeLessThan(90 + 0.5);
    rig.api.dispose();
    rig.scene.dispose();
  });

  test("[ER-08-05] default extraction drops vertical translation", () => {
    const rig = createRigInstance("extract", "rootmotion-walk.json");
    const delta = newDelta();
    rig.api.update(STEP);
    rig.instance.consumeRootMotion(delta);
    rig.api.update(STEP);
    expect(rig.instance.consumeRootMotion(delta)).toBe(true);
    expect(delta.translation.y).toBe(0);
    expect(delta.speed).toBeGreaterThan(0);
    rig.api.dispose();
    rig.scene.dispose();
  });

  test("[ER-08-05] the loop seam jump stays under 2 cm", () => {
    const rig = createRigInstance("extract", "seam-loop.json");
    const delta = newDelta();
    let maxJump = 0;
    let wraps = 0;
    for (let tick = 0; tick < 180; tick += 1) {
      const before = rig.instance.getAction(0)!.time;
      rig.api.update(STEP);
      const after = rig.instance.getAction(0)!.time;
      if (after < before) wraps += 1;
      if (!rig.instance.consumeRootMotion(delta)) continue;
      maxJump = Math.max(
        maxJump,
        Math.hypot(delta.translation.x, delta.translation.y, delta.translation.z),
      );
    }
    expect(wraps).toBe(3);
    expect(maxJump).toBeLessThanOrEqual(0.02);
    rig.api.dispose();
    rig.scene.dispose();
  });

  test("[ER-08-05] a teleport-sized delta is rejected", () => {
    const rig = createRigInstance("extract", "rootmotion-walk.json");
    const delta = newDelta();
    let invalidTicks = 0;
    for (let tick = 0; tick < 601; tick += 1) {
      rig.api.update(STEP);
      if (!rig.instance.consumeRootMotion(delta)) invalidTicks += 1;
    }
    // Tick 1 (no previous) and the wrap at 10 s (8 m in one tick).
    expect(invalidTicks).toBe(2);
    rig.api.dispose();
    rig.scene.dispose();
  });
});

describe("[ER-08-05] apply", () => {
  test("[ER-08-05] apply moves the entity and keeps the root joint in place", () => {
    const rig = createRigInstance("apply", "rootmotion-walk.json");
    const delta = newDelta();
    const expected = newAcc();
    const scratch: Vec3 = { x: 0, y: 0, z: 0 };
    let travelled = 0;
    for (let tick = 0; tick < 599; tick += 1) {
      rig.api.update(STEP);
      if (!rig.instance.consumeRootMotion(delta)) continue;
      travelled += Math.hypot(
        delta.translation.x,
        delta.translation.y,
        delta.translation.z,
      );
      quatRotateVec3(scratch, expected.rotation, delta.translation);
      expected.position.x += scratch.x;
      expected.position.y += scratch.y;
      expected.position.z += scratch.z;
      quatMultiply(expected.rotation, expected.rotation, delta.rotation);
    }
    expect(travelled).toBeGreaterThan(8 * 0.99);
    expect(travelled).toBeLessThan(8 * 1.01);
    const transform = rig.scene.get(rig.instance.entity, Transform);
    expect(transform).toBeDefined();
    expect(transform!.position.x).toBeCloseTo(expected.position.x, 4);
    expect(transform!.position.y).toBeCloseTo(expected.position.y, 4);
    expect(transform!.position.z).toBeCloseTo(expected.position.z, 4);
    expect(yawOf(transform!.rotation)).toBeCloseTo(yawOf(expected.rotation), 4);

    const pose = rig.instance.currentPose;
    expect(Math.abs(pose.translations[0]!)).toBeLessThanOrEqual(1e-4);
    expect(Math.abs(pose.translations[2]!)).toBeLessThanOrEqual(1e-4);
    expect(
      Math.abs(
        yawOf({
          x: pose.rotations[0]!,
          y: pose.rotations[1]!,
          z: pose.rotations[2]!,
          w: pose.rotations[3]!,
        }),
      ),
    ).toBeLessThanOrEqual(1e-4);
    rig.api.dispose();
    rig.scene.dispose();
  });

  test("[ER-08-05] apply rejects a non-root joint", () => {
    const scene = createScene();
    const entity = scene.createEntity();
    const api = createAnimationApi({ scene });
    const instance: AnimationInstance = api.createInstance(entity, skeleton);
    expect(() => instance.setRootMotionMode("apply", { rootJoint: 1 })).toThrow(
      /skeleton root joint/,
    );
    expect(() => instance.setRootMotionMode("apply", { rootJoint: 99 })).toThrow(
      /outside the skeleton/,
    );
    api.dispose();
    scene.dispose();
  });
});
