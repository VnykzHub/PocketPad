/**
 * Rapier backend for the physics spike.
 *
 * Unlike the Havok side, this does not hand-roll a vehicle: it drives the
 * existing `@lanpad/engine-physics` adapter (`RapierPhysics3D`), which is the
 * code the engine would actually ship. The car is Rapier's raycast vehicle
 * controller behind `createVehicle`; the character is the adapter's
 * `CharacterController`. Pooled adapter state is copied into fresh objects at
 * the seam so scenario code never aliases reused arrays.
 *
 * The adapter binds to the engine-core scene, not Babylon. This file performs
 * the Babylon transform copy itself, which is the same job the runtime bridge
 * (`packages/runtime/src/physics3d`) does for the host.
 */

import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import {
  createRapierWorld,
  initRapierPhysics,
} from "@lanpad/engine-physics";

import { CAR, CHARACTER, FIXED_DT } from "../constants.js";
import { rotateVector } from "../seam.js";
import {
  createScene,
  makeBoxMesh,
  makeCarVisual,
  makeCharacterVisual,
  setCameraBench,
  setCameraFocus,
} from "../render.js";

const GRAVITY = Object.freeze({ x: 0, y: -9.81, z: 0 });

export async function createRapierBackend() {
  const initStarted = performance.now();
  await initRapierPhysics();
  const wasmInitMs = performance.now() - initStarted;
  let worldSerial = 0;

  return {
    kind: "rapier",
    version: "0.21.0",
    wasmInitMs,
    createWorld({ visual = false, engine } = {}) {
      worldSerial += 1;
      return new RapierWorld({
        engine,
        visual,
        name: `rapier-world-${worldSerial}`,
      });
    },
  };
}

