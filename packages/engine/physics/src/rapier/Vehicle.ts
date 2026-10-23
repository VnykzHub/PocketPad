/**
 * Rapier ray-cast vehicle behind `VehicleHandle` (07 §3.6).
 *
 * With the wheel axes configured below (down for the suspension, +X for the
 * axle), Rapier's positive engine force rolls the chassis along its local -Z,
 * which is the engine convention. Positive engine steering is right; Rapier's
 * positive wheel yaw turns left, so steering is inverted at this boundary.
 * `VehicleState.speed` is the chassis velocity projected on the local -Z
 * forward axis: Rapier's `currentVehicleSpeed()` reports the velocity
 * *magnitude* with a sign taken from its configured forward axis, which is
 * not a longitudinal speed and must not drive throttle/brake decisions.
 * Wheel state is pooled per vehicle and reused by `readVehicle`.
 */
import type { Quat, Vec3 } from "@lanpad/engine-core";
import type {
  VehicleDesc,
  VehicleHandle,
  VehicleInput,
  VehicleState,
  WheelDesc,
  WheelState,
} from "../contracts/physics3d.js";
import type * as RAPIER from "@dimforge/rapier3d-compat";
import type { RapierPhysics3D } from "./RapierPhysics3D.js";
import {
  copyVec3,
  isFiniteNumber,
  isFiniteVec3,
  quatRotate,
  vec3,
} from "./internal.js";

/** Positive engine force drives along -Z; no longitudinal inversion. */
const ENGINE_SIGN = 1;
/** Positive engine steering is right; Rapier's positive yaw is left. */
const STEER_SIGN = -1;
const DEG_TO_RAD = Math.PI / 180;

export class RapierVehicle {
  active = true;
  readonly handle: VehicleHandle;
  readonly chassisIndex: number;
  readonly controller: RAPIER.DynamicRayCastVehicleController;
  readonly wheels: readonly WheelDesc[];
  readonly wheelCount: number;
  readonly engineForce: number;
  readonly reverseForce: number;
  readonly brakeForce: number;
  readonly maxSteerRad: number;
  readonly steerRateRad: number;
  readonly topSpeed: number;
  readonly downforce: number;
  readonly drivenCount: number;
  readonly state: VehicleState;

  private steerAngle = 0;
  private throttle = 0;
  private steering = 0;
  private brake = 0;
  private handbrake = 0;
  private lastDt = 1 / 60;
  private readonly downforceVector: Vec3 = vec3();
  private readonly forwardLocal: Vec3 = vec3(0, 0, -1);
  private readonly chassisRotation: Quat = { x: 0, y: 0, z: 0, w: 1 };

  constructor(
    host: RapierPhysics3D,
    chassis: RAPIER.RigidBody,
    chassisMass: number,
    chassisIndex: number,
    desc: VehicleDesc,
    handle: VehicleHandle,
  ) {
    this.handle = handle;
    this.chassisIndex = chassisIndex;
    this.wheels = desc.wheels;
    this.wheelCount = desc.wheels.length;
    this.engineForce = desc.engineForce;
    this.reverseForce = desc.reverseForce;
    this.brakeForce = desc.brakeForce;
    this.maxSteerRad =
      Math.max(5, Math.min(60, desc.maxSteerDegrees ?? 35)) * DEG_TO_RAD;
    this.steerRateRad =
      (desc.steerRateDegreesPerSecond ?? 180) * DEG_TO_RAD;
    this.topSpeed = desc.topSpeed;
    this.downforce = desc.downforce ?? 0;

    this.controller = host._rapierWorld().createVehicleController(chassis);
    // Rapier's default forward axis is local +X, while the engine's forward
    // is local -Z (02 §3.1) and Rapier accepts only a positive axis. Select
    // +Z so the controller's internal forward, used for wheel-rotation
    // direction, matches the chassis; telemetry speed is projected from the
    // chassis velocity below instead of using that per-axis sign.
    this.controller.setIndexForwardAxis = 2;
    // Rapier's suspension force is (k * compression - c * velocity) * mass,
    // so its stiffness and damping are mass-normalised (1/s^2, 1/s). The
    // contract carries physical N/m and N*s/m, so divide by chassis mass.
    const massScale = chassisMass > 0 ? 1 / chassisMass : 0;
    let driven = 0;

    for (let i = 0; i < this.wheelCount; i += 1) {
      const wheel = desc.wheels[i]!;
      this.controller.addWheel(
        wheel.localPosition,
        vec3(0, -1, 0),
        vec3(1, 0, 0),
        wheel.suspensionRestLength,
        wheel.radius,
      );
      this.controller.setWheelMaxSuspensionTravel(i, wheel.maxTravel);
      this.controller.setWheelSuspensionStiffness(
        i,
        wheel.suspensionStiffness * massScale,
      );
      const damping = wheel.suspensionDamping * massScale;
      this.controller.setWheelSuspensionCompression(i, damping);
      this.controller.setWheelSuspensionRelaxation(i, damping);
      this.controller.setWheelFrictionSlip(i, wheel.friction);
      if (wheel.driven) driven += 1;
    }
    this.drivenCount = Math.max(1, driven);

    const wheelStates: WheelState[] = [];
    for (let i = 0; i < this.wheelCount; i += 1) {
      wheelStates.push({
        contact: false,
        contactPoint: vec3(),
        contactNormal: vec3(),
        suspensionLength: 0,
        rotation: 0,
        steerAngle: 0,
        slipRatio: 0,
        slipAngle: 0,
        normalForce: 0,
        longitudinalForce: 0,
        lateralForce: 0,
      });
    }
    this.state = {
      wheelCount: this.wheelCount,
      speed: 0,
      forward: vec3(0, 0, -1),
      wheels: wheelStates,
    };
  }

