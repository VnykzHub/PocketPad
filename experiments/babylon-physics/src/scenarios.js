/**
 * Scripted, engine-neutral scenarios for the physics spike.
 *
 * Every scenario builds a fresh world through the small backend seam and
 * drives it with a deterministic input script. Nothing here imports Babylon or
 * either physics engine, so the same script runs against both backends.
 *
 * The seam each backend implements:
 *
 *   createWorld({ visual, engine }) -> world
 *   world.scene, world.engine
 *   world.addStaticBox({ halfExtents, position, friction })
 *   world.addDynamicBox({ halfExtents, position, color? })
 *   world.createCar() -> car
 *   world.setCarInput(car, { throttle, steering, brake })
 *   world.carState(car) -> { position, rotation, up, speed, wheels }
 *   world.createCharacter(position) -> character
 *   world.characterMove(character, desired, dt) -> { moved, grounded, hitWall }
 *   world.characterState(character) -> { position, grounded }
 *   world.step(), world.stepSync(), world.syncVisuals()
 *   world.hashState() -> hex string
 *   world.dynamicBodyCount(), world.focusCamera(car|"bench")
 *   world.dispose()
 */

import { BENCH, CAR, CHARACTER, FIXED_DT, SPEED_50_KMH } from "./constants.js";
import {
  angleDelta,
  clamp,
  round,
  summarize,
  yawFromQuaternion,
} from "./seam.js";

function addGround(world, friction = 0.9) {
  // Large enough that the 10 s acceleration run (about 200 m at 70-130 km/h)
  // stays on the surface instead of measuring a fall.
  world.addStaticBox({
    halfExtents: { x: 400, y: 0.5, z: 400 },
    position: { x: 0, y: -0.5, z: 0 },
    friction,
  });
}

function tracePoint(tick, state) {
  return {
    t: round((tick + 1) * FIXED_DT, 2),
    speedKmh: round(Math.abs(state.speed) * 3.6, 2),
    z: round(state.position.z, 2),
    y: round(state.position.y, 3),
  };
}

// ---------------------------------------------------------------------------
// Car: acceleration to 50 km/h

export function runCarAcceleration(backend) {
  const world = backend.createWorld({ visual: false });
  try {
    addGround(world);
    const car = world.createCar();
    const start = world.carState(car).position;
    let timeTo50 = null;
    let maxLateral = 0;
    let maxRollDeg = 0;
    const trace = [];

    for (let tick = 0; tick < 600; tick += 1) {
      world.setCarInput(car, { throttle: 1, steering: 0, brake: 0 });
      world.step();
      const state = world.carState(car);
      if (timeTo50 === null && state.speed >= SPEED_50_KMH) {
        timeTo50 = (tick + 1) * FIXED_DT;
      }
      maxLateral = Math.max(maxLateral, Math.abs(state.position.x - start.x));
      maxRollDeg = Math.max(
        maxRollDeg,
        (Math.acos(clamp(state.up.y, -1, 1)) * 180) / Math.PI,
      );
      if (tick % 30 === 0 || tick === 599) trace.push(tracePoint(tick, state));
    }
    const final = world.carState(car);
    return {
      name: "car-accel-0-50",
      ticks: 600,
      timeTo50KmhSeconds: timeTo50 === null ? null : round(timeTo50, 3),
      speedAt2sKmh: round(speedAt(trace, 2), 2),
      speedAt5sKmh: round(speedAt(trace, 5), 2),
      speedAt10sKmh: round(Math.abs(final.speed) * 3.6, 2),
      distanceAt10sM: round(Math.abs(final.position.z - start.z), 2),
      maxLateralDeviationM: round(maxLateral, 4),
      maxRollDegrees: round(maxRollDeg, 2),
      upright: final.up.y > 0.5,
      finite: isFinitePose(final),
      final: poseOf(final),
      trace,
    };
  } finally {
    world.dispose();
  }
}

