/**
 * Adapter contract tests for `@lanpad/engine-physics` (ER-07-01).
 *
 * These exercise the frozen `Physics3D` surface with live Rapier in Node.
 * Every assertion is behavioural; no value here is a hardware measurement.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { createScene, Transform } from "@lanpad/engine-core";
import type { Transform as TransformData } from "@lanpad/engine-core";
import {
  PHYSICS_DEFAULT_SOLVER,
  RAPIER_VERSION,
  createRapierAdapter,
  isRapierReady,
  PreviousTransform,
} from "../../src/index";
import {
  DT,
  FULL_MASK,
  bodyState,
  colliderState,
  contactEvents,
  dynamicBox,
  dynamicCapsule,
  dynamicSphere,
  ground,
  init,
  jointState,
  makeWorld,
  q,
  raycastHit,
  shapeCastHit,
  staticBox,
  staticTrimesh,
  stepTicks,
  triggerEvents,
  v3,
} from "../support/world";
import type { ColliderHandle, JointHandle } from "../../src/index";

beforeAll(async () => {
  await init();
});

function codeOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : `<missing-code:${String(error)}>`;
  }
  return "<no-throw>";
}

function triangleMesh(): {
  vertices: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
} {
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    triangleCount: 1,
  };
}

describe("adapter lifecycle", () => {
  test("[ER-07-01] Rapier initializes once and reports the pinned 0.21.0 adapter", () => {
    expect(isRapierReady()).toBe(true);
    expect(RAPIER_VERSION).toBe("0.21.0");
    const adapter = createRapierAdapter();
    expect(adapter.backend).toBe("rapier");
    const world = adapter.create();
    expect(world.backend).toBe("rapier");
    expect(world.fixedDt).toBe(DT);
    expect(world.tick).toBe(0);
    world.dispose();
  });

  test("[ER-07-01] step accepts exactly fixedDt and advances the tick once", () => {
    const world = makeWorld();
    world.step(DT);
    expect(world.tick).toBe(1);
    expect(codeOf(() => world.step(DT * 2))).toBe("E_CONTRACT");
    expect(codeOf(() => world.step(0))).toBe("E_CONTRACT");
    expect(world.tick).toBe(1);
    world.dispose();
  });

  test("[ER-07-01] dispose is idempotent and rejects further stepping", () => {
    const world = makeWorld();
    world.dispose();
    world.dispose();
    expect(codeOf(() => world.step(DT))).toBe("E_CONTRACT");
    expect(world.stateHash()).toBe(0);
  });

  test("[ER-07-01] reset clears bodies, tick and stats", () => {
    const world = makeWorld();
    dynamicSphere(world, v3(0, 2, 0), 0.5);
    stepTicks(world, 10);
    expect(world.stats.bodyCount).toBe(1);
    expect(world.tick).toBe(10);
    world.reset();
    expect(world.stats.bodyCount).toBe(0);
    expect(world.stats.colliderCount).toBe(0);
    expect(world.tick).toBe(0);
    world.dispose();
  });
});

describe("bodies", () => {
  test("[ER-07-01] gravity integrates a dynamic body and readBody copies state", () => {
    const world = makeWorld();
    const sphere = dynamicSphere(world, v3(0, 10, 0), 0.5);
    const out = bodyState();
    expect(world.readBody(sphere.body, out)).toBe(true);
    expect(out.position.y).toBe(10);
    stepTicks(world, 60);
    expect(world.readBody(sphere.body, out)).toBe(true);
    expect(out.position.y).toBeGreaterThan(4.5);
    expect(out.position.y).toBeLessThan(6);
    expect(out.linearVelocity.y).toBeLessThan(-9);
    world.dispose();
  });

  test("[ER-07-01] static bodies ignore gravity and are immovable", () => {
    const world = makeWorld();
    const kerb = staticBox(world, v3(0, 5, 0), v3(1, 0.5, 1));
    stepTicks(world, 120);
    const out = bodyState();
    expect(world.readBody(kerb.body, out)).toBe(true);
    expect(out.position).toEqual({ x: 0, y: 5, z: 0 });
    expect(out.linearVelocity).toEqual({ x: 0, y: 0, z: 0 });
    world.dispose();
  });

  test("[ER-07-01] createBody rejects contract violations with E_CONTRACT", () => {
    const world = makeWorld();
    expect(
      codeOf(() =>
        world.createBody({ type: "static", linearVelocity: v3(1, 0, 0) }),
      ),
    ).toBe("E_CONTRACT");
    expect(codeOf(() => world.createBody({ type: "dynamic", mass: -1 }))).toBe(
      "E_CONTRACT",
    );
    expect(
      codeOf(() => world.createBody({ type: "dynamic", linearDamping: 1.5 })),
    ).toBe("E_CONTRACT");
    expect(
      codeOf(() =>
        world.createBody({ type: "dynamic", userData: 0x1_0000_0000 }),
      ),
    ).toBe("E_CONTRACT");
    expect(
      codeOf(() => world.createBody({ type: "nope" as never })),
    ).toBe("E_CONTRACT");
    expect(world.stats.bodyCount).toBe(0);
    world.dispose();
  });

  test("[ER-07-01] destroyed body handles are stale and never resolve after slot reuse", () => {
    const world = makeWorld();
    const first = dynamicSphere(world, v3(0, 1, 0), 0.5).body;
    world.destroyBody(first);
    const out = bodyState();
    expect(world.readBody(first, out)).toBe(false);
    const staleBefore = world.stats.staleHandles;
    world.destroyBody(first);
    expect(world.stats.staleHandles).toBe(staleBefore + 1);
    const second = dynamicSphere(world, v3(0, 1, 0), 0.5).body;
    expect(second.index).toBe(first.index);
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(world.readBody(first, out)).toBe(false);
    expect(world.readBody(second, out)).toBe(true);
    world.dispose();
  });

  test("[ER-07-01] setTransform, velocity setters and impulses update body state", () => {
    const world = makeWorld({ gravity: v3(0, 0, 0) });
    const { body } = dynamicBox(world, v3(0, 1, 0), v3(0.5, 0.5, 0.5));
    const out = bodyState();
    world.setTransform(body, v3(2, 3, 4), q());
    expect(world.readBody(body, out)).toBe(true);
    expect(out.position).toEqual({ x: 2, y: 3, z: 4 });

    world.setLinearVelocity(body, v3(1, 0, 0));
    stepTicks(world, 60);
    world.readBody(body, out);
    expect(out.position.x).toBeGreaterThan(2.5);

    world.setLinearVelocity(body, v3(0, 0, 0));
    world.applyImpulse(body, v3(0, 0, 1000), true);
    stepTicks(world, 1);
    world.readBody(body, out);
    expect(out.linearVelocity.z).toBeGreaterThan(0.5);
    world.dispose();
  });

  test("[ER-07-01] disabling a body freezes it until re-enabled", () => {
    const world = makeWorld();
    const { body } = dynamicSphere(world, v3(0, 5, 0), 0.5);
    const out = bodyState();
    world.setEnabled(body, false);
    stepTicks(world, 60);
    world.readBody(body, out);
    expect(out.position.y).toBe(5);
    expect(out.enabled).toBe(false);
    world.setEnabled(body, true);
    stepTicks(world, 30);
    world.readBody(body, out);
    expect(out.position.y).toBeLessThan(5);
    expect(out.enabled).toBe(true);
    world.dispose();
  });

  test("[ER-07-01] kinematic velocity bodies follow their velocity", () => {
    const world = makeWorld({ gravity: v3(0, 0, 0) });
    const body = world.createBody({
      type: "kinematicVelocity",
      position: v3(0, 0, 0),
      linearVelocity: v3(1, 0, 0),
    });
    world.createCollider(body, {
      shape: { kind: "box", halfExtents: v3(0.5, 0.5, 0.5) },
    });
    stepTicks(world, 60);
    const out = bodyState();
    world.readBody(body, out);
    expect(out.position.x).toBeCloseTo(1, 2);
    world.dispose();
  });

  test("[ER-07-01] the dynamic-body cap drops excess bodies with an invalid handle", () => {
    const world = makeWorld({ maxDynamicBodies: 2 });
    dynamicSphere(world, v3(0, 1, 0), 0.5);
    dynamicSphere(world, v3(1, 1, 0), 0.5);
    const dropped = world.createBody({ type: "dynamic", position: v3(2, 1, 0) });
    expect(dropped.index).toBe(-1);
    expect(world.stats.droppedBodies).toBe(1);
    expect(world.stats.bodyCount).toBe(2);
    world.dispose();
  });
});

describe("colliders", () => {
  test("[ER-07-01] all four shape kinds create; a dynamic trimesh is E_ASSET_FORMAT", () => {
    const world = makeWorld();
    const body = world.createBody({ type: "dynamic", position: v3(0, 5, 0) });
    expect(
      world.createCollider(body, { shape: { kind: "sphere", radius: 0.5 } })
        .index,
    ).toBeGreaterThanOrEqual(0);
    expect(
      world.createCollider(body, {
        shape: { kind: "box", halfExtents: v3(0.5, 0.5, 0.5) },
      }).index,
    ).toBeGreaterThanOrEqual(0);
    expect(
      world.createCollider(body, {
        shape: { kind: "capsule", radius: 0.3, halfHeight: 0.5 },
      }).index,
    ).toBeGreaterThanOrEqual(0);

    const mesh = triangleMesh();
    expect(
      codeOf(() =>
        world.createCollider(body, { shape: { kind: "trimesh", ...mesh } }),
      ),
    ).toBe("E_ASSET_FORMAT");

    const staticBody = world.createBody({ type: "static" });
    expect(
      world.createCollider(staticBody, { shape: { kind: "trimesh", ...mesh } })
        .index,
    ).toBeGreaterThanOrEqual(0);
    world.dispose();
  });

  test("[ER-07-01] collider material and filter fields round-trip through readCollider", () => {
    const world = makeWorld({ gravity: v3(0, 0, 0) });
    const fixture = staticBox(
      world,
      v3(0, 0, 0),
      v3(1, 2, 3),
      { friction: 0.4, restitution: 0.5, layer: 7, mask: 0xff },
    );
    const out = colliderState();
    expect(world.readCollider(fixture.collider, out)).toBe(true);
    expect(out.body).toEqual(fixture.body);
    expect(out.friction).toBe(0.4);
    expect(out.restitution).toBe(0.5);
    expect(out.layer).toBe(7);
    expect(out.mask).toBe(0xff);
    expect(out.sensor).toBe(false);
    expect(out.worldAabbMin.x).toBeCloseTo(-1, 5);
    expect(out.worldAabbMin.y).toBeCloseTo(-2, 5);
    expect(out.worldAabbMin.z).toBeCloseTo(-3, 5);
    expect(out.worldAabbMax.x).toBeCloseTo(1, 5);
    expect(out.worldAabbMax.y).toBeCloseTo(2, 5);
    expect(out.worldAabbMax.z).toBeCloseTo(3, 5);
    world.dispose();
  });

  test("[ER-07-01] collider validation rejects bad material, bounds and layer values", () => {
    const world = makeWorld();
    const body = world.createBody({ type: "static" });
    const box = { kind: "box" as const, halfExtents: v3(0.5, 0.5, 0.5) };
    expect(
      codeOf(() => world.createCollider(body, { shape: box, friction: -0.1 })),
    ).toBe("E_CONTRACT");
    expect(
      codeOf(() => world.createCollider(body, { shape: box, restitution: 1.1 })),
    ).toBe("E_CONTRACT");
    expect(
      codeOf(() => world.createCollider(body, { shape: box, density: -5 })),
    ).toBe("E_CONTRACT");
    expect(
      codeOf(() => world.createCollider(body, { shape: box, layer: 32 })),
    ).toBe("E_CONTRACT");
    expect(
      codeOf(() => world.createCollider(body, { shape: box, mask: -1 })),
    ).toBe("E_CONTRACT");
    expect(
      codeOf(() =>
        world.createCollider(body, { shape: { kind: "sphere", radius: 0 } }),
      ),
    ).toBe("E_CONTRACT");
    expect(
      codeOf(() =>
        world.createCollider(body, {
          shape: { kind: "box", halfExtents: v3(0, 1, 1) },
        }),
      ),
    ).toBe("E_CONTRACT");
    world.dispose();
  });

  test("[ER-07-01] malformed trimeshes are rejected with E_ASSET_FORMAT", () => {
    const world = makeWorld();
    const body = world.createBody({ type: "static" });
    const vertexBuffer = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indexBuffer = new Uint32Array([0, 1, 2]);

    expect(
      codeOf(() =>
        world.createCollider(body, {
          shape: {
            kind: "trimesh",
            vertices: [0, 0, 0] as unknown as Float32Array,
            indices: indexBuffer,
            triangleCount: 1,
          },
        }),
      ),
    ).toBe("E_ASSET_FORMAT");
    expect(
      codeOf(() =>
        world.createCollider(body, {
          shape: {
            kind: "trimesh",
            vertices: vertexBuffer,
            indices: indexBuffer,
            triangleCount: 2,
          },
        }),
      ),
    ).toBe("E_ASSET_FORMAT");
    expect(
      codeOf(() =>
        world.createCollider(body, {
          shape: {
            kind: "trimesh",
            vertices: vertexBuffer,
            indices: new Uint32Array([0, 1, 3]),
            triangleCount: 1,
          },
        }),
      ),
    ).toBe("E_ASSET_FORMAT");
    expect(
      codeOf(() =>
        world.createCollider(body, {
          shape: {
            kind: "trimesh",
            vertices: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
            indices: indexBuffer,
            triangleCount: 1,
          },
        }),
      ),
    ).toBe("E_ASSET_FORMAT");
    world.dispose();
  });

  test("[ER-07-01] a body holds at most 32 colliders", () => {
    const world = makeWorld();
    const body = world.createBody({ type: "static" });
    for (let i = 0; i < 32; i += 1) {
      world.createCollider(body, { shape: { kind: "sphere", radius: 0.1 } });
    }
    expect(
      codeOf(() =>
        world.createCollider(body, { shape: { kind: "sphere", radius: 0.1 } }),
      ),
    ).toBe("E_CONTRACT");
    expect(world.stats.colliderCount).toBe(32);
    world.dispose();
  });

  test("[ER-07-01] the world collider cap drops excess colliders", () => {
    const world = makeWorld({ maxColliders: 1 });
    const body = world.createBody({ type: "static" });
    world.createCollider(body, { shape: { kind: "sphere", radius: 0.1 } });
    const dropped = world.createCollider(body, {
      shape: { kind: "sphere", radius: 0.1 },
    });
    expect(dropped.index).toBe(-1);
    expect(world.stats.droppedColliders).toBe(1);
    expect(world.stats.colliderCount).toBe(1);
    world.dispose();
  });
});

describe("queries", () => {
  test("[ER-07-01] a ray reports the nearest collider, distance, point and normal", () => {
    const world = makeWorld();
    ground(world);
    const obstacle = staticBox(world, v3(3, 1, 0), v3(0.5, 0.5, 0.5));
    /* Rapier only publishes colliders to its query structures during step. */
    stepTicks(world, 1);
    const hit = raycastHit();
    expect(
      world.raycast(
        { origin: v3(3, 5, 0), direction: v3(0, -1, 0), maxDistance: 10 },
        hit,
      ),
    ).toBe(true);
    expect(hit.body).toEqual(obstacle.body);
    expect(hit.collider).toEqual(obstacle.collider);
    expect(hit.distance).toBeCloseTo(3.5, 3);
    expect(hit.point.y).toBeCloseTo(1.5, 3);
    expect(hit.normal.y).toBeGreaterThan(0.9);
    expect(hit.triangleIndex).toBe(-1);
    expect(hit.sensor).toBe(false);

    expect(
      world.raycast(
        { origin: v3(3, 5, 0), direction: v3(0, -1, 0), maxDistance: 3 },
        hit,
      ),
    ).toBe(false);
    world.dispose();
  });

  test("[ER-07-01] a solid ray starting inside a shape reports distance zero", () => {
    const world = makeWorld();
    const box = staticBox(world, v3(0, 0, 0), v3(1, 1, 1));
    stepTicks(world, 1);
    const hit = raycastHit();
    expect(
      world.raycast(
        { origin: v3(0, 0, 0), direction: v3(1, 0, 0), maxDistance: 10 },
        hit,
      ),
    ).toBe(true);
    expect(hit.collider).toEqual(box.collider);
    expect(hit.distance).toBe(0);
    world.dispose();
  });

  test("[ER-07-01] raycastAll sorts by distance and honors mask and body exclusion", () => {
    const world = makeWorld();
    const first = staticBox(world, v3(1, 0, 0), v3(0.5, 0.5, 0.5), {
      layer: 1,
    });
    staticBox(world, v3(2, 0, 0), v3(0.5, 0.5, 0.5));
    staticBox(world, v3(3, 0, 0), v3(0.5, 0.5, 0.5));
    stepTicks(world, 1);
    const hits: ReturnType<typeof raycastHit>[] = [];
    const input = {
      origin: v3(-5, 0, 0),
      direction: v3(1, 0, 0),
      maxDistance: 20,
    };

    const all = world.raycastAll(input, hits);
    expect(all).toBe(3);
    expect(hits.length).toBe(3);
    expect(hits[0]!.distance).toBeLessThan(hits[1]!.distance);
    expect(hits[1]!.distance).toBeLessThan(hits[2]!.distance);
    expect(hits[0]!.body).toEqual(first.body);

    const withoutLayerOne = world.raycastAll(
      { ...input, filter: { mask: (FULL_MASK ^ (1 << 1)) >>> 0 } },
      hits,
    );
    expect(withoutLayerOne).toBe(2);

    const withoutFirst = world.raycastAll(
      { ...input, filter: { excludeBody: first.body } },
      hits,
    );
    expect(withoutFirst).toBe(2);
    world.dispose();
  });

  test("[ER-07-01] trimesh ray hits report a triangle index", () => {
    const world = makeWorld();
    const mesh = staticTrimesh(
      world,
      v3(0, 0, 0),
      new Float32Array([-2, 2, -2, 2, 2, -2, 2, 2, 2, -2, 2, 2]),
      new Uint32Array([0, 1, 2, 0, 2, 3]),
    );
    stepTicks(world, 1);
    const hit = raycastHit();
    expect(
      world.raycast(
        { origin: v3(0.5, 0, 0), direction: v3(0, 1, 0), maxDistance: 10 },
        hit,
      ),
    ).toBe(true);
    expect(hit.collider).toEqual(mesh.collider);
    expect(hit.triangleIndex).toBeGreaterThanOrEqual(0);
    expect(hit.triangleIndex).toBeLessThan(2);
    world.dispose();
  });

  test("[ER-07-01] sphereCast reports travel and the overlap queries find colliders", () => {
    const world = makeWorld();
    ground(world);
    const box = staticBox(world, v3(0, 1, 0), v3(0.5, 0.5, 0.5));
    stepTicks(world, 1);

    const cast = shapeCastHit();
    expect(
      world.sphereCast(
        0.25,
        {
          origin: v3(0, 5, 0),
          direction: v3(0, -1, 0),
          maxDistance: 10,
        },
        cast,
      ),
    ).toBe(true);
    expect(cast.collider).toEqual(box.collider);
    expect(cast.travel).toBeCloseTo(3.25, 2);
    expect(cast.distance).toBeCloseTo(3.25, 2);

    const found: ColliderHandle[] = [];
    expect(world.overlapSphere(v3(0, 1, 0), 0.6, {}, found)).toBe(1);
    expect(found[0]).toEqual(box.collider);

    expect(
      world.overlapBox(v3(0, 1, 0), v3(0.6, 0.6, 0.6), q(), {}, found),
    ).toBe(1);
    expect(found[0]).toEqual(box.collider);

    expect(world.pointQuery(v3(0, 1, 0), {}, found)).toBe(1);
    expect(found[0]).toEqual(box.collider);
    world.dispose();
  });
});

