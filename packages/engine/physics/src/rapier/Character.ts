/**
 * Rapier character controller behind `CharacterController` (07 §3.5).
 *
 * Owns a kinematic-position capsule body created through the public world
 * API, so it appears in `bodyCount`, queries and `stateHash()` like any other
 * body. Movement is computed against the current world and applied as the
 * body's next kinematic pose; the following `step()` performs the move.
 */
import type { Quat, Vec3 } from "@lanpad/engine-core";
import type {
  BodyHandle,
  CharacterController,
  CharacterControllerDesc,
  CharacterMoveResult,
  ColliderHandle,
} from "../contracts/physics3d.js";
import type * as RAPIER from "@dimforge/rapier3d-compat";
import { RAPIER as RAPIER_MODULE } from "./load.js";
import type { RapierPhysics3D } from "./RapierPhysics3D.js";
import {
  copyVec3,
  isFiniteNumber,
  isFiniteQuat,
  isFiniteVec3,
  normalizeQuatInPlace,
  quat,
  vec3,
} from "./internal.js";

const DEG_TO_RAD = Math.PI / 180;

export class RapierCharacter implements CharacterController {
  readonly body: BodyHandle;
  readonly collider: ColliderHandle;

  private readonly host: RapierPhysics3D;
  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly colliderObject: RAPIER.Collider;
  private readonly gravity: number;
  private readonly mass: number;
  private readonly filterLayer: number;
  private readonly filterMask: number;
  private readonly includeSensors: boolean;
  private readonly predicate: (collider: RAPIER.Collider) => boolean;
  private readonly collisionOut: RAPIER.CharacterCollision;
  private readonly result: CharacterMoveResult;
  private readonly desiredDelta: Vec3 = vec3();
  private readonly movedOut: Vec3 = vec3();
  private readonly positionScratch: Vec3 = vec3();
  private readonly rotationScratch: Quat = quat();
  private readonly nextTranslation: Vec3 = vec3();
  private readonly ownColliderRaw: number;
  private verticalVelocity = 0;
  private grounded = false;
  private enabled = true;
  /** False after `destroyCharacter`; the object is then a counted no-op. */
  active = true;

  constructor(host: RapierPhysics3D, desc: CharacterControllerDesc) {
    this.host = host;
    this.gravity = desc.gravity ?? 9.81;
    this.mass = desc.mass ?? 70;
    const filter = desc.filter;
    this.filterLayer = filter?.layer ?? 0;
    this.filterMask = filter?.mask ?? 0xffffffff;
    this.includeSensors = filter?.includeSensors === true;

    const rotation = quat();
    if (desc.rotation !== undefined) {
      rotation.x = desc.rotation.x;
      rotation.y = desc.rotation.y;
      rotation.z = desc.rotation.z;
      rotation.w = desc.rotation.w;
      normalizeQuatInPlace(rotation);
    }

    this.body = host.createBody({
      type: "kinematicPosition",
      position: desc.position,
      rotation,
      canSleep: false,
    });
    this.collider = host.createCollider(this.body, {
      shape: {
        kind: "capsule",
        radius: desc.radius,
        halfHeight: desc.halfHeight,
      },
      friction: 0,
      restitution: 0,
      density: 0,
      sensor: false,
      layer: this.filterLayer,
      mask: this.filterMask,
    });

    const colliderObject = host._colliderObject(this.collider);
    if (colliderObject === null) {
      throw host._error("E_CONTRACT", "character collider was not created");
    }
    this.colliderObject = colliderObject;
    this.ownColliderRaw = colliderObject.handle;

    this.controller = host._rapierWorld().createCharacterController(0.001);
    this.controller.setUp(vec3(0, 1, 0));
    const slope =
      Math.max(0, Math.min(89, desc.slopeLimitDegrees ?? 45)) * DEG_TO_RAD;
    this.controller.setMaxSlopeClimbAngle(slope);
    this.controller.setMinSlopeSlideAngle(slope);
    this.controller.setSlideEnabled(true);
    const stepOffset = desc.stepOffset ?? 0.3;
    if (stepOffset > 0) {
      // minWidth must reach past the capsule's lowest point to land the
      // downward step probe on the tread: Rapier places that probe only
      // `minWidth` beyond the wall contact, and a capsule's lowest point sits
      // under its centre, so anything below the radius always misses and the
      // step degenerates to a zero-height nudge. Use the capsule AABB
      // half-diagonal (sqrt(2) * radius), which is Rapier's default minWidth
      // of `CharacterLength::Relative(0.5)` evaluated on this shape.
      this.controller.enableAutostep(
        stepOffset,
        Math.SQRT2 * desc.radius,
        false,
      );
    } else {
      this.controller.disableAutostep();
    }
    const snap = desc.snapToGround ?? 0.1;
    if (snap > 0) {
      this.controller.enableSnapToGround(snap);
    } else {
      this.controller.disableSnapToGround();
    }
    const pushForce = desc.pushForce ?? 0;
    if (pushForce > 0) {
      this.controller.setApplyImpulsesToDynamicBodies(true);
      this.controller.setCharacterMass(this.mass);
    }

    this.predicate = (candidate: RAPIER.Collider): boolean => {
      if (!this.active) return false;
      if (candidate.handle === this.ownColliderRaw) return false;
      const info = host._colliderFilterInfo(candidate.handle);
      if (info === null) return false;
      if (info.sensor && !this.includeSensors) return false;
      return accepts(
        this.filterLayer,
        this.filterMask,
        info.layer,
        info.mask,
      );
    };

    this.collisionOut = new RAPIER_MODULE.CharacterCollision();
    this.result = {
      moved: vec3(),
      grounded: false,
      groundNormal: vec3(0, 1, 0),
      hitCeiling: false,
      hitWall: false,
      slidCount: 0,
    };
  }

