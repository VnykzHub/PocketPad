/**
 * Physics errors (07 §5.16). The frozen contract allows exactly four core
 * codes; this class is the concrete `PhysicsError` shape.
 */
import type {
  PhysicsError,
  PhysicsErrorCode,
} from "../contracts/physics3d.js";

/** Concrete error thrown at the boundary. Never thrown inside `step()`. */
export class PhysicsEngineError extends Error implements PhysicsError {
  readonly code: PhysicsErrorCode;
  readonly layer = "physics" as const;
  readonly recoverable: boolean;

  constructor(
    code: PhysicsErrorCode,
    message: string,
    recoverable = false,
  ) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export function physicsError(
  code: PhysicsErrorCode,
  message: string,
): PhysicsEngineError {
  return new PhysicsEngineError(code, message);
}
