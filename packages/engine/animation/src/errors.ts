/**
 * Animation error values (spec 08 §5.15).
 *
 * The shared `EngineError` value class (spec 00) is not exported by
 * `@lanpad/engine-core` yet; this class structurally implements the frozen
 * `EngineError` contract and names itself `EngineError`, following the same
 * pattern as `packages/engine/core/src/scene/errors.ts` and
 * `packages/engine/audio/src/errors.ts`. Integration can swap the factory
 * without changing callers.
 */

import type { EngineError, EngineErrorCode } from "@lanpad/engine-core";

export class AnimationEngineError extends Error implements EngineError {
  readonly code: EngineErrorCode;
  readonly layer = "animation" as const;
  readonly recoverable: boolean;

  constructor(code: EngineErrorCode, message: string, recoverable = true) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export function animationError(
  code: EngineErrorCode,
  message: string,
  recoverable = true,
): AnimationEngineError {
  return new AnimationEngineError(code, message, recoverable);
}

/** Internal counters for clamps and rejected operations, never hashed. */
export interface AnimationCounters {
  dtClamp: number;
  speedClamp: number;
  fadeClamp: number;
  noOpInstance: number;
  aliasRejected: number;
  staleInstance: number;
  applyWithoutScene: number;
  nonFinitePose: number;
  rootAccumClamp: number;
  rootTeleportRejected: number;
  eventsEmitted: number;
  eventsDropped: number;
}

export function createCounters(): AnimationCounters {
  return {
    dtClamp: 0,
    speedClamp: 0,
    fadeClamp: 0,
    noOpInstance: 0,
    aliasRejected: 0,
    staleInstance: 0,
    applyWithoutScene: 0,
    nonFinitePose: 0,
    rootAccumClamp: 0,
    rootTeleportRejected: 0,
    eventsEmitted: 0,
    eventsDropped: 0,
  };
}

/**
 * Dev detection without a hard `process` dependency (this module is
 * browser-bound). Defaults to dev when no environment is visible.
 */
export const IS_DEV: boolean = (() => {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  const nodeEnv = proc?.env?.["NODE_ENV"];
  return nodeEnv !== "production";
})();
