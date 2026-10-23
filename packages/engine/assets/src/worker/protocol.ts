/**
 * Worker message shapes and result helpers (06 §5.1, §5.6).
 *
 * `AssetDecodeRequest` is the frozen contract shape; the worker also needs
 * the resolved URL for audio sniffing and the optional texture format for a
 * cross-check, so this internal type adds those fields. Nothing here is
 * exported from the package entry.
 */

import type {
  AssetCapability,
  AssetDecodeRequest,
  AssetDecodeResult,
  AssetErrorCode,
  AssetKind,
  AssetTextureFormat,
  AssetValue,
  AudioMimeType,
} from "../contracts/assets.js";
import type { DecodeOutcome } from "../codec/dispatch.js";
import { AssetEngineError, toAssetFailure } from "../errors.js";

export interface DecodeWorkerRequest extends AssetDecodeRequest {
  /** Resolved same-origin URL; audio uses its extension for the MIME check. */
  readonly url: string;
  /** Texture variants only; decoded format must match when present. */
  readonly format?: AssetTextureFormat;
  /** KTX2 capability check inside the worker. */
  readonly capabilities?: readonly AssetCapability[];
}

export type DecodeWorkerResponse = AssetDecodeResult<AssetValue<AssetKind>>;

/** True when a message is shaped like a decode result. */
export function isDecodeResult(value: unknown): value is DecodeWorkerResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { jobId?: unknown; ok?: unknown };
  return (
    typeof record.jobId === "number" &&
    Number.isInteger(record.jobId) &&
    typeof record.ok === "boolean"
  );
}

/** Transfer list for every ArrayBuffer a decoded value owns (06 §5.6). */
export function transferablesForValue(
  kind: AssetKind,
  value: AssetValue<AssetKind>,
): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  if (kind === "mesh") {
    const mesh = value as AssetValue<"mesh">;
    for (const primitive of mesh.primitives) {
      buffers.push(primitive.vertices.buffer as ArrayBuffer);
      buffers.push(primitive.indices.buffer as ArrayBuffer);
    }
    return buffers;
  }
  if (kind === "texture") {
    const texture = value as AssetValue<"texture">;
    for (const level of texture.levels) {
      buffers.push(level.bytes.buffer as ArrayBuffer);
    }
    return buffers;
  }
  if (kind === "audio") {
    const audio = value as AssetValue<"audio">;
    if (audio.kind === "encoded") buffers.push(audio.bytes);
    return buffers;
  }
  if (kind === "font") {
    const font = value as AssetValue<"font">;
    if (font.kind === "woff2") buffers.push(font.bytes);
    return buffers;
  }
  return buffers;
}

export function decodeResultFromOutcome(
  jobId: number,
  outcome: DecodeOutcome,
): DecodeWorkerResponse {
  const result: {
    jobId: number;
    ok: boolean;
    value: AssetValue<AssetKind>;
    droppedAttributes?: number;
    gpuBytes?: number;
  } = { jobId, ok: true, value: outcome.value };
  if (outcome.droppedAttributes !== undefined) {
    result.droppedAttributes = outcome.droppedAttributes;
  }
  if (outcome.value !== null && typeof outcome.value === "object") {
    const gpuBytes = (outcome.value as { gpuBytes?: unknown }).gpuBytes;
    if (typeof gpuBytes === "number") result.gpuBytes = gpuBytes;
  }
  return result;
}

export function decodeFailureResult(
  jobId: number,
  id: string,
  error: unknown,
): DecodeWorkerResponse {
  const failure = toAssetFailure(id, error);
  return {
    jobId,
    ok: false,
    errorCode: failure.code,
    errorMessage: failure.message,
  };
}

/** Failure with an explicit code, used for pool-level errors. */
export function decodePoolFailure(
  jobId: number,
  code: AssetErrorCode,
  message: string,
): DecodeWorkerResponse {
  return {
    jobId,
    ok: false,
    errorCode: code,
    errorMessage: message,
  };
}

/** Converts a failed result back to an error for a main-thread caller. */
export function decodeResultError(
  result: DecodeWorkerResponse,
  id: string,
): AssetEngineError {
  const code: AssetErrorCode = result.errorCode ?? "E_WORKER_FAILED";
  const message = result.errorMessage ?? `${id}: decode failed`;
  return new AssetEngineError(code, message, id);
}

/** Message the worker receives; the transfer list carries `bytes`. */
export function decodeRequestTransfer(
  request: DecodeWorkerRequest,
): Transferable[] {
  return [request.bytes];
}

/** Audio MIME stored on a request; kept for type narrowing in the worker. */
export type DecodeRequestMime = AudioMimeType;
