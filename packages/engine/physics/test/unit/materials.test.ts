/**
 * Material combination tests (07 §5.7, ER-07-01).
 *
 * The slope angle is chosen between the Average and geometric-mean friction
 * thresholds for a 0.2 / 0.8 pair: Average = 0.5 holds (tan 25° ≈ 0.466),
 * geometric mean = 0.4 slides. A 0.5 / 0.5 control shows the slope itself.
 */
import { beforeAll, describe, expect, test } from "vitest";
import {
  bodyState,
  colliderState,
  dynamicBox,
  init,
  makeWorld,
  q,
  staticBox,
  stepTicks,
  v3,
} from "../support/world";

const DEG = Math.PI / 180;
const SLOPE_DEG = 25;
const SLOPE_Q = q(0, 0, Math.sin((SLOPE_DEG * DEG) / 2), Math.cos((SLOPE_DEG * DEG) / 2));

beforeAll(async () => {
  await init();
});

function slopeWorld(boxFriction: number, rampFriction: number) {
  const world = makeWorld();
  staticBox(world, v3(0, 0, 0), v3(5, 0.5, 2), {
    friction: rampFriction,
    localRotation: SLOPE_Q,
  });
  /*
   * Surface point (0, 0.5515) for this ramp; the box centre sits half its
   * height along the surface normal (-sin 25°, cos 25°, 0).
   */
  const box = dynamicBox(
    world,
    v3(-0.1057, 0.778, 0),
    v3(0.25, 0.25, 0.25),
    { rotation: SLOPE_Q },
    { friction: boxFriction },
  );
  return { world, box };
}

function displacement(
  world: ReturnType<typeof makeWorld>,
  body: ReturnType<typeof slopeWorld>["box"],
) {
  const out = bodyState();
  world.readBody(body.body, out);
  return { x: out.position.x + 0.1057, y: out.position.y - 0.778 };
}

describe("material combination", () => {
  test("[ER-07-01] friction combines as sqrt(muA * muB), not the average", () => {
    const { world, box } = slopeWorld(0.2, 0.8);
    const rampState = colliderState();
    expect(world.readCollider(box.collider, rampState)).toBe(true);
    expect(rampState.friction).toBe(0.2);

    stepTicks(world, 120);
    const moved = displacement(world, box);
    /*
     * Average would be 0.5 > tan 25° and the box would stay put. The
     * geometric mean is 0.4 < tan 25° and the box slides down-slope.
     */
    expect(Math.hypot(moved.x, moved.y)).toBeGreaterThan(0.5);
    world.dispose();
  });

  test("[ER-07-01] a 0.5 / 0.5 pair holds on the same 25° ramp", () => {
    const { world, box } = slopeWorld(0.5, 0.5);
    stepTicks(world, 120);
    const moved = displacement(world, box);
    expect(Math.hypot(moved.x, moved.y)).toBeLessThan(0.05);
    world.dispose();
  });
});