describe("joints", () => {
  test("[ER-07-01] a fixed joint keeps two bodies together and stale joints do not resolve", () => {
    const world = makeWorld({ gravity: v3(0, 0, 0) });
    const a = dynamicBox(world, v3(0, 2, 0), v3(0.3, 0.3, 0.3)).body;
    const b = dynamicBox(world, v3(0, 3, 0), v3(0.3, 0.3, 0.3)).body;
    /* Anchors are body-local; anchorA at B's origin preserves the 1 m offset. */
    const joint = world.createJoint({
      kind: "fixed",
      bodyA: a,
      bodyB: b,
      anchorA: v3(0, 1, 0),
      anchorB: v3(0, 0, 0),
    });
    const out = jointState();
    expect(world.readJoint(joint, out)).toBe(true);
    expect(out.error).toBe(0);
    expect(out.motorImpulse).toBe(0);

    world.applyImpulse(b, v3(5000, 0, 0), true);
    stepTicks(world, 60);
    const stateA = bodyState();
    const stateB = bodyState();
    world.readBody(a, stateA);
    world.readBody(b, stateB);
    const separation = Math.hypot(
      stateB.position.x - stateA.position.x,
      stateB.position.y - stateA.position.y,
      stateB.position.z - stateA.position.z,
    );
    expect(Math.abs(separation - 1)).toBeLessThan(0.05);

    world.destroyJoint(joint);
    expect(world.readJoint(joint, out)).toBe(false);
    const staleBefore = world.stats.staleHandles;
    world.destroyJoint(joint);
    expect(world.stats.staleHandles).toBe(staleBefore + 1);
    world.dispose();
  });

  test("[ER-07-01] a motor is rejected on a joint kind that has none", () => {
    const world = makeWorld({ gravity: v3(0, 0, 0) });
    const a = dynamicBox(world, v3(0, 2, 0), v3(0.3, 0.3, 0.3)).body;
    const b = dynamicBox(world, v3(0, 3, 0), v3(0.3, 0.3, 0.3)).body;
    const joint: JointHandle = world.createJoint({
      kind: "fixed",
      bodyA: a,
      bodyB: b,
    });
    expect(
      codeOf(() =>
        world.setJointMotor(joint, { targetVelocity: 1, maxForce: 10 }),
      ),
    ).toBe("E_UNSUPPORTED_FEATURE");
    world.dispose();
  });
});