class RapierWorld {
  constructor({ engine, visual, name }) {
    this.engine = engine;
    this.visual = visual;
    this.rig = visual ? createScene(engine) : null;
    this.scene = this.rig ? this.rig.scene : null;
    this.camera = this.rig ? this.rig.camera : null;
    this.name = name;
    this.world = createRapierWorld({ gravity: GRAVITY, fixedDt: FIXED_DT });
    this.cars = [];
    this.characters = [];
    this.dynamicBoxes = [];
    this.staticCount = 0;
    this.disposed = false;
    this.bodyState = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      linearVelocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      sleeping: false,
      enabled: true,
      mass: 0,
      userData: 0,
    };
    this.vehicleOut = {
      wheelCount: 0,
      speed: 0,
      forward: { x: 0, y: 0, z: -1 },
      wheels: [],
    };
  }

  addStaticBox({ halfExtents, position, friction = 0.6, color = "ground" }) {
    const node = this.visual
      ? makeBoxMesh(
          this.scene,
          `${this.name}-static-${this.staticCount}`,
          halfExtents,
          color,
        )
      : null;
    if (node) node.position.set(position.x, position.y, position.z);
    const body = this.world.createBody({
      type: "static",
      position,
    });
    this.world.createCollider(body, {
      shape: { kind: "box", halfExtents },
      friction,
      restitution: 0,
    });
    this.staticCount += 1;
    return node;
  }

  addDynamicBox({ halfExtents, position, color = "slate" }) {
    const index = this.dynamicBoxes.length;
    const node = this.visual
      ? makeBoxMesh(this.scene, `${this.name}-box-${index}`, halfExtents, color)
      : null;
    if (node) {
      node.position.set(position.x, position.y, position.z);
      node.rotationQuaternion = Quaternion.Identity();
    }
    const body = this.world.createBody({
      type: "dynamic",
      position,
      mass: 10,
      linearDamping: 0.01,
      angularDamping: 0.05,
    });
    this.world.createCollider(body, {
      shape: { kind: "box", halfExtents },
      friction: 0.55,
      restitution: 0.03,
    });
    const record = { node, body };
    this.dynamicBoxes.push(record);
    return record;
  }

  createCar() {
    const visual = this.visual ? makeCarVisual(this.scene) : null;
    // Non-visual worlds have no Babylon scene; the pose lives in the adapter
    // body and `carState` reads it from there, so no node is needed.
    const root = visual ? visual.root : null;
    if (root) {
      root.position.set(CAR.spawn.x, CAR.spawn.y, CAR.spawn.z);
      root.rotationQuaternion = Quaternion.Identity();
    }
    const body = this.world.createBody({
      type: "dynamic",
      position: CAR.spawn,
      mass: CAR.mass,
      linearDamping: 0.02,
      angularDamping: 0.2,
      canSleep: false,
    });
    this.world.createCollider(body, {
      shape: { kind: "box", halfExtents: CAR.halfExtents },
      friction: 0.2,
      restitution: 0,
    });
    const vehicle = this.world.createVehicle({
      chassis: body,
      wheels: CAR.wheels,
      engineForce: CAR.engineForce,
      reverseForce: CAR.reverseForce,
      brakeForce: CAR.brakeForce,
      maxSteerDegrees: CAR.maxSteerDegrees,
      steerRateDegreesPerSecond: CAR.steerRateDegreesPerSecond,
      topSpeed: CAR.topSpeed,
    });
    const car = {
      root,
      visual,
      body,
      vehicle,
      input: { throttle: 0, steering: 0, brake: 0 },
    };
    this.cars.push(car);
    this.syncCarVisual(car);
    return car;
  }

  setCarInput(car, input) {
    car.input.throttle = clamp(input.throttle ?? 0, -1, 1);
    car.input.steering = clamp(input.steering ?? 0, -1, 1);
    car.input.brake = clamp(input.brake ?? 0, 0, 1);
    this.world.setVehicleInput(car.vehicle, car.input);
  }

  carState(car) {
    this.world.readBody(car.body, this.bodyState);
    this.world.readVehicle(car.vehicle, this.vehicleOut);
    const q = this.bodyState.rotation;
    const up = rotateVector(q, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 });
    return {
      position: {
        x: this.bodyState.position.x,
        y: this.bodyState.position.y,
        z: this.bodyState.position.z,
      },
      rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
      up,
      speed: this.vehicleOut.speed,
      wheels: this.vehicleOut.wheels.map((wheel) => ({
        ...wheel,
        contactPoint: { ...wheel.contactPoint },
        contactNormal: { ...wheel.contactNormal },
      })),
    };
  }

  createCharacter(position) {
    const controller = this.world.createCharacter({
      radius: CHARACTER.radius,
      halfHeight: CHARACTER.halfHeight,
      position,
      slopeLimitDegrees: CHARACTER.slopeLimitDegrees,
      stepOffset: CHARACTER.stepOffset,
      snapToGround: CHARACTER.snapToGround,
      gravity: CHARACTER.gravity,
      mass: CHARACTER.mass,
    });
    const character = {
      controller,
      mesh: this.visual ? makeCharacterVisual(this.scene) : null,
    };
    if (character.mesh) {
      character.mesh.position.set(position.x, position.y, position.z);
    }
    this.characters.push(character);
    return character;
  }

  characterMove(character, desired, dt) {
    const result = character.controller.move(desired, dt);
    return {
      moved: { x: result.moved.x, y: result.moved.y, z: result.moved.z },
      grounded: result.grounded,
      hitWall: result.hitWall,
      hitCeiling: result.hitCeiling,
      blocked: result.hitWall,
      slidCount: result.slidCount,
    };
  }

  characterState(character) {
    this.world.readBody(character.controller.body, this.bodyState);
    return {
      position: {
        x: this.bodyState.position.x,
        y: this.bodyState.position.y,
        z: this.bodyState.position.z,
      },
      grounded: character.controller.isGrounded(),
    };
  }

  step() {
    this.world.step(FIXED_DT);
  }

  stepSync() {
    this.step();
    this.syncVisuals();
  }

  syncVisuals() {
    if (!this.rig) return;
    for (let i = 0; i < this.cars.length; i += 1) this.syncCarVisual(this.cars[i]);
    for (let i = 0; i < this.characters.length; i += 1) {
      const character = this.characters[i];
      if (!character.mesh) continue;
      this.world.readBody(character.controller.body, this.bodyState);
      character.mesh.position.set(
        this.bodyState.position.x,
        this.bodyState.position.y,
        this.bodyState.position.z,
      );
    }
  }

  hashState() {
    const hash = this.world.stateHash() >>> 0;
    return hash.toString(16).padStart(8, "0");
  }

  dynamicBodyCount() {
    return this.dynamicBoxes.length + this.cars.length;
  }

  focusCamera(target) {
    if (!this.camera) return;
    if (target === "bench") {
      setCameraBench(this.camera);
    } else {
      setCameraFocus(this.camera, target.root.position);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cars.length = 0;
    this.characters.length = 0;
    this.dynamicBoxes.length = 0;
    this.world.dispose();
    if (this.rig) this.rig.scene.dispose();
  }

  syncCarVisual(car) {
    if (!car.visual) return;
    this.world.readBody(car.body, this.bodyState);
    const position = this.bodyState.position;
    const rotation = this.bodyState.rotation;
    car.root.position.set(position.x, position.y, position.z);
    if (!car.root.rotationQuaternion) {
      car.root.rotationQuaternion = Quaternion.Identity();
    }
    car.root.rotationQuaternion.set(
      rotation.x,
      rotation.y,
      rotation.z,
      rotation.w,
    );
    this.world.readVehicle(car.vehicle, this.vehicleOut);
    for (let i = 0; i < car.visual.wheels.length; i += 1) {
      const mesh = car.visual.wheels[i];
      const wheel = CAR.wheels[i];
      const state = this.vehicleOut.wheels[i];
      mesh.position.x = wheel.localPosition.x;
      mesh.position.y = wheel.localPosition.y - (state?.suspensionLength ?? 0);
      mesh.position.z = wheel.localPosition.z;
      mesh.rotation.y = state?.steerAngle ?? 0;
    }
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