  move(desiredTranslation: Vec3, dt: number): CharacterMoveResult {
    this.result.moved.x = 0;
    this.result.moved.y = 0;
    this.result.moved.z = 0;
    this.result.grounded = this.grounded;
    this.result.groundNormal.x = 0;
    this.result.groundNormal.y = 1;
    this.result.groundNormal.z = 0;
    this.result.hitCeiling = false;
    this.result.hitWall = false;
    this.result.slidCount = 0;

    if (!isFiniteVec3(desiredTranslation)) {
      throw this.host._error(
        "E_CONTRACT",
        "character.move: desiredTranslation must be finite",
      );
    }
    if (!isFiniteNumber(dt) || dt <= 0) {
      throw this.host._error(
        "E_CONTRACT",
        "character.move: dt must be a finite positive number",
      );
    }
    if (!this.active || !this.enabled) return this.result;

    const body = this.host._bodyObject(this.body);
    if (body === null) return this.result;

    if (this.grounded && this.verticalVelocity < 0) {
      this.verticalVelocity = 0;
    }
    this.verticalVelocity -= this.gravity * dt;

    this.desiredDelta.x = desiredTranslation.x;
    this.desiredDelta.y =
      desiredTranslation.y + this.verticalVelocity * dt;
    this.desiredDelta.z = desiredTranslation.z;

    const flags = this.includeSensors
      ? undefined
      : RAPIER_MODULE.QueryFilterFlags.EXCLUDE_SENSORS;
    this.controller.computeColliderMovement(
      this.colliderObject,
      this.desiredDelta,
      flags,
      undefined,
      this.predicate,
    );
    this.controller.computedMovement(this.movedOut);
    this.grounded = this.controller.computedGrounded();
    if (this.grounded) this.verticalVelocity = 0;

    let hitCeiling = false;
    let hitWall = false;
    let slid = 0;
    let bestGroundY = -Infinity;
    const collisions = Math.min(this.controller.numComputedCollisions(), 8);
    for (let i = 0; i < collisions; i += 1) {
      const collision = this.controller.computedCollision(
        i,
        this.collisionOut,
      );
      if (collision === null) continue;
      const ny = collision.normal1.y;
      if (ny < -0.5) {
        hitCeiling = true;
      } else if (ny < 0.5) {
        hitWall = true;
        slid += 1;
      } else if (ny > bestGroundY) {
        bestGroundY = ny;
        this.result.groundNormal.x = collision.normal1.x;
        this.result.groundNormal.y = collision.normal1.y;
        this.result.groundNormal.z = collision.normal1.z;
      }
    }
    if (slid > 4) slid = 4;

    body.translation(this.positionScratch);
    this.nextTranslation.x = this.positionScratch.x + this.movedOut.x;
    this.nextTranslation.y = this.positionScratch.y + this.movedOut.y;
    this.nextTranslation.z = this.positionScratch.z + this.movedOut.z;
    body.setNextKinematicTranslation(this.nextTranslation);
    body.rotation(this.rotationScratch);
    body.setNextKinematicRotation(this.rotationScratch);

    copyVec3(this.result.moved, this.movedOut);
    this.result.grounded = this.grounded;
    this.result.hitCeiling = hitCeiling;
    this.result.hitWall = hitWall;
    this.result.slidCount = slid;
    return this.result;
  }

  teleport(position: Vec3, rotation?: Quat): void {
    if (!isFiniteVec3(position)) {
      throw this.host._error(
        "E_CONTRACT",
        "character.teleport: position must be finite",
      );
    }
    const pose = quat();
    if (rotation !== undefined) {
      pose.x = rotation.x;
      pose.y = rotation.y;
      pose.z = rotation.z;
      pose.w = rotation.w;
      if (!isFiniteQuat(pose) || !normalizeQuatInPlace(pose)) {
        throw this.host._error(
          "E_CONTRACT",
          "character.teleport: rotation must be a finite non-zero quaternion",
        );
      }
    }
    if (!this.active) return;
    const body = this.host._bodyObject(this.body);
    if (body === null) return;
    body.setTranslation(position, true);
    body.setNextKinematicTranslation(position);
    body.setRotation(pose, true);
    body.setNextKinematicRotation(pose);
    this.verticalVelocity = 0;
    this.grounded = false;
  }

  isGrounded(): boolean {
    return this.grounded;
  }

  setEnabled(enabled: boolean): void {
    if (!this.active) return;
    this.enabled = enabled;
    this.host.setEnabled(this.body, enabled);
  }

  /** Internal: called by the owning world on reset/dispose. */
  deactivate(): void {
    this.active = false;
    this.enabled = false;
    this.grounded = false;
    this.verticalVelocity = 0;
  }

  /** Internal: returns the Rapier controller so the world can remove it. */
  rawController(): RAPIER.KinematicCharacterController {
    return this.controller;
  }
}

export function accepts(
  aLayer: number,
  aMask: number,
  bLayer: number,
  bMask: number,
): boolean {
  return (aMask & (1 << bLayer)) !== 0 && (bMask & (1 << aLayer)) !== 0;
}
