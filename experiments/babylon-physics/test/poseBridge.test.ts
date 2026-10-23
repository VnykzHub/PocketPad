/**
 * Pose bridge tests for stream H's runtime integration seam.
 *
 * The bridge lives in `packages/runtime/src/physics3d/` and must stay
 * Babylon-free, so these tests bind plain structural targets against a real
 * Rapier world. No trace tag is attached: stream H has no registered
 * requirement ID in `TRACEABILITY.md`, and an invented tag would fail
 * `npm run trace` as unknown.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createRapierWorld,
  initRapierPhysics,
} from "@lanpad/engine-physics";
import type {
  BodyHandle,
  Physics3D,
  Vec3,
} from "@lanpad/engine-physics";

import { createPhysicsPoseBridge } from "../../../packages/runtime/src/physics3d/index.js";

const DT = 1 / 60;

interface TestTarget {
  position: Vec3;
  rotationQuaternion?: { x: number; y: number; z: number; w: number } | null;
}

interface TestWorld {
  world: Physics3D;
  dispose(): void;
}

function makeWorld(gravity = { x: 0, y: -9.81, z: 0 }): TestWorld {
  const world = createRapierWorld({ gravity });
  return { world, dispose: () => world.dispose() };
}

function dynamicBox(
  world: Physics3D,
  position: Vec3,
  halfExtents = { x: 0.5, y: 0.5, z: 0.5 },
): BodyHandle {
  const body = world.createBody({ type: "dynamic", position });
  world.createCollider(body, { shape: { kind: "box", halfExtents } });
  return body;
}

function targetAt(x = 0, y = 0, z = 0): TestTarget {
  return {
    position: { x, y, z },
    rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
  };
}

function bodyPose(world: Physics3D, body: BodyHandle): {
  position: Vec3;
  rotation: { x: number; y: number; z: number; w: number };
} {
  const state = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    linearVelocity: { x: 0, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    sleeping: false,
    enabled: true,
    mass: 0,
    userData: 0,
  };
  expect(world.readBody(body, state)).toBe(true);
  return { position: state.position, rotation: state.rotation };
}

beforeAll(async () => {
  await initRapierPhysics();
});

describe("physics3d pose bridge", () => {
  it("copies position and quaternion from a real body", () => {
    const { world, dispose } = makeWorld({ x: 0, y: 0, z: 0 });
    try {
      const body = dynamicBox(world, { x: 2, y: 3, z: -4 });
      world.setTransform(
        body,
        { x: 2, y: 3, z: -4 },
        { x: 0, y: 0.7071068, z: 0, w: 0.7071068 },
      );
      const bridge = createPhysicsPoseBridge(world);
      const target = targetAt();

      expect(bridge.bind(body, target)).toBe(true);
      expect(bridge.size).toBe(1);
      expect(bridge.sync()).toBe(1);

      const pose = bodyPose(world, body);
      expect(target.position).toEqual(pose.position);
      expect(target.rotationQuaternion).toEqual(pose.rotation);
      bridge.dispose();
    } finally {
      dispose();
    }
  });

  it("writes through accessors, like Babylon's math types", () => {
    const { world, dispose } = makeWorld({ x: 0, y: 0, z: 0 });
    try {
      const body = dynamicBox(world, { x: 1, y: 2, z: 3 });
      world.setTransform(
        body,
        { x: 1, y: 2, z: 3 },
        { x: 0, y: 0, z: 0.7071068, w: 0.7071068 },
      );
      let xWrites = 0;
      let wWrites = 0;
      const accessorQuaternion = {
        _x: 0,
        _y: 0,
        _z: 0,
        _w: 1,
        get x() {
          return this._x;
        },
        set x(value: number) {
          xWrites += 1;
          this._x = value;
        },
        get y() {
          return this._y;
        },
        set y(value: number) {
          this._y = value;
        },
        get z() {
          return this._z;
        },
        set z(value: number) {
          this._z = value;
        },
        get w() {
          return this._w;
        },
        set w(value: number) {
          wWrites += 1;
          this._w = value;
        },
      };
      const target = {
        position: { x: 0, y: 0, z: 0 },
        get rotationQuaternion() {
          return accessorQuaternion;
        },
      };
      const bridge = createPhysicsPoseBridge(world);
      bridge.bind(body, target);
      bridge.sync();

      expect(xWrites).toBeGreaterThan(0);
      expect(wWrites).toBeGreaterThan(0);
      expect(accessorQuaternion.z).toBeCloseTo(0.7071068, 5);
      expect(accessorQuaternion.w).toBeCloseTo(0.7071068, 5);
      bridge.dispose();
    } finally {
      dispose();
    }
  });

  it("syncs position only when the target has no quaternion", () => {
    const { world, dispose } = makeWorld({ x: 0, y: 0, z: 0 });
    try {
      const body = dynamicBox(world, { x: 5, y: 6, z: 7 });
      const target: { position: Vec3 } = { position: { x: 0, y: 0, z: 0 } };
      const bridge = createPhysicsPoseBridge(world);
      bridge.bind(body, target);
      bridge.sync();

      expect(target.position).toEqual({ x: 5, y: 6, z: 7 });
      expect("rotationQuaternion" in target).toBe(false);
      bridge.dispose();
    } finally {
      dispose();
    }
  });

  it("leaves a null quaternion untouched rather than assigning a plain object", () => {
    const { world, dispose } = makeWorld({ x: 0, y: 0, z: 0 });
    try {
      const body = dynamicBox(world, { x: 0, y: 9, z: 0 });
      const target: TestTarget = {
        position: { x: 0, y: 0, z: 0 },
        rotationQuaternion: null,
      };
      const bridge = createPhysicsPoseBridge(world);
      bridge.bind(body, target);
      bridge.sync();

      expect(target.position.y).toBe(9);
      expect(target.rotationQuaternion).toBeNull();
      bridge.dispose();
    } finally {
      dispose();
    }
  });

  it("rebinding the same handle repoints the slot without growing", () => {
    const { world, dispose } = makeWorld({ x: 0, y: 0, z: 0 });
    try {
      const body = dynamicBox(world, { x: 4, y: 0, z: 0 });
      const first = targetAt();
      const second = targetAt();
      const bridge = createPhysicsPoseBridge(world);

      expect(bridge.bind(body, first)).toBe(true);
      expect(bridge.bind(body, second)).toBe(true);
      expect(bridge.size).toBe(1);
      expect(bridge.sync()).toBe(1);

      expect(first.position).toEqual({ x: 0, y: 0, z: 0 });
      expect(second.position).toEqual({ x: 4, y: 0, z: 0 });
      bridge.dispose();
    } finally {
      dispose();
    }
  });

  it("unbinds only the exact handle", () => {
    const { world, dispose } = makeWorld({ x: 0, y: 0, z: 0 });
    try {
      const a = dynamicBox(world, { x: 1, y: 0, z: 0 });
      const b = dynamicBox(world, { x: 2, y: 0, z: 0 });
      const targetA = targetAt();
      const targetB = targetAt();
      const bridge = createPhysicsPoseBridge(world);
      bridge.bind(a, targetA);
      bridge.bind(b, targetB);

      expect(bridge.has(a)).toBe(true);
      expect(bridge.unbind(a)).toBe(true);
      expect(bridge.unbind(a)).toBe(false);
      expect(bridge.has(a)).toBe(false);
      expect(bridge.size).toBe(1);
      expect(bridge.sync()).toBe(1);
      expect(targetA.position).toEqual({ x: 0, y: 0, z: 0 });
      expect(targetB.position).toEqual({ x: 2, y: 0, z: 0 });
      bridge.dispose();
    } finally {
      dispose();
    }
  });

  it("drops destroyed bodies during sync without skipping neighbours", () => {
    const { world, dispose } = makeWorld({ x: 0, y: 0, z: 0 });
    try {
      const bodies = [
        dynamicBox(world, { x: 1, y: 0, z: 0 }),
        dynamicBox(world, { x: 2, y: 0, z: 0 }),
        dynamicBox(world, { x: 3, y: 0, z: 0 }),
      ];
      const targets = [targetAt(), targetAt(), targetAt()];
      const bridge = createPhysicsPoseBridge(world);
      for (let i = 0; i < bodies.length; i += 1) {
        bridge.bind(bodies[i]!, targets[i]!);
      }

      world.destroyBody(bodies[1]!);
      expect(bridge.sync()).toBe(2);
      expect(bridge.size).toBe(2);
      expect(bridge.has(bodies[1]!)).toBe(false);
      expect(targets[0]!.position).toEqual({ x: 1, y: 0, z: 0 });
      expect(targets[2]!.position).toEqual({ x: 3, y: 0, z: 0 });
      bridge.dispose();
    } finally {
      dispose();
    }
  });

  it("replaces a stale binding when a slot index is reused", () => {
    const { world, dispose } = makeWorld({ x: 0, y: 0, z: 0 });
    try {
      const oldBody = dynamicBox(world, { x: 1, y: 0, z: 0 });
      const bridge = createPhysicsPoseBridge(world);
      bridge.bind(oldBody, targetAt());
      world.destroyBody(oldBody);

      const newBody = dynamicBox(world, { x: 8, y: 0, z: 0 });
      const newTarget = targetAt();
      bridge.bind(newBody, newTarget);
      expect(bridge.size).toBe(1);
      expect(bridge.sync()).toBe(1);
      expect(newTarget.position).toEqual({ x: 8, y: 0, z: 0 });
      bridge.dispose();
    } finally {
      dispose();
    }
  });

  it("stepAndSync advances the world and writes the new pose", () => {
    const { world, dispose } = makeWorld();
    try {
      const body = dynamicBox(world, { x: 0, y: 10, z: 0 });
      const target = targetAt(0, 10, 0);
      const bridge = createPhysicsPoseBridge(world);

      bridge.bind(body, target);
      for (let tick = 0; tick < 10; tick += 1) {
        expect(bridge.stepAndSync(DT)).toBe(1);
      }

      const pose = bodyPose(world, body);
      expect(target.position.y).toBeLessThan(10);
      expect(target.position).toEqual(pose.position);
      expect(target.rotationQuaternion).toEqual(pose.rotation);
      expect(world.tick).toBe(10);
      bridge.dispose();
    } finally {
      dispose();
    }
  });

  it("forwards dt validation to the world", () => {
    const { world, dispose } = makeWorld();
    try {
      const body = dynamicBox(world, { x: 0, y: 10, z: 0 });
      const bridge = createPhysicsPoseBridge(world);
      bridge.bind(body, targetAt());
      expect(() => bridge.stepAndSync(1 / 30)).toThrow(/fixedDt/);
      expect(world.tick).toBe(0);
      bridge.dispose();
    } finally {
      dispose();
    }
  });

  it("dispose is idempotent, drops bindings and leaves the world usable", () => {
    const { world, dispose } = makeWorld();
    try {
      const body = dynamicBox(world, { x: 0, y: 10, z: 0 });
      const bridge = createPhysicsPoseBridge(world);
      bridge.bind(body, targetAt());

      bridge.dispose();
      expect(bridge.size).toBe(0);
      bridge.dispose();
      expect(() => bridge.sync()).toThrow(/dispose/);
      expect(() => bridge.bind(body, targetAt())).toThrow(/dispose/);
      expect(() => bridge.stepAndSync(DT)).toThrow(/dispose/);

      world.step(DT);
      expect(world.tick).toBe(1);
    } finally {
      dispose();
    }
  });
});

afterAll(() => {
  // Rapier's WASM stays initialized for the process; nothing to tear down.
});