  setInput(input: VehicleInput): void {
    if (!Number.isFinite(input.throttle)) {
      throw this.inputError("throttle");
    }
    if (!Number.isFinite(input.steering)) {
      throw this.inputError("steering");
    }
    if (!Number.isFinite(input.brake)) {
      throw this.inputError("brake");
    }
    if (input.handbrake !== undefined && !Number.isFinite(input.handbrake)) {
      throw this.inputError("handbrake");
    }
    this.throttle = clamp(input.throttle, -1, 1);
    this.steering = clamp(input.steering, -1, 1);
    this.brake = clamp(input.brake, 0, 1);
    this.handbrake = clamp(input.handbrake ?? 0, 0, 1);
  }

  /** Steering, engine and brake for this step; called before world.step. */
  prepare(dt: number): void {
    if (!this.active) return;
    const target = this.steering * this.maxSteerRad;
    const maxDelta = this.steerRateRad * dt;
    const delta = target - this.steerAngle;
    this.steerAngle += clamp(delta, -maxDelta, maxDelta);

    const speed = this.state.speed;
    let engine = 0;
    let brake = this.brake;
    if (this.throttle > 0) {
      if (speed < -0.5) {
        brake = Math.max(brake, this.throttle);
      } else {
        const falloff = Math.max(0, 1 - Math.max(0, speed) / this.topSpeed);
        engine = this.engineForce * this.throttle * falloff;
      }
    } else if (this.throttle < 0) {
      if (speed > 0.5) {
        brake = Math.max(brake, -this.throttle);
      } else {
        engine = this.reverseForce * this.throttle;
      }
    }

    // Rapier's wheel brake is an impulse per wheel; `brakeForce` and
    // `handbrake` are vehicle-level forces, so split them evenly across all
    // wheels. Applying the full force at every wheel quadruples deceleration
    // and pitches the chassis over during a hard stop.
    const brakeImpulse =
      (this.brakeForce * brake * dt) / this.wheelCount;
    const handbrakeImpulse =
      (this.brakeForce * this.handbrake * dt) / this.wheelCount;
    for (let i = 0; i < this.wheelCount; i += 1) {
      const wheel = this.wheels[i]!;
      if (wheel.steerable) {
        this.controller.setWheelSteering(i, STEER_SIGN * this.steerAngle);
      }
      let wheelEngine = 0;
      if (wheel.driven) {
        wheelEngine = (ENGINE_SIGN * engine) / this.drivenCount;
      }
      this.controller.setWheelEngineForce(i, wheelEngine);
      let wheelBrake = brakeImpulse;
      if (this.handbrake > 0) {
        // Handbrake acts on the rear (non-driven, else rear half) wheels.
        const rear =
          !wheel.driven || i >= Math.floor(this.wheelCount / 2);
        if (rear) wheelBrake += handbrakeImpulse;
      }
      this.controller.setWheelBrake(i, wheelBrake);
    }

    if (this.downforce > 0) {
      this.downforceVector.x = 0;
      this.downforceVector.y = -this.downforce * speed * speed;
      this.downforceVector.z = 0;
      this.controller.chassis().addForce(this.downforceVector, true);
    }
  }

  update(dt: number): void {
    if (!this.active) return;
    this.lastDt = dt;
    this.controller.updateVehicle(dt);
    this.refreshTelemetry();
  }

