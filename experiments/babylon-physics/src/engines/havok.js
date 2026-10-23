/**
 * Havok backend for the physics spike.
 *
 * Babylon's Havok plugin has no raycast vehicle, so the car is a hand-rolled
 * raycast-suspension model: four downward shape queries against the world,
 * a spring/damper at each contact, and longitudinal/lateral tyre forces
 * clamped by the friction circle. That is the same model family as Rapier's
 * built-in raycast vehicle controller, which is the fairest comparison this
 * spike can make without a Havok-native vehicle.
 *
 * The character uses Babylon's `PhysicsCharacterController` (Havok only).
 * The physics engine is created with `useDeltaForWorldStep = false` and a
 * fixed 1/60 timestep, then stepped explicitly so scenarios are deterministic.
 */

import HavokPhysics from "@babylonjs/havok";
import havokWasmUrl from "@babylonjs/havok/lib/esm/HavokPhysics.wasm?url";
import { Scene } from "@babylonjs/core/scene";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import "@babylonjs/core/Physics/physicsEngineComponent";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsShapeBox } from "@babylonjs/core/Physics/v2/physicsShape";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { PhysicsCharacterController } from "@babylonjs/core/Physics/v2/characterController";
import { PhysicsRaycastResult } from "@babylonjs/core/Physics/physicsRaycastResult";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import { CAR, CHARACTER, FIXED_DT } from "../constants.js";
import { hashNumbers } from "../seam.js";
import {
  createScene,
  makeBoxMesh,
  makeCarVisual,
  makeCharacterVisual,
  setCameraBench,
  setCameraFocus,
} from "../render.js";

const GRAVITY = new Vector3(0, -9.81, 0);
const DOWN = new Vector3(0, -1, 0);
const RADIANS = Math.PI / 180;

export async function createHavokBackend() {
  const initStarted = performance.now();
  const havok = await HavokPhysics({ locateFile: () => havokWasmUrl });
  const wasmInitMs = performance.now() - initStarted;
  let worldSerial = 0;

  return {
    kind: "havok",
    version: "1.3.14",
    wasmInitMs,
    createWorld({ visual = false, engine } = {}) {
      worldSerial += 1;
      return new HavokWorld({
        havok,
        engine,
        visual,
        name: `havok-world-${worldSerial}`,
      });
    },
  };
}

class HavokWorld {
  constructor({ havok, engine, visual, name }) {
    this.engine = engine;
    this.visual = visual;
    this.rig = visual ? createScene(engine) : null;
    this.scene = this.rig ? this.rig.scene : new Scene(engine);
    this.camera = this.rig ? this.rig.camera : null;
    this.scene.enablePhysics(GRAVITY.clone(), new HavokPlugin(false, havok));
    const physics = this.scene.getPhysicsEngine();
    physics.setTimeStep(FIXED_DT);
    // Scenarios and the frame benchmark drive `_step` explicitly. Disabling
    // scene-driven stepping keeps render() out of the physics loop.
    this.scene.physicsEnabled = false;
    this.name = name;
    this.cars = [];
    this.characters = [];
    this.dynamicBoxes = [];
    this.staticCount = 0;
    this.disposed = false;
  }