function speedAt(trace, seconds) {
  let best = 0;
  for (const point of trace) {
    if (point.t <= seconds) best = point.speedKmh;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Diagnostic probe: suspension and contact telemetry, printed as evidence when
// the page is opened with ?probe=1. Not part of the comparison table.

export function runCarProbe(backend) {
  const world = backend.createWorld({ visual: false });
  try {
    addGround(world);
    const car = world.createCar();
    const rows = [];
    for (let tick = 0; tick < 240; tick += 1) {
      const throttle = tick < 120 ? 1 : 0.35;
      const steering = tick < 120 ? 0 : 1;
      world.setCarInput(car, { throttle, steering, brake: 0 });
      world.step();
      if (tick % 15 === 0) {
        const state = world.carState(car);
        rows.push({
          tick,
          t: round((tick + 1) * FIXED_DT, 2),
          x: round(state.position.x, 3),
          y: round(state.position.y, 3),
          z: round(state.position.z, 3),
          speedKmh: round(Math.abs(state.speed) * 3.6, 2),
          upY: round(state.up.y, 3),
          rootY: round(state.rootY ?? NaN, 3),
          rayFromY: round(state.rayFromY ?? NaN, 3),
          steerAngle: round(state.steerAngle ?? NaN, 3),
          yawDeg: round((yawFromQuaternion(state.rotation) * 180) / Math.PI, 2),
          wheels: state.wheels.map((wheel) => ({
            contact: wheel.contact ?? null,
            length: round(wheel.suspensionLength ?? NaN, 3),
            hitDistance: round(wheel.hitDistance ?? NaN, 3),
            hitY: round(wheel.hitY ?? NaN, 3),
            load: round(wheel.normalForce ?? NaN, 1),
            long: round(wheel.longitudinalForce ?? NaN, 1),
            lat: round(wheel.lateralForce ?? NaN, 1),
            slip: round(wheel.slipAngle ?? NaN, 3),
            steer: round(wheel.steerAngle ?? NaN, 3),
          })),
        });
      }
    }
    return { rows, dynamics: world.probeDynamics?.() ?? null };
  } finally {
    world.dispose();
  }
}

// ---------------------------------------------------------------------------
// Car: slalom at roughly 30 km/h

export function runCarSlalom(backend) {
  const world = backend.createWorld({ visual: false });
  try {
    addGround(world);
    const car = world.createCar();
    const samples = [];
    for (let tick = 0; tick < 90; tick += 1) {
      world.setCarInput(car, { throttle: 0.5, steering: 0, brake: 0 });
      world.step();
    }
    let previousYaw = yawFromQuaternion(world.carState(car).rotation);
    let maxYawRate = 0;
    let minUpY = 1;
    let peakSpeed = 0;
    let minSpeed = Infinity;
    let minX = 0;
    let maxX = 0;
    const trace = [];

    let tick = 90;
    for (let phase = 0; phase < 6; phase += 1) {
      const steering = phase % 2 === 0 ? 1 : -1;
      for (let step = 0; step < 75; step += 1, tick += 1) {
        world.setCarInput(car, { throttle: 0.35, steering, brake: 0 });
        world.step();
        const state = world.carState(car);
        const yaw = yawFromQuaternion(state.rotation);
        maxYawRate = Math.max(
          maxYawRate,
          (Math.abs(angleDelta(yaw, previousYaw)) / FIXED_DT) * (180 / Math.PI),
        );
        previousYaw = yaw;
        minUpY = Math.min(minUpY, state.up.y);
        peakSpeed = Math.max(peakSpeed, Math.abs(state.speed));
        minSpeed = Math.min(minSpeed, Math.abs(state.speed));
        minX = Math.min(minX, state.position.x);
        maxX = Math.max(maxX, state.position.x);
        samples.push(state.speed);
        if (step % 25 === 0) trace.push(tracePoint(tick, state));
      }
    }
    for (let step = 0; step < 60; step += 1, tick += 1) {
      world.setCarInput(car, { throttle: 0.35, steering: 0, brake: 0 });
      world.step();
      const state = world.carState(car);
      if (step === 59) trace.push(tracePoint(tick, state));
    }
    const final = world.carState(car);
    return {
      name: "car-slalom",
      scriptedTicks: tick,
      entrySpeedKmh: round(Math.abs(samples[0] ?? 0) * 3.6, 2),
      peakSpeedKmh: round(peakSpeed * 3.6, 2),
      minSpeedKmh: round(minSpeed * 3.6, 2),
      finalSpeedKmh: round(Math.abs(final.speed) * 3.6, 2),
      maxYawRateDegPerSec: round(maxYawRate, 1),
      maxRollDegrees: round((Math.acos(clamp(minUpY, -1, 1)) * 180) / Math.PI, 2),
      minUpY: round(minUpY, 4),
      uprightThroughout: minUpY > 0.5,
      lateralRangeM: round(maxX - minX, 2),
      final: poseOf(final),
      trace,
    };
  } finally {
    world.dispose();
  }
}

// ---------------------------------------------------------------------------
// Character: 0.3 m step

export function runCharacterStep(backend) {
  const world = backend.createWorld({ visual: false });
  try {
    addGround(world);
    // Top y = 0.3, front face z = -2, far edge z = -4.
    world.addStaticBox({
      halfExtents: { x: 2, y: 0.15, z: 1 },
      position: { x: 0, y: 0.15, z: -3 },
      friction: 0.9,
    });
    const character = world.createCharacter({ x: 0, y: CHARACTER.spawnY, z: 0 });
    let maxY = CHARACTER.spawnY;
    let hitWallTicks = 0;
    let firstTopTick = null;
    let blockedTicks = 0;
    let lastDebug;
    const trace = [];
    for (let tick = 0; tick < 105; tick += 1) {
      const result = world.characterMove(
        character,
        { x: 0, y: 0, z: -CHARACTER.speed * FIXED_DT },
        FIXED_DT,
      );
      world.step();
      const state = world.characterState(character);
      maxY = Math.max(maxY, state.position.y);
      if (result.hitWall) hitWallTicks += 1;
      if (result.blocked) blockedTicks += 1;
      if (result.debug) lastDebug = result.debug;
      if (firstTopTick === null && state.position.y > 1.1) firstTopTick = tick;
      if (tick % 15 === 0) trace.push(characterTrace(tick, state));
    }
    const final = world.characterState(character);
    return {
      name: "character-step-0.3m",
      ticks: 105,
      startY: CHARACTER.spawnY,
      end: characterPose(final),
      maxY: round(maxY, 4),
      firstTopTick,
      climbedStep: final.position.y > 1.1,
      passedFrontFace: final.position.z < -2.2,
      grounded: final.grounded,
      hitWallTicks,
      blockedTicks,
      trace,
      debug: lastDebug,
    };
  } finally {
    world.dispose();
  }
}

// ---------------------------------------------------------------------------
// Character: 2 m drop

export function runCharacterDrop(backend) {
  const world = backend.createWorld({ visual: false });
  try {
    addGround(world);
    // Platform top y = 2, spans z = -3..3; walk -Z off the edge.
    world.addStaticBox({
      halfExtents: { x: 3, y: 0.5, z: 3 },
      position: { x: 0, y: 1.5, z: 0 },
      friction: 0.9,
    });
    const character = world.createCharacter({ x: 0, y: 2.9, z: -1 });
    let previousY = 2.9;
    let maxDownSpeed = 0;
    let minY = 2.9;
    let leftPlatformTick = null;
    let landedTick = null;
    let airborneTicks = 0;
    const trace = [];
    for (let tick = 0; tick < 180; tick += 1) {
      world.characterMove(
        character,
        { x: 0, y: 0, z: -CHARACTER.speed * FIXED_DT },
        FIXED_DT,
      );
      world.step();
      const state = world.characterState(character);
      const downSpeed = (previousY - state.position.y) / FIXED_DT;
      if (downSpeed > maxDownSpeed) maxDownSpeed = downSpeed;
      previousY = state.position.y;
      minY = Math.min(minY, state.position.y);
      if (!state.grounded) airborneTicks += 1;
      if (leftPlatformTick === null && state.position.y < 2.7) {
        leftPlatformTick = tick;
      }
      if (leftPlatformTick !== null && landedTick === null && state.grounded) {
        landedTick = tick;
      }
      if (tick % 15 === 0) trace.push(characterTrace(tick, state));
    }
    const final = world.characterState(character);
    return {
      name: "character-drop-2m",
      ticks: 180,
      leftPlatformTick,
      landedTick,
      fallTicks:
        leftPlatformTick !== null && landedTick !== null
          ? landedTick - leftPlatformTick
          : null,
      minY: round(minY, 4),
      maxFallSpeedMps: round(maxDownSpeed, 3),
      airborneTicks,
      end: characterPose(final),
      grounded: final.grounded,
      trace,
    };
  } finally {
    world.dispose();
  }
}

// ---------------------------------------------------------------------------
// Character: wall block and slide

export function runCharacterWall(backend) {
  const world = backend.createWorld({ visual: false });
  try {
    addGround(world);
    // Wall face at z = -2.75, top y = 2.
    world.addStaticBox({
      halfExtents: { x: 3, y: 1, z: 0.25 },
      position: { x: 0, y: 1, z: -3 },
      friction: 0.9,
    });
    const character = world.createCharacter({ x: 0, y: CHARACTER.spawnY, z: 0 });
    let hitWallTicks = 0;
    let minZ = 0;
    for (let tick = 0; tick < 60; tick += 1) {
      const result = world.characterMove(
        character,
        { x: 0, y: 0, z: -CHARACTER.speed * FIXED_DT },
        FIXED_DT,
      );
      if (result.hitWall) hitWallTicks += 1;
      world.step();
      minZ = Math.min(minZ, world.characterState(character).position.z);
    }
    const blocked = world.characterState(character);
    const diagonal = CHARACTER.speed * FIXED_DT * Math.SQRT1_2;
    for (let tick = 0; tick < 90; tick += 1) {
      const result = world.characterMove(
        character,
        { x: diagonal, y: 0, z: -diagonal },
        FIXED_DT,
      );
      if (result.hitWall) hitWallTicks += 1;
      world.step();
      minZ = Math.min(minZ, world.characterState(character).position.z);
    }
    const final = world.characterState(character);
    return {
      name: "character-wall-slide",
      ticks: 150,
      blockedPosition: characterPose(blocked),
      final: characterPose(final),
      stoppedAtZ: round(minZ, 3),
      slidAlongX: final.position.x > 0.5,
      hitWallTicks,
      grounded: final.grounded,
    };
  } finally {
    world.dispose();
  }
}

// ---------------------------------------------------------------------------
// Determinism: same inputs, fresh worlds, per-tick observable hash

export function runDeterminism(backend) {
  const first = runDeterminismScript(backend);
  const second = runDeterminismScript(backend);
  let firstDivergence = -1;
  const ticks = Math.min(first.length, second.length);
  for (let tick = 0; tick < ticks; tick += 1) {
    if (first[tick] !== second[tick]) {
      firstDivergence = tick;
      break;
    }
  }
  return {
    name: "determinism",
    ticks,
    identical: firstDivergence === -1 && first.length === second.length,
    firstDivergenceTick: firstDivergence,
    finalHashA: first[first.length - 1] ?? null,
    finalHashB: second[second.length - 1] ?? null,
    hashAt60A: first[59] ?? null,
    hashAt60B: second[59] ?? null,
  };
}

function runDeterminismScript(backend) {
  const world = backend.createWorld({ visual: false });
  try {
    addGround(world);
    world.addStaticBox({
      halfExtents: { x: 1, y: 1, z: 0.25 },
      position: { x: 0, y: 1, z: -8 },
      friction: 0.9,
    });
    const car = world.createCar();
    const character = world.createCharacter({ x: 4, y: CHARACTER.spawnY, z: 0 });
    for (let i = 0; i < 4; i += 1) {
      world.addDynamicBox({
        halfExtents: { x: 0.3, y: 0.3, z: 0.3 },
        position: { x: -3 + i * 1.2, y: 1.2 + i * 0.5, z: 2 },
      });
    }
    const hashes = [];
    for (let tick = 0; tick < 240; tick += 1) {
      const throttle = tick < 120 ? 1 : 0;
      const steering = tick < 60 ? 0 : tick < 120 ? 0.5 : tick < 180 ? -0.5 : 0;
      const brake = tick >= 180 ? 0.4 : 0;
      world.setCarInput(car, { throttle, steering, brake });
      const lateral = tick % 60 < 30 ? 1 : -1;
      const walk = CHARACTER.speed * FIXED_DT;
      world.characterMove(
        character,
        { x: lateral * walk * 0.5, y: 0, z: -walk },
        FIXED_DT,
      );
      world.step();
      hashes.push(world.hashState());
    }
    return hashes;
  } finally {
    world.dispose();
  }
}

// ---------------------------------------------------------------------------
// Benchmark pile: physics step cost and rendered frame cost

export function buildBenchmarkWorld(backend, engine) {
  const world = backend.createWorld({ visual: true, engine });
  world.addStaticBox({
    halfExtents: { x: 30, y: 0.5, z: 30 },
    position: { x: 0, y: -0.5, z: 0 },
    friction: 0.9,
  });
  for (let i = 0; i < BENCH.count; i += 1) {
    const layer = Math.floor(i / 100);
    const x = ((i % 10) - 4.5) * 0.65;
    const z = ((Math.floor(i / 10) % 10) - 4.5) * 0.65;
    const y = 0.3 + layer * 0.62;
    world.addDynamicBox({
      halfExtents: { x: 0.25, y: 0.25, z: 0.25 },
      position: { x, y, z },
      color: layer % 2 === 0 ? "bench-a" : "bench-b",
    });
  }
  world.focusCamera("bench");
  return world;
}

export function measurePhysicsSteps(world) {
  for (let i = 0; i < BENCH.warmupSteps; i += 1) world.stepSync();
  const samples = [];
  const startedAt = performance.now();
  for (let i = 0; i < BENCH.measuredSteps; i += 1) {
    const t0 = performance.now();
    world.stepSync();
    samples.push(performance.now() - t0);
  }
  const elapsed = performance.now() - startedAt;
  const summary = summarize(samples, 4);
  return {
    ...summary,
    totalMs: round(elapsed, 2),
    stepsPerSecond: round((BENCH.measuredSteps / elapsed) * 1000, 1),
    p95PercentOf16_67ms: round(((summary.p95 ?? 0) / 16.67) * 100, 1),
    dynamicBodies: world.dynamicBodyCount(),
  };
}

export async function measureFrames(world) {
  const scene = world.scene;
  const engine = world.engine;
  for (let i = 0; i < BENCH.frameWarmup; i += 1) {
    world.stepSync();
    scene.render();
  }
  const renderMs = [];
  const frameMs = [];
  const deltaMs = [];
  let last = performance.now();
  await new Promise((resolve) => {
    let count = 0;
    const loop = () => {
      const t0 = performance.now();
      frameMs.push(t0 - last);
      deltaMs.push(engine.getDeltaTime());
      engine._drawCalls?.fetchNewFrame?.();
      world.stepSync();
      scene.render();
      renderMs.push(performance.now() - t0);
      last = t0;
      count += 1;
      if (count >= BENCH.frameSamples) resolve();
      else requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  frameMs.splice(0, 5);
  renderMs.splice(0, 5);
  deltaMs.splice(0, 5);
  return {
    width: engine.getRenderWidth(),
    height: engine.getRenderHeight(),
    samples: BENCH.frameSamples - 5,
    frameIntervalMs: summarize(frameMs, 3),
    stepPlusRenderMs: summarize(renderMs, 3),
    engineDeltaMs: summarize(deltaMs, 3),
    drawCalls: engine._drawCalls?.current ?? null,
    activeMeshes: scene.getActiveMeshes().length,
    fpsFromInterval: round(1000 / (summarize(frameMs, 3).mean ?? 1), 1),
  };
}

// ---------------------------------------------------------------------------
// Showcase (visual evidence only, not a measurement)

export function buildShowcase(backend, engine) {
  const world = backend.createWorld({ visual: true, engine });
  addGround(world);
  for (let i = 0; i < 12; i += 1) {
    const angle = (i / 12) * Math.PI * 2;
    const radius = 16;
    const height = 1.2 + (i % 4) * 1.1;
    world.addStaticBox({
      halfExtents: { x: 1.4, y: height, z: 1.4 },
      position: {
        x: Math.cos(angle) * radius,
        y: height,
        z: Math.sin(angle) * radius,
      },
      friction: 0.9,
      color: "slate",
    });
  }
  const car = world.createCar();
  const character = world.createCharacter({ x: 3.2, y: CHARACTER.spawnY, z: 4 });
  for (let tick = 0; tick < 150; tick += 1) {
    const steering = tick < 60 ? 0 : tick < 110 ? 0.45 : -0.35;
    world.setCarInput(car, { throttle: 0.5, steering, brake: 0 });
    world.characterMove(
      character,
      { x: 0, y: 0, z: -CHARACTER.speed * FIXED_DT },
      FIXED_DT,
    );
    world.step();
  }
  world.stepSync();
  world.focusCamera(car);
  return { world, car, character };
}

// ---------------------------------------------------------------------------

function poseOf(state) {
  return {
    x: round(state.position.x, 3),
    y: round(state.position.y, 3),
    z: round(state.position.z, 3),
    yawDeg: round((yawFromQuaternion(state.rotation) * 180) / Math.PI, 2),
    speedKmh: round(Math.abs(state.speed) * 3.6, 2),
  };
}

function characterPose(state) {
  return {
    x: round(state.position.x, 3),
    y: round(state.position.y, 3),
    z: round(state.position.z, 3),
    grounded: state.grounded,
  };
}

function characterTrace(tick, state) {
  return {
    t: round((tick + 1) * FIXED_DT, 2),
    x: round(state.position.x, 2),
    y: round(state.position.y, 3),
    z: round(state.position.z, 2),
    grounded: state.grounded,
  };
}

function isFinitePose(state) {
  const { position, rotation } = state;
  return (
    [
      position.x,
      position.y,
      position.z,
      rotation.x,
      rotation.y,
      rotation.z,
      rotation.w,
    ].every(Number.isFinite) && Number.isFinite(state.speed)
  );
}

// Kept in the module so result consumers can see the exact scripted setup.
export { CAR, CHARACTER };
