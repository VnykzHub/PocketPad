/**
 * Renderer-layer `EngineError` implementation (00 §5.9).
 *
 * `@lanpad/engine-core` ships the `EngineError` contract interface but no
 * concrete class yet, so this backend provides the structural implementation.
 * Codes are the frozen core union; this module never invents a second union.
 */

import type { EngineError, EngineErrorCode } from "@lanpad/engine-core";

export class RendererEngineError extends Error implements EngineError {
  readonly code: EngineErrorCode;
  readonly layer = "renderer" as const;
  readonly recoverable: boolean;

  constructor(code: EngineErrorCode, message: string, recoverable = false) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export function rendererError(
  code: EngineErrorCode,
  message: string,
  recoverable = false,
): RendererEngineError {
  return new RendererEngineError(code, message, recoverable);
}

/** Machine token for a 3D call made against the Canvas2D entry (05 §3.5). */
export const DETAIL_3D_ON_CANVAS2D = "3d-on-canvas2d";

export const MESSAGE_3D_ON_CANVAS2D =
  "This device provides only 2D drawing. This game requires a 3D renderer (3d-on-canvas2d).";

/** The single 3D-on-Canvas2D refusal. Never a silent stub (ER-05-07). */
export function unsupported3dOnCanvas2d(operation: string): RendererEngineError {
  return rendererError(
    "E_UNSUPPORTED_FEATURE",
    `${MESSAGE_3D_ON_CANVAS2D} [${operation}]`,
    false,
  );
}