  addStaticBox({ halfExtents, position, friction = 0.6, color = "ground" }) {
    const node = this.visual
      ? makeBoxMesh(
          this.scene,
          `${this.name}-static-${this.staticCount}`,
          halfExtents,
          color,
        )
      : new TransformNode(`${this.name}-static-${this.staticCount}`, this.scene);
    node.position.set(position.x, position.y, position.z);
    const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, this.scene);
    const shape = new PhysicsShapeBox(
      Vector3.Zero(),
      Quaternion.Identity(),
      fullExtents(halfExtents),
      this.scene,
    );
    shape.material = { friction, restitution: 0 };
    body.shape = shape;
    this.staticCount += 1;
    return node;
  }

  addDynamicBox({ halfExtents, position, color = "slate" }) {
    const index = this.dynamicBoxes.length;
    const node = this.visual
      ? makeBoxMesh(this.scene, `${this.name}-box-${index}`, halfExtents, color)
      : new TransformNode(`${this.name}-box-${index}`, this.scene);
    node.position.set(position.x, position.y, position.z);
    node.rotationQuaternion = Quaternion.Identity();
    const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, false, this.scene);
    const shape = new PhysicsShapeBox(
      Vector3.Zero(),
      Quaternion.Identity(),
      fullExtents(halfExtents),
      this.scene,
    );
    shape.material = { friction: 0.55, restitution: 0.03 };
    body.shape = shape;
    const mass = 10;
    body.setMassProperties({
      mass,
      inertia: unitInertia(halfExtents),
      centerOfMass: Vector3.Zero(),
    });
    body.setLinearDamping(0.01);
    body.setAngularDamping(0.05);
    this.dynamicBoxes.push({ node, body });
    return { node, body };
  }

  createCar() {
    const visual = this.visual ? makeCarVisual(this.scene) : null;
    const root = visual ? visual.root : new TransformNode(`${this.name}-car`, this.scene);
    root.position.set(CAR.spawn.x, CAR.spawn.y, CAR.spawn.z);
    root.rotationQuaternion = Quaternion.Identity();
    const body = new PhysicsBody(root, PhysicsMotionType.DYNAMIC, false, this.scene);
    const shape = new PhysicsShapeBox(
      Vector3.Zero(),
      Quaternion.Identity(),
      fullExtents(CAR.halfExtents),
      this.scene,
    );
    // The chassis should not act as a second set of tyres when it bottoms out.
    shape.material = { friction: 0.2, restitution: 0 };
    body.shape = shape;
    body.setMassProperties({
      mass: CAR.mass,
      inertia: unitInertia(CAR.halfExtents),
      centerOfMass: Vector3.Zero(),
    });
    body.setLinearDamping(0.02);
    body.setAngularDamping(0.2);

    const car = {
      id: this.cars.length,
      root,
      visual,
      body,
      input: { throttle: 0, steering: 0, brake: 0 },
      steerAngle: 0,
      speed: 0,
      wheels: CAR.wheels.map((desc, index) => ({
        desc,
        state: {
          contact: false,
          contactPoint: { x: 0, y: 0, z: 0 },
          contactNormal: { x: 0, y: 1, z: 0 },
          suspensionLength: desc.suspensionRestLength,
          rotation: 0,
          steerAngle: 0,
          slipRatio: 0,
          slipAngle: 0,
          hitDistance: 0,
          hitY: 0,
          normalForce: 0,
          longitudinalForce: 0,
          lateralForce: 0,
        },
        mesh: visual ? visual.wheels[index] : null,
        previousLength: desc.suspensionRestLength,
      })),
      linearVelocity: new Vector3(),
      angularVelocity: new Vector3(),
      forward: new Vector3(),
      right: new Vector3(),
      down: new Vector3(),
      rayFrom: new Vector3(),
      rayTo: new Vector3(),
      force: new Vector3(),
      rayResult: new PhysicsRaycastResult(),
      wheelCount: CAR.wheels.length,
      drivenCount: CAR.wheels.filter((wheel) => wheel.driven).length || 1,
    };
    this.cars.push(car);
    this.syncCarVisual(car);
    return car;
  }

  setCarInput(car, input) {
    car.input.throttle = clamp(input.throttle ?? 0, -1, 1);
    car.input.steering = clamp(input.steering ?? 0, -1, 1);
    car.input.brake = clamp(input.brake ?? 0, 0, 1);
  }

  carState(car) {
    const q = car.root.rotationQuaternion ?? Quaternion.Identity();
    const up = { x: 0, y: 1, z: 0 };
    rotateByQuaternion(up, q, up);
    return {
      position: { x: car.root.position.x, y: car.root.position.y, z: car.root.position.z },
      rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
      up,
      rootY: car.root.position.y,
      rayFromY: car.rayFrom.y,
      steerAngle: car.steerAngle,
      speed: car.speed,
      wheels: car.wheels.map((wheel) => ({
        ...wheel.state,
        contactPoint: { ...wheel.state.contactPoint },
        contactNormal: { ...wheel.state.contactNormal },
      })),
    };
  }

  createCharacter(position) {
    const controller = new PhysicsCharacterController(
      new Vector3(position.x, position.y, position.z),
      {
        capsuleRadius: CHARACTER.radius,
        capsuleHeight: 2 * (CHARACTER.halfHeight + CHARACTER.radius),
        characterMass: CHARACTER.mass,
      },
      this.scene,
    );
    controller.maxSlopeCosine = Math.cos(CHARACTER.slopeLimitDegrees * RADIANS);
    controller.maxStepHeight = CHARACTER.stepOffset;
    // Measured limitation: with the default keepDistance (0.05 m) the step-up
    // sweep shortens its forward probe by more than one 60 Hz tick at walking
    // speed (2 / 60 = 0.0333 m), so `_tryStepUp` clamps the adjusted fraction to
    // zero and returns -1. Lowering keepDistance lets the three casts run, but
    // the down cast then misses the step's top edge. See README "API gaps".
    // Diagnostics only: `?probe=1` records whether the controller's private
    // step-up sweep ran and what it returned. Not on the normal path.
    let lastStepUp = null;
    const casts = [];
    if (globalThis.__PHYSICS_DEBUG__ === true) {
      const original = controller._tryStepUp.bind(controller);
      controller._tryStepUp = (...args) => {
        casts.length = 0;
        lastStepUp = original(...args);
        return lastStepUp;
      };
      const originalCast = controller._castWithCollectors.bind(controller);
      controller._castWithCollectors = (start, end, castCollector, startCollector) => {
        originalCast(start, end, castCollector, startCollector);
        const hit = controller._getClosestCastHit();
        if (casts.length < 8) {
          casts.push({
            start: [start.x, start.y, start.z],
            end: [end.x, end.y, end.z],
            hit:
              hit === null
                ? null
                : {
                    fraction: hit.fraction,
                    normal: hit.normal.asArray(),
                    motionType: hit.body?.body.getMotionType(hit.body.index),
                  },
          });
        }
      };
    }
    const character = {
      id: this.characters.length,
      controller,
      mesh: this.visual ? makeCharacterVisual(this.scene) : null,
      verticalVelocity: 0,
      grounded: false,
      velocity: new Vector3(),
      debug() {
        return {
          maxStepHeight: controller.maxStepHeight,
          lastStepUp,
          casts: casts.slice(),
          position: controller.getPosition().asArray(),
          velocity: controller.getVelocity().asArray(),
          lastDisplacement: controller._lastDisplacement.asArray(),
          manifold: controller._manifold.map((contact) => ({
            y: contact.position.y,
            normal: contact.normal.asArray(),
            distance: contact.distance,
          })),
        };
      },
    };
    if (character.mesh) {
      const at = controller.getPosition();
      character.mesh.position.set(at.x, at.y, at.z);
    }
    this.characters.push(character);
    return character;
  }

  characterMove(character, desired, dt) {
    const controller = character.controller;
    const before = controller.getPosition();
    const beforeX = before.x;
    const beforeY = before.y;
    const beforeZ = before.z;
    const surface = controller.checkSupport(dt, DOWN);
    const grounded = surface.supportedState === 2;
    if (grounded && character.verticalVelocity <= 0) {
      // A small downward probe keeps the controller glued to the ground; the
      // bake-off uses the same -1 m/s probe with this controller.
      character.verticalVelocity = -1;
    } else {
      character.verticalVelocity -= CHARACTER.gravity * dt;
    }
    character.velocity.set(
      desired.x / dt,
      character.verticalVelocity + desired.y / dt,
      desired.z / dt,
    );
    controller.setVelocity(character.velocity);
    controller.integrate(dt, surface, GRAVITY);
    const after = controller.getPosition();
    const moved = {
      x: after.x - beforeX,
      y: after.y - beforeY,
      z: after.z - beforeZ,
    };
    const requested = Math.hypot(desired.x, desired.z);
    const actual = Math.hypot(moved.x, moved.z);
    const blocked = requested > 1e-6 && actual < requested * 0.5;
    character.grounded = grounded;
    if (character.mesh) {
      character.mesh.position.set(after.x, after.y, after.z);
    }
    return {
      moved,
      grounded,
      hitWall: blocked,
      hitCeiling: false,
      blocked,
      slidCount: blocked ? 1 : 0,
      debug:
        globalThis.__PHYSICS_DEBUG__ === true ? character.debug() : undefined,
    };
  }

  characterState(character) {
    const at = character.controller.getPosition();
    return {
      position: { x: at.x, y: at.y, z: at.z },
      grounded: character.grounded,
    };
  }

  step() {
    const physics = this.scene.getPhysicsEngine();
    for (let i = 0; i < this.cars.length; i += 1) {
      this.applyCarControls(this.cars[i], physics);
    }
    physics._step(FIXED_DT);
    for (let i = 0; i < this.cars.length; i += 1) {
      this.refreshCarTelemetry(this.cars[i]);
    }
  }

  stepSync() {
    this.step();
    this.syncVisuals();
  }

  syncVisuals() {
    for (let i = 0; i < this.cars.length; i += 1) this.syncCarVisual(this.cars[i]);
    for (let i = 0; i < this.characters.length; i += 1) {
      const character = this.characters[i];
      if (!character.mesh) continue;
      const at = character.controller.getPosition();
      character.mesh.position.set(at.x, at.y, at.z);
    }
  }

  hashState() {
    const values = [];
    for (let i = 0; i < this.cars.length; i += 1) {
      const car = this.cars[i];
      const q = car.root.rotationQuaternion;
      values.push(
        car.root.position.x,
        car.root.position.y,
        car.root.position.z,
        q.x,
        q.y,
        q.z,
        q.w,
        car.speed,
      );
    }
    for (let i = 0; i < this.characters.length; i += 1) {
      const at = this.characters[i].controller.getPosition();
      values.push(at.x, at.y, at.z);
    }
    for (let i = 0; i < this.dynamicBoxes.length; i += 1) {
      const { node } = this.dynamicBoxes[i];
      const q = node.rotationQuaternion;
      values.push(
        node.position.x,
        node.position.y,
        node.position.z,
        q.x,
        q.y,
        q.z,
        q.w,
      );
    }
    return hashNumbers(values);
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
    for (const character of this.characters) {
      character.controller.dispose();
    }
    this.characters.length = 0;
    this.cars.length = 0;
    this.dynamicBoxes.length = 0;
    this.scene.dispose();
  }

  /**
   * Diagnostic only: checks whether Havok applies angular impulses and whether
   * an off-centre force produces the expected torque. Called by ?probe=1.
   */
  probeDynamics() {
    const run = (mode) => {
      const node = new TransformNode(`${this.name}-probe-${mode}`, this.scene);
      node.position.set(0, 50, 0);
      node.rotationQuaternion = Quaternion.Identity();
      const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, false, this.scene);
      const shape = new PhysicsShapeBox(
        Vector3.Zero(),
        Quaternion.Identity(),
        new Vector3(2, 1, 4),
        this.scene,
      );
      body.shape = shape;
      body.setMassProperties({
        mass: 1000,
        inertia: new Vector3(5 / 3, 5 / 3, 1 / 3),
        centerOfMass: Vector3.Zero(),
      });
      body.setLinearDamping(0);
      body.setAngularDamping(0);
      const angular = new Vector3();
      for (let i = 0; i < 60; i += 1) {
        if (mode === "torque") {
          body.applyTorque(new Vector3(0, 2000, 0));
        } else {
          body.applyForce(
            new Vector3(1000, 0, 0),
            new Vector3(0, 50, -1.3),
          );
        }
        this.scene.getPhysicsEngine()._step(FIXED_DT);
      }
      body.getAngularVelocityToRef(angular);
      const result = {
        mode,
        angularVelocity: { x: angular.x, y: angular.y, z: angular.z },
        rotationY: node.rotationQuaternion?.y ?? null,
      };
      body.dispose();
      node.dispose();
      return result;
    };
    return { torque: run("torque"), force: run("force") };
  }

  // -- Car internals --------------------------------------------------------

  applyCarControls(car, physics) {
    const body = car.body;
    const root = car.root;
    const q = root.rotationQuaternion;
    const position = root.position;
    body.getLinearVelocityToRef(car.linearVelocity);
    body.getAngularVelocityToRef(car.angularVelocity);
    const linear = car.linearVelocity;
    const angular = car.angularVelocity;

    rotateByQuaternion({ x: 0, y: 0, z: -1 }, q, car.forward);
    rotateByQuaternion({ x: 1, y: 0, z: 0 }, q, car.right);
    rotateByQuaternion({ x: 0, y: -1, z: 0 }, q, car.down);

    const speed =
      linear.x * car.forward.x +
      linear.y * car.forward.y +
      linear.z * car.forward.z;
    car.speed = speed;

    const maxSteerRad = CAR.maxSteerDegrees * RADIANS;
    const targetSteer = car.input.steering * maxSteerRad;
    const maxDelta = CAR.steerRateDegreesPerSecond * RADIANS * FIXED_DT;
    car.steerAngle += clamp(targetSteer - car.steerAngle, -maxDelta, maxDelta);

    let engineForce = 0;
    let brakeForce = car.input.brake;
    if (car.input.throttle > 0) {
      if (speed < -0.5) {
        brakeForce = Math.max(brakeForce, car.input.throttle);
      } else {
        const falloff = Math.max(0, 1 - Math.max(0, speed) / CAR.topSpeed);
        engineForce = CAR.engineForce * car.input.throttle * falloff;
      }
    } else if (car.input.throttle < 0) {
      if (speed > 0.5) {
        brakeForce = Math.max(brakeForce, -car.input.throttle);
      } else {
        engineForce = CAR.reverseForce * car.input.throttle;
      }
    }
    const brakeTotal = CAR.brakeForce * brakeForce;

    for (let i = 0; i < car.wheelCount; i += 1) {
      const wheel = car.wheels[i];
      const desc = wheel.desc;
      const mount = desc.localPosition;
      const originY = -(CAR.halfExtents.y + 0.05);
      const shift = mount.y - originY;
      const rayLength = Math.max(
        0.05,
        desc.suspensionRestLength + desc.maxTravel + desc.radius - shift,
      );

      setRotatedPoint(car.rayFrom, mount.x, originY, mount.z, q, position);
      car.rayTo.set(
        car.rayFrom.x + car.down.x * rayLength,
        car.rayFrom.y + car.down.y * rayLength,
        car.rayFrom.z + car.down.z * rayLength,
      );
      physics.raycastToRef(car.rayFrom, car.rayTo, car.rayResult);

      if (!car.rayResult.hasHit) {
        wheel.state.contact = false;
        wheel.state.suspensionLength =
          desc.suspensionRestLength + desc.maxTravel;
        wheel.state.normalForce = 0;
        wheel.previousLength = wheel.state.suspensionLength;
        continue;
      }

      const hit = car.rayResult.hitPointWorld;
      const normal = car.rayResult.hitNormalWorld;
      const normalLength = Math.hypot(normal.x, normal.y, normal.z) || 1;
      const nx = normal.x / normalLength;
      const ny = normal.y / normalLength;
      const nz = normal.z / normalLength;

      const mountToGround = shift + car.rayResult.hitDistance;
      const suspensionLength = clamp(
        mountToGround - desc.radius,
        0,
        desc.suspensionRestLength + desc.maxTravel,
      );
      const compression = Math.max(0, desc.suspensionRestLength - suspensionLength);
      const compressionRate =
        (wheel.previousLength - suspensionLength) / FIXED_DT;
      const load = Math.max(
        0,
        desc.suspensionStiffness * compression +
          desc.suspensionDamping * compressionRate,
      );
      wheel.previousLength = suspensionLength;
      wheel.state.contact = true;
      wheel.state.suspensionLength = suspensionLength;
      wheel.state.hitDistance = car.rayResult.hitDistance;
      wheel.state.hitY = hit.y;
      wheel.state.normalForce = load;
      wheel.state.contactPoint.x = hit.x;
      wheel.state.contactPoint.y = hit.y;
      wheel.state.contactPoint.z = hit.z;
      wheel.state.contactNormal.x = nx;
      wheel.state.contactNormal.y = ny;
      wheel.state.contactNormal.z = nz;

      const rx = hit.x - position.x;
      const ry = hit.y - position.y;
      const rz = hit.z - position.z;
      const vx = linear.x + angular.y * rz - angular.z * ry;
      const vy = linear.y + angular.z * rx - angular.x * rz;
      const vz = linear.z + angular.x * ry - angular.y * rx;

      const steer = desc.steerable ? car.steerAngle : 0;
      wheel.state.steerAngle = steer;
      const cosSteer = Math.cos(steer);
      const sinSteer = Math.sin(steer);
      let fx = car.forward.x * cosSteer + car.right.x * sinSteer;
      let fy = car.forward.y * cosSteer + car.right.y * sinSteer;
      let fz = car.forward.z * cosSteer + car.right.z * sinSteer;
      const forwardNormal = fx * nx + fy * ny + fz * nz;
      fx -= nx * forwardNormal;
      fy -= ny * forwardNormal;
      fz -= nz * forwardNormal;
      const forwardLength = Math.hypot(fx, fy, fz) || 1;
      fx /= forwardLength;
      fy /= forwardLength;
      fz /= forwardLength;

      let sx = car.right.x * cosSteer - car.forward.x * sinSteer;
      let sy = car.right.y * cosSteer - car.forward.y * sinSteer;
      let sz = car.right.z * cosSteer - car.forward.z * sinSteer;
      const sideNormal = sx * nx + sy * ny + sz * nz;
      sx -= nx * sideNormal;
      sy -= ny * sideNormal;
      sz -= nz * sideNormal;
      const sideLength = Math.hypot(sx, sy, sz) || 1;
      sx /= sideLength;
      sy /= sideLength;
      sz /= sideLength;

      const velocityLong = vx * fx + vy * fy + vz * fz;
      const velocityLat = vx * sx + vy * sy + vz * sz;
      const slipAngle = Math.atan2(
        velocityLat,
        Math.max(Math.abs(velocityLong), 0.5),
      );
      const maxGrip = desc.friction * load;

      let longitudinal = desc.driven
        ? engineForce / car.drivenCount
        : 0;
      if (brakeForce > 0 && Math.abs(velocityLong) > 0.3) {
        longitudinal -=
          Math.sign(velocityLong) * (brakeTotal / car.wheelCount);
      }
      if (Math.abs(velocityLong) > 0.05) {
        longitudinal -= Math.sign(velocityLong) * 0.015 * load;
      }
      longitudinal = clamp(longitudinal, -maxGrip, maxGrip);
      const lateral = clamp(-slipAngle * 8 * load, -maxGrip, maxGrip);

      wheel.state.slipAngle = slipAngle;
      wheel.state.longitudinalForce = longitudinal;
      wheel.state.lateralForce = lateral;

      car.force.set(
        nx * load + fx * longitudinal + sx * lateral,
        ny * load + fy * longitudinal + sy * lateral,
        nz * load + fz * longitudinal + sz * lateral,
      );
      body.applyForce(car.force, hit);
    }
  }

  refreshCarTelemetry(car) {
    car.body.getLinearVelocityToRef(car.linearVelocity);
    const q = car.root.rotationQuaternion;
    rotateByQuaternion({ x: 0, y: 0, z: -1 }, q, car.forward);
    car.speed =
      car.linearVelocity.x * car.forward.x +
      car.linearVelocity.y * car.forward.y +
      car.linearVelocity.z * car.forward.z;
  }

  syncCarVisual(car) {
    if (!car.visual) return;
    for (let i = 0; i < car.wheels.length; i += 1) {
      const wheel = car.wheels[i];
      if (!wheel.mesh) continue;
      wheel.mesh.position.x = wheel.desc.localPosition.x;
      wheel.mesh.position.y = wheel.desc.localPosition.y - wheel.state.suspensionLength;
      wheel.mesh.position.z = wheel.desc.localPosition.z;
    }
  }
}

// Babylon's PhysicsShapeBox `extents` argument is the full box size, while the
// shared descriptors (and the Rapier contract) carry half extents.
function fullExtents(halfExtents) {
  return new Vector3(halfExtents.x * 2, halfExtents.y * 2, halfExtents.z * 2);
}

// Babylon's PhysicsMassProperties.inertia is "principal moments of inertia for
// a unit mass" (IPhysicsEnginePlugin.d.ts), i.e. I / m. Passing kg*m^2 here
// multiplies the effective inertia by the body mass and stops the car turning.
function unitInertia(halfExtents) {
  const { x: hx, y: hy, z: hz } = halfExtents;
  return new Vector3(
    (hy * hy + hz * hz) / 3,
    (hx * hx + hz * hz) / 3,
    (hx * hx + hy * hy) / 3,
  );
}

function rotateByQuaternion(vector, quaternion, out) {
  const { x: qx, y: qy, z: qz, w: qw } = quaternion;
  const { x, y, z } = vector;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

function setRotatedPoint(out, x, y, z, quaternion, position) {
  rotateByQuaternion({ x, y, z }, quaternion, out);
  out.x += position.x;
  out.y += position.y;
  out.z += position.z;
  return out;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
