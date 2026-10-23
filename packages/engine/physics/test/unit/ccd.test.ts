/**
 * ER-07-06: high-speed CCD fixture (07 §5.5).
 *
 * A 250 m/s sphere crosses a 0.1 m wall 10,000 times. With `ccd: true` the
 * sphere must never pass the wall; with `ccd: false` the same setup documents
 * the tunnelling it is meant to prevent.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";
import {
  DT,
  bodyState,
  dynamicSphere,
  init,
  makeWorld,
  staticBox,
  v3,
} from "../support/world";

interface CcdFixture {
  readonly wall: {
    readonly position: readonly number[];
    readonly halfExtents: readonly number[];
  };
  readonly sphere: {
    readonly radius: number;
    readonly start: readonly number[];
    readonly velocity: readonly number[];
  };
  readonly attempts: number;
  readonly ticksPerAttempt: number;
  readonly recorded: {
    readonly tunnelled: number | null;
    readonly maxCenterX: number | null;
    readonly noCcdEndX: number | null;
    readonly ccdFlagObservable: boolean | null;
    readonly nodeResult: string;
  };
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/ccd-wall.json", import.meta.url), "utf8"),
) as CcdFixture;

const START = v3(
  fixture.sphere.start[0]!,
  fixture.sphere.start[1]!,
  fixture.sphere.start[2]!,
);
const VELOCITY = v3(
  fixture.sphere.velocity[0]!,
  fixture.sphere.velocity[1]!,
  fixture.sphere.velocity[2]!,
);
/*
 * Tunnelling means the sphere centre emerges past the wall's far face
 * (x = +0.05). Resting penetration of a few centimetres at the near face is
 * normal contact slop, not a pass-through.
 */
const WALL_FAR_FACE =
  fixture.wall.position[0]! + fixture.wall.halfExtents[0]!;

beforeAll(async () => {
  await init();
});

describe("CCD wall fixture", () => {
  test(
    "[ER-07-06] a 250 m/s CCD sphere never tunnels through a 0.1 m wall",
    () => {
      const world = makeWorld({ gravity: v3(0, 0, 0) });
      staticBox(
        world,
        v3(
          fixture.wall.position[0]!,
          fixture.wall.position[1]!,
          fixture.wall.position[2]!,
        ),
        v3(
          fixture.wall.halfExtents[0]!,
          fixture.wall.halfExtents[1]!,
          fixture.wall.halfExtents[2]!,
        ),
      );
      const sphere = dynamicSphere(world, START, fixture.sphere.radius, {
        ccd: true,
        linearVelocity: VELOCITY,
      });
      const out = bodyState();
      let tunnelled = 0;
      let maxCenterX = -Infinity;
      for (let attempt = 0; attempt < fixture.attempts; attempt += 1) {
        world.setTransform(sphere.body, START, { x: 0, y: 0, z: 0, w: 1 });
        world.setLinearVelocity(sphere.body, VELOCITY);
        for (let tick = 0; tick < fixture.ticksPerAttempt; tick += 1) {
          world.step(DT);
        }
        world.readBody(sphere.body, out);
        if (out.position.x > WALL_FAR_FACE) tunnelled += 1;
        if (out.position.x > maxCenterX) maxCenterX = out.position.x;
      }
      expect(tunnelled).toBe(0);
      expect(maxCenterX).toBeLessThan(WALL_FAR_FACE);
      if (fixture.recorded.tunnelled !== null) {
        expect(tunnelled).toBe(fixture.recorded.tunnelled);
      }
      if (fixture.recorded.maxCenterX !== null) {
        expect(maxCenterX).toBeCloseTo(fixture.recorded.maxCenterX, 6);
      }
      console.log(
        `[record ccd-wall] attempts=${fixture.attempts} tunnelled=${tunnelled} maxCenterX=${maxCenterX}`,
      );
      world.dispose();
    },
    120_000,
  );

  /*
   * 07 ER-07-06 says the `ccd: false` half of this fixture must document a
   * pass-through. With Rapier 0.21 it does not: the world-level
   * `maxCcdSubsteps` (4 in this adapter) sweeps every fast body, and the
   * per-body `setCcdEnabled` flag has no observable effect. This test records
   * the actual behaviour rather than assert a pass-through that does not
   * happen; the conflict is reported, not hidden.
   */
  test("[ER-07-06] no-CCD control: Rapier 0.21 blocks the wall too (spec expects pass-through)", () => {
    const off = makeWorld({ gravity: v3(0, 0, 0) });
    const on = makeWorld({ gravity: v3(0, 0, 0) });
    for (const world of [off, on]) {
      staticBox(
        world,
        v3(
          fixture.wall.position[0]!,
          fixture.wall.position[1]!,
          fixture.wall.position[2]!,
        ),
        v3(
          fixture.wall.halfExtents[0]!,
          fixture.wall.halfExtents[1]!,
          fixture.wall.halfExtents[2]!,
        ),
      );
    }
    const offSphere = dynamicSphere(off, START, fixture.sphere.radius, {
      ccd: false,
      linearVelocity: VELOCITY,
    });
    const onSphere = dynamicSphere(on, START, fixture.sphere.radius, {
      ccd: true,
      linearVelocity: VELOCITY,
    });
    for (let tick = 0; tick < fixture.ticksPerAttempt; tick += 1) {
      off.step(DT);
      on.step(DT);
    }
    const offState = bodyState();
    const onState = bodyState();
    off.readBody(offSphere.body, offState);
    on.readBody(onSphere.body, onState);
    /* Both flags land at the near face: no pass-through either way. */
    expect(offState.position.x).toBeLessThan(WALL_FAR_FACE);
    expect(onState.position.x).toBeCloseTo(offState.position.x, 6);
    const ccdFlagObservable = Math.abs(onState.position.x - offState.position.x) > 1e-6;
    expect(ccdFlagObservable).toBe(fixture.recorded.ccdFlagObservable ?? false);
    if (fixture.recorded.noCcdEndX !== null) {
      expect(offState.position.x).toBeCloseTo(
        fixture.recorded.noCcdEndX,
        6,
      );
    }
    console.log(
      `[record ccd-wall] noCcdEndX=${offState.position.x} ccdEndX=${onState.position.x} ccdFlagObservable=${ccdFlagObservable}`,
    );
    off.dispose();
    on.dispose();
  });
});
