/**
 * Save codec errors.
 *
 * The shared `EngineError` value class (00 §5.9) is not part of this wave;
 * the scene subtree follows the same pattern with `SceneEngineError`. This
 * class structurally implements the frozen `EngineError` contract and names
 * itself `EngineError`, so integration can replace the factory without
 * touching a call site. Messages are short and redacted: no payload bytes,
 * tokens or user paths.
 */

import type { EngineError } from "../contracts/engine.js";
import type { SaveErrorCode } from "../contracts/save.js";

export class SaveEngineError extends Error implements EngineError {
  readonly code: SaveErrorCode;
  readonly layer = "core" as const;
  readonly recoverable: boolean;

  constructor(
    code: SaveErrorCode,
    message: string,
    recoverable = false,
  ) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

/** All codec failures are data failures for the named file, never retryable. */
export function saveError(
  code: SaveErrorCode,
  message: string,
): SaveEngineError {
  return new SaveEngineError(code, message, false);
}
