/**
 * Scene error construction.
 *
 * `EngineError` itself is owned by spec 00 (`src/errors.ts`) and does not exist
 * in this wave. The scene therefore constructs an error that satisfies the
 * frozen `EngineError` contract (code + layer + recoverable) and names itself
 * `EngineError`. When the shared class lands, integration can replace this
 * factory without changing any call site.
 */

import type { EngineErrorCode } from "../contracts/engine.js";

export class SceneEngineError extends Error {
  readonly code: EngineErrorCode;
  readonly layer = "core" as const;
  readonly recoverable: boolean;

  constructor(code: EngineErrorCode, message: string, recoverable = false) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export function sceneError(
  code: EngineErrorCode,
  message: string,
  recoverable = false,
): SceneEngineError {
  return new SceneEngineError(code, message, recoverable);
}