  /** Copies pooled wheel/chassis telemetry; called after the world step. */
  refreshTelemetry(): void {
    if (!this.active) return;
    const chassis = this.controller.chassis();
    chassis.rotation(this.chassisRotation);
    quatRotate(this.state.forward, this.chassisRotation, this.forwardLocal);
    // Forward speed is the velocity component on the local -Z axis, not the
    // velocity magnitude. A drift must not flip the sign and command brakes.
    const linvel = chassis.linvel();
    this.state.speed =
      this.state.forward.x * linvel.x +
      this.state.forward.y * linvel.y +
      this.state.forward.z * linvel.z;
    const invDt = this.lastDt > 0 ? 1 / this.lastDt : 0;

    for (let i = 0; i < this.wheelCount; i += 1) {
      const wheel = this.state.wheels[i]!;
      wheel.contact = this.controller.wheelIsInContact(i);
      wheel.suspensionLength =
        this.controller.wheelSuspensionLength(i) ?? 0;
      wheel.rotation = this.controller.wheelRotation(i) ?? 0;
      wheel.steerAngle = this.controller.wheelSteering(i) ?? 0;
      wheel.normalForce = this.controller.wheelSuspensionForce(i) ?? 0;
      // Rapier reports impulses; the contract names forces.
      wheel.longitudinalForce =
        (this.controller.wheelForwardImpulse(i) ?? 0) * invDt;
      wheel.lateralForce =
        (this.controller.wheelSideImpulse(i) ?? 0) * invDt;
      // Rapier exposes no slip; keep the declared fields at zero.
      wheel.slipRatio = 0;
      wheel.slipAngle = 0;
      if (wheel.contact) {
        this.controller.wheelContactPoint(i, wheel.contactPoint);
        this.controller.wheelContactNormal(i, wheel.contactNormal);
      }
    }
  }

  read(out: VehicleState): void {
    out.wheelCount = this.wheelCount;
    out.speed = this.state.speed;
    copyVec3(out.forward, this.state.forward);
    out.wheels = this.state.wheels;
  }

  deactivate(host: RapierPhysics3D): void {
    if (!this.active) return;
    this.active = false;
    host._rapierWorld().removeVehicleController(this.controller);
  }

  private inputError(field: string): Error {
    return new Error(`vehicle input ${field} must be finite`);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function validateWheel(
  host: RapierPhysics3D,
  wheel: WheelDesc,
  index: number,
): void {
  if (!isFiniteVec3(wheel.localPosition)) {
    throw host._error(
      "E_CONTRACT",
      `vehicle wheel ${index}: localPosition must be finite`,
    );
  }
  const positive: readonly [string, number][] = [
    ["radius", wheel.radius],
    ["width", wheel.width],
    ["suspensionRestLength", wheel.suspensionRestLength],
    ["suspensionStiffness", wheel.suspensionStiffness],
    ["suspensionDamping", wheel.suspensionDamping],
    ["maxTravel", wheel.maxTravel],
  ];
  for (const [name, value] of positive) {
    if (!isFiniteNumber(value) || value <= 0) {
      throw host._error(
        "E_CONTRACT",
        `vehicle wheel ${index}: ${name} must be > 0`,
      );
    }
  }
  if (
    !isFiniteNumber(wheel.friction) ||
    wheel.friction < 0 ||
    wheel.friction > 2
  ) {
    throw host._error(
      "E_CONTRACT",
      `vehicle wheel ${index}: friction must be within 0..2`,
    );
  }
}

export function validateVehicleDesc(
  host: RapierPhysics3D,
  desc: VehicleDesc,
): void {
  if (desc.wheels.length !== 2 && desc.wheels.length !== 4) {
    throw host._error(
      "E_CONTRACT",
      "vehicle: wheels must contain 2 or 4 entries",
    );
  }
  for (let i = 0; i < desc.wheels.length; i += 1) {
    validateWheel(host, desc.wheels[i]!, i);
  }
  const positives: readonly [string, number][] = [
    ["engineForce", desc.engineForce],
    ["reverseForce", desc.reverseForce],
    ["brakeForce", desc.brakeForce],
    ["steerRateDegreesPerSecond", desc.steerRateDegreesPerSecond ?? 180],
    ["topSpeed", desc.topSpeed],
  ];
  for (const [name, value] of positives) {
    if (!isFiniteNumber(value) || value <= 0) {
      throw host._error("E_CONTRACT", `vehicle: ${name} must be > 0`);
    }
  }
  const steer = desc.maxSteerDegrees ?? 35;
  if (!isFiniteNumber(steer) || steer < 5 || steer > 60) {
    throw host._error(
      "E_CONTRACT",
      "vehicle: maxSteerDegrees must be within 5..60",
    );
  }
  if (desc.downforce !== undefined) {
    if (!isFiniteNumber(desc.downforce) || desc.downforce < 0) {
      throw host._error("E_CONTRACT", "vehicle: downforce must be >= 0");
    }
  }
}
