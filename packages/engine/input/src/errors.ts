/**
 * Input error construction (10 §3.9).
 *
 * The frozen contract owns the error codes through core's `EngineErrorCode`
 * union. This module builds values that satisfy `InputError` /
 * `InputValidationError` without introducing a parallel code union.
 */

import type { InputErrorCode } from "./contracts/input.js";

/** Base runtime error for the input layer. */
export class InputEngineError extends Error {
  readonly code: InputErrorCode;
  readonly layer = "input" as const;
  readonly recoverable: boolean;

  constructor(code: InputErrorCode, message: string, recoverable = false) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

/**
 * Map/overlay validation failure. `path` is the JSON path of the first
 * violation, e.g. `actions[3].bindings[1].axis` (10 §3.9, §4.1).
 */
export class InputFormatError extends InputEngineError {
  readonly path: string;

  constructor(path: string, message: string) {
    super("E_INPUT_FORMAT", path.length > 0 ? `${message} at ${path}` : message);
    this.name = "InputValidationError";
    this.path = path;
  }
}

/** Two devices or bindings could not be resolved under the policy (10 §3.9). */
export class InputConflictError extends InputEngineError {
  constructor(message: string) {
    super("E_INPUT_CONFLICT", message, true);
  }
}

/** Non-monotonic poll tick in strict mode (10 §3.9, §5.2). */
export class InputTickError extends InputEngineError {
  constructor(message: string) {
    super("E_INPUT_TICK", message);
  }
}

export function inputError(
  code: InputErrorCode,
  message: string,
  recoverable = false,
): InputEngineError {
  return new InputEngineError(code, message, recoverable);
}