describe("events", () => {
  test("[ER-07-01] a solid contact emits one start event, not one per tick", () => {
    const world = makeWorld();
    ground(world);
    dynamicBox(world, v3(0, 2, 0), v3(0.5, 0.5, 0.5));
    const events = contactEvents();
    let sawContact = false;
    for (let i = 0; i < 180; i += 1) {
      world.step(DT);
      if (world.drainContactEvents(events) > 0) sawContact = true;
    }
    expect(sawContact).toBe(true);
    expect(world.drainContactEvents(events)).toBe(0);
    expect(events.length).toBe(0);
    world.dispose();
  });

  test("[ER-07-01] sensors emit enter and exit triggers and no contact events", () => {
    const world = makeWorld({ gravity: v3(0, 0, 0) });
    const sensorBody = world.createBody({
      type: "static",
      position: v3(0, 0, 0),
    });
    world.createCollider(sensorBody, {
      shape: { kind: "sphere", radius: 1 },
      sensor: true,
      layer: 1,
      mask: FULL_MASK,
    });
    dynamicBox(world, v3(0, -3, 0), v3(0.4, 0.4, 0.4), {
      linearVelocity: v3(0, 2, 0),
    });

    const triggers = triggerEvents();
    const contacts = contactEvents();
    stepTicks(world, 150);
    expect(world.drainContactEvents(contacts)).toBe(0);
    expect(world.drainTriggerEvents(triggers)).toBeGreaterThanOrEqual(2);
    expect(triggers.some((event) => event.phase === "enter")).toBe(true);
    expect(triggers.some((event) => event.phase === "exit")).toBe(true);
    world.dispose();
  });
});

