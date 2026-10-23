/**
 * Shared, engine-neutral numbers for the Havok vs Rapier spike (stream H).
 *
 * Both backends receive the same car, character and course descriptors, so a
 * behavioural difference comes from the physics engine or its Babylon
 * integration, not from different test inputs.
 *
 * Axes follow the engine: +Y up, -Z forward, +X right (spec 02 §3.1).
 */

export const FIXED_DT = 1 / 60;
export const GRAVITY = Object.freeze({ x: 0, y: -9.81, z: 0 });
export const SPEED_50_KMH = 50 / 3.6;

export const CAR = Object.freeze({
  mass: 1250,
  /** Box half extents: 1.9 m wide, 1.0 m tall, 4.2 m long. */
  halfExtents: Object.freeze({ x: 0.95, y: 0.5, z: 2.1 }),
  /** Chassis centre height with the wheels at their rest length. */
  spawn: Object.freeze({ x: 0, y: 0.9, z: 0 }),
  engineForce: 8000,
  reverseForce: 4000,
  brakeForce: 12000,
  maxSteerDegrees: 35,
  steerRateDegreesPerSecond: 180,
  topSpeed: 55,
  wheels: Object.freeze([
    {
      localPosition: Object.freeze({ x: -0.8, y: -0.25, z: -1.3 }),
      radius: 0.35,
      width: 0.25,
      suspensionRestLength: 0.3,
      suspensionStiffness: 45000,
      suspensionDamping: 4000,
      maxTravel: 0.2,
      steerable: true,
      driven: false,
      friction: 1,
    },
    {
      localPosition: Object.freeze({ x: 0.8, y: -0.25, z: -1.3 }),
      radius: 0.35,
      width: 0.25,
      suspensionRestLength: 0.3,
      suspensionStiffness: 45000,
      suspensionDamping: 4000,
      maxTravel: 0.2,
      steerable: true,
      driven: false,
      friction: 1,
    },
    {
      localPosition: Object.freeze({ x: -0.8, y: -0.25, z: 1.3 }),
      radius: 0.35,
      width: 0.25,
      suspensionRestLength: 0.3,
      suspensionStiffness: 45000,
      suspensionDamping: 4000,
      maxTravel: 0.2,
      steerable: false,
      driven: true,
      friction: 1,
    },
    {
      localPosition: Object.freeze({ x: 0.8, y: -0.25, z: 1.3 }),
      radius: 0.35,
      width: 0.25,
      suspensionRestLength: 0.3,
      suspensionStiffness: 45000,
      suspensionDamping: 4000,
      maxTravel: 0.2,
      steerable: false,
      driven: true,
      friction: 1,
    },
  ]),
});

export const CHARACTER = Object.freeze({
  radius: 0.3,
  /** Capsule total height = 2 * (halfHeight + radius) = 1.8 m. */
  halfHeight: 0.6,
  /**
   * Centre height when standing on y = 0, spawned a few centimetres high.
   * Babylon's Havok character only settles to its 0.05 m keep-distance gap
   * when it lands; spawning exactly at 0.9 leaves it in permanent zero-distance
   * contact, which makes the step-up's upward shape cast start overlapping the
   * ground and abort at fraction 0.
   */
  spawnY: 0.95,
  slopeLimitDegrees: 45,
  /**
   * Slightly above the 0.3 m curb used by the step scenario. A step exactly at
   * the configured limit is treated as unclimbable by both engines (measured:
   * both stall at the front face with 0.3), which is normal game tuning: give
   * the controller a little margin over the tallest curb in the level.
   */
  stepOffset: 0.35,
  snapToGround: 0.1,
  gravity: 9.81,
  mass: 70,
  /** Walking speed used by the scripted character scenarios. */
  speed: 2,
});

/** Deterministic benchmark pile: 10 x 10 x 5 boxes, 0.5 m cubes. */
export const BENCH = Object.freeze({
  count: 500,
  warmupSteps: 180,
  measuredSteps: 300,
  frameWarmup: 60,
  frameSamples: 240,
});
