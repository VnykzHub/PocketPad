/**
 * Renderer errors (04 §5.10). Codes are core-owned; this module only supplies
 * the concrete class and sanitized messages. No error message may contain a
 * URL, token, room code or player name.
 */

import type { EngineError, EngineErrorCode } from "@lanpad/engine-core";

/** Messages are display-only. Strip URLs and assignment-shaped secrets. */
export function sanitizeMessage(message: string): string {
  const withoutUrls = message.replace(/https?:\/\/\S+/gi, "[url]");
  const withoutAssignments = withoutUrls.replace(
    /\b(token|pin|room|session|secret|key)=[^\s&]+/gi,
    "$1=[redacted]",
  );
  const withoutControls = withoutAssignments.replace(
    /[\u0000-\u001f\u007f]+/g,
    " ",
  );
  const trimmed = withoutControls.replace(/\s+/g, " ").trim();
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
}

/** Concrete `EngineError` for the renderer layer. */
export class WebGpuRendererError extends Error implements EngineError {
  readonly code: EngineErrorCode;
  readonly layer = "renderer" as const;
  readonly recoverable: boolean;
  readonly label: string | null;

  constructor(
    code: EngineErrorCode,
    message: string,
    options?: {
      readonly recoverable?: boolean;
      readonly label?: string;
      readonly cause?: unknown;
    },
  ) {
    super(
      sanitizeMessage(message),
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "WebGpuRendererError";
    this.code = code;
    this.recoverable = options?.recoverable ?? false;
    this.label = options?.label ?? null;
  }
}

export function rendererError(
  code: EngineErrorCode,
  message: string,
  options?: {
    readonly recoverable?: boolean;
    readonly label?: string;
    readonly cause?: unknown;
  },
): WebGpuRendererError {
  return new WebGpuRendererError(code, message, options);
}
