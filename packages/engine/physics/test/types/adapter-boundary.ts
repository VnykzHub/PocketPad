/**
 * Compile-time proof that the A15 adapter boundary can be implemented
 * without importing Rapier, WASM or any GPU/DOM type into `engine-physics`.
 *
 * This is not a Vitest test and has no runtime assertions: stubs throw.
 * `tsconfig.test.json` includes it, so a widened `PhysicsBackend` or a
 * changed adapter factory fails typecheck here before an implementation
 * exists.
 */
import type {
  BodyHandle,
  CharacterController,
  ColliderHandle,
  JointHandle,
  PhysicsAdapter,
  PhysicsBackend,
  PhysicsStats,
  VehicleHandle,
} from "../../src/index.js";

function notImplemented(): never {
  throw new Error(
    "contract-only backend stub; W0 ships no physics implementation",
  );
}

const EMPTY_STATS: PhysicsStats = Object.freeze<PhysicsStats>({
  bodyCount: 0,
  colliderCount: 0,
  awakeBodyCount: 0,
  pairCount: 0,
  contactCount: 0,
  stepMs: 0,
  broadphaseMs: 0,
  narrowphaseMs: 0,
  solverMs: 0,
  droppedEvents: 0,
  ccdSweeps: 0,
});

/**
 * A custom backend stub. Every operation is present, typed and throws; no
 * Rapier or WASM symbol appears in this package.
 */
export class ContractOnlyBackend implements PhysicsBackend {
  readonly backend = "custom" as const;
  readonly fixedDt = 1 / 60;
  tick = 0;
  readonly stats: PhysicsStats = EMPTY_STATS;

  step(): void {
    notImplemented();
  }

  createBody(): BodyHandle {
    return notImplemented();
  }

  destroyBody(): void {
    notImplemented();
  }

  createCollider(): ColliderHandle {
    return notImplemented();
  }

  destroyCollider(): void {
    notImplemented();
  }

  setEnabled(): void {
    notImplemented();
  }

  readBody(): boolean {
    return notImplemented();
  }

  readCollider(): boolean {
    return notImplemented();
  }

  setTransform(): void {
    notImplemented();
  }

  setLinearVelocity(): void {
    notImplemented();
  }

  setAngularVelocity(): void {
    notImplemented();
  }

  applyForce(): void {
    notImplemented();
  }

  applyImpulse(): void {
    notImplemented();
  }

  applyTorqueImpulse(): void {
    notImplemented();
  }

  clearForces(): void {
    notImplemented();
  }

  createJoint(): JointHandle {
    return notImplemented();
  }

  destroyJoint(): void {
    notImplemented();
  }

  setJointMotor(): void {
    notImplemented();
  }

  readJoint(): boolean {
    return notImplemented();
  }

  createVehicle(): VehicleHandle {
    return notImplemented();
  }

  destroyVehicle(): void {
    notImplemented();
  }

  setVehicleInput(): void {
    notImplemented();
  }

  readVehicle(): boolean {
    return notImplemented();
  }

  createCharacter(): CharacterController {
    return notImplemented();
  }

  destroyCharacter(): void {
    notImplemented();
  }

  raycast(): boolean {
    return notImplemented();
  }

  raycastAll(): number {
    return notImplemented();
  }

  sphereCast(): boolean {
    return notImplemented();
  }

  overlapSphere(): number {
    return notImplemented();
  }

  overlapBox(): number {
    return notImplemented();
  }

  pointQuery(): number {
    return notImplemented();
  }

  bindTransform(): void {
    notImplemented();
  }

  unbindTransform(): void {
    notImplemented();
  }

  syncScene(): void {
    notImplemented();
  }

  sampleTransform(): boolean {
    return notImplemented();
  }

  drainContactEvents(): number {
    return notImplemented();
  }

  drainTriggerEvents(): number {
    return notImplemented();
  }

  stateHash(): number {
    return notImplemented();
  }

  rebaseOrigin(): void {
    notImplemented();
  }

  reset(): void {
    notImplemented();
  }

  dispose(): void {
    notImplemented();
  }
}

/** A backend-neutral adapter that names no third-party implementation. */
export const contractOnlyAdapter: PhysicsAdapter = {
  backend: "custom",
  create(): PhysicsBackend {
    return new ContractOnlyBackend();
  },
};
