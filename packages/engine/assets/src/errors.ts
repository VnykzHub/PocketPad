/**
 * Asset-layer errors (06 §3.7, §5.11).
 *
 * Core declares the `EngineError` shape but does not ship a concrete class in
 * W1. This class implements that frozen shape with `layer: "assets"`; it is
 * the only error type the asset layer throws. Messages carry an id and a
 * short reason, never tokens, cookies or response bodies.
 */

import type { AssetErrorCode, AssetFailure } from "./contracts/assets.js";

const RECOVERABLE: ReadonlySet<AssetErrorCode> = new Set<AssetErrorCode>([
  "E_ASSET_LOAD",
  "E_ASSET_ABORTED",
  "E_WORKER_FAILED",
  "E_ASSET_NOT_READY",
  "E_ASSET_EVICTED",
]);

const RETRYABLE: ReadonlySet<AssetErrorCode> = new Set<AssetErrorCode>([
  "E_ASSET_LOAD",
  "E_ASSET_ABORTED",
  "E_WORKER_FAILED",
  "E_ASSET_HASH",
  "E_ASSET_NOT_READY",
  "E_ASSET_EVICTED",
]);

export class AssetEngineError extends Error {
  readonly code: AssetErrorCode;
  readonly layer = "assets" as const;
  readonly recoverable: boolean;
  readonly id: string | undefined;

  constructor(code: AssetErrorCode, message: string, id?: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.recoverable = RECOVERABLE.has(code);
    this.id = id;
  }
}

export function assetError(
  code: AssetErrorCode,
  message: string,
  id?: string,
): AssetEngineError {
  return new AssetEngineError(code, message, id);
}

/** True when a later `load` may succeed after this failure. */
export function isRetryableAssetCode(code: AssetErrorCode): boolean {
  return RETRYABLE.has(code);
}

export function toAssetFailure(id: string, error: unknown): AssetFailure {
  if (error instanceof AssetEngineError) {
    return {
      id,
      code: error.code,
      message: error.message,
      retryable: RETRYABLE.has(error.code),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { id, code: "E_ASSET_LOAD", message, retryable: true };
}