describe("scene integration", () => {
  test("[ER-07-01] syncScene writes Transform and PreviousTransform", () => {
    const world = makeWorld();
    const scene = createScene();
    const entity = scene.createEntity();
    const sphere = dynamicSphere(world, v3(0, 10, 0), 0.5);
    world.bindTransform(entity, sphere.body);
    world.syncScene(scene);

    const transform = scene.get(entity, Transform) as TransformData;
    const previous = scene.get(entity, PreviousTransform);
    expect(transform.position.y).toBeCloseTo(10, 5);
    expect(previous).toBeDefined();
    expect(previous!.position.y).toBeCloseTo(10, 5);

    world.step(DT);
    world.syncScene(scene);
    expect(transform.position.y).toBeLessThan(10);
    expect(previous!.position.y).toBeCloseTo(10, 5);

    const sampled: TransformData = {
      position: v3(),
      rotation: q(),
      scale: v3(1, 1, 1),
    };
    expect(world.sampleTransform(sphere.body, 0.5, sampled)).toBe(true);
    expect(sampled.position.y).toBeGreaterThan(transform.position.y);
    expect(sampled.position.y).toBeLessThan(previous!.position.y);
    world.dispose();
  });

  test("[ER-07-01] rebaseOrigin moves bodies and their interpolation state", () => {
    const world = makeWorld({ gravity: v3(0, 0, 0) });
    const box = dynamicBox(world, v3(10, 0, 0), v3(0.5, 0.5, 0.5));
    world.step(DT);
    world.rebaseOrigin(v3(2, 0, 0));
    const out = bodyState();
    world.readBody(box.body, out);
    expect(out.position.x).toBeCloseTo(8, 5);
    const sampled: TransformData = {
      position: v3(),
      rotation: q(),
      scale: v3(1, 1, 1),
    };
    expect(world.sampleTransform(box.body, 0.5, sampled)).toBe(true);
    expect(sampled.position.x).toBeCloseTo(8, 5);
    world.dispose();
  });
});

describe("determinism primitives", () => {
  test("[ER-07-01] identical worlds hash equally and motion changes the hash", () => {
    const build = () => {
      const world = makeWorld();
      ground(world);
      dynamicSphere(world, v3(-1, 3, 0), 0.5);
      dynamicBox(world, v3(1, 3, 0), v3(0.4, 0.4, 0.4));
      dynamicCapsule(world, v3(0, 3, 1), 0.3, 0.4);
      return world;
    };
    const left = build();
    const right = build();
    stepTicks(left, 30);
    stepTicks(right, 30);
    expect(left.stateHash()).toBe(right.stateHash());
    const before = left.stateHash();
    stepTicks(left, 30);
    expect(left.stateHash()).not.toBe(before);
    left.dispose();
    right.dispose();
  });

  test("[ER-07-01] default solver configuration is the frozen 07 §3.2 value", () => {
    expect(PHYSICS_DEFAULT_SOLVER).toEqual({
      velocityIterations: 8,
      positionIterations: 3,
      warmStarting: true,
      substeps: 1,
    });
  });
});
