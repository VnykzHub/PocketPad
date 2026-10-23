/**
 * Seven-step host tick order (spec 01 §3.7, fixture `tick-order.json`).
 *
 * Steps 1–6 preserve the legacy game-visible order; step 7 is additive and
 * engine-only. This module owns the order, not the work: every step is an
 * injected hook. Missing hooks are skipped, so step 7 is a no-op when the host
 * has no engine scene and legacy 2D games keep their old behaviour.
 *
 * The host calls `runHostTick(hooks, dt, loop.tick)` once from `onTick`.
 * `updateTilt` is one call per fixed step; the host iterates its controller
 * slots inside that hook (the loop knows nothing about slots).
 */

/** Fixture order ids, in normative order. */
export const HOST_TICK_STEP_IDS = [
  "tilt-update",
  "input-poll",
  "input-reader-update",
  "controller-events",
  "game-simulate",
  "apply-job-results",
  "scene-world-transforms",
] as const;

export type HostTickStepId = (typeof HOST_TICK_STEP_IDS)[number];

/** The seven injected steps. Steps 1–6 are the legacy order; 7 is additive. */
export interface HostTickSteps {
  /** 1. TiltIntegrator.update(dt, snapshot) for each slot. */
  readonly updateTilt?: (dt: number) => void;
  /** 2. InputMapper.pollAll(loop.tick) exactly once per tick. */
  readonly pollInput?: (tick: number) => void;
  /** 3. InputReader.update(snapshot). */
  readonly updateInputReader?: () => void;
  /** 4. Drain queued controller events; game.onEvent runs before simulate. */
  readonly drainControllerEvents?: () => void;
  /** 5. game.simulate(dt, snapshot). */
  readonly simulate?: (dt: number) => void;
  /** 6. Apply drained job results in ascending id order. */
  readonly applyJobResults?: () => void;
  /** 7. scene.updateWorldTransforms(), engine-only, after jobs. */
  readonly updateWorldTransforms?: () => void;
}

/**
 * Runs the seven steps in the fixture's normative order. A missing hook is a
 * no-op. Exceptions propagate to the loop; the frame path has no retry.
 */
export function runHostTick(steps: HostTickSteps, dt: number, tick: number): void {
  if (steps.updateTilt !== undefined) {
    steps.updateTilt(dt);
  }
  if (steps.pollInput !== undefined) {
    steps.pollInput(tick);
  }
  if (steps.updateInputReader !== undefined) {
    steps.updateInputReader();
  }
  if (steps.drainControllerEvents !== undefined) {
    steps.drainControllerEvents();
  }
  if (steps.simulate !== undefined) {
    steps.simulate(dt);
  }
  if (steps.applyJobResults !== undefined) {
    steps.applyJobResults();
  }
  if (steps.updateWorldTransforms !== undefined) {
    steps.updateWorldTransforms();
  }
}
