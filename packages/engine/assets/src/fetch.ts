/**
 * Validated asset fetch (06 §4.3, §4.4).
 *
 * Byte accounting is taken from `response.body.getReader()`, never from a
 * header, so a lying `Content-Length` cannot make progress wrong or let a
 * body grow without bound. Every failure becomes an `AssetEngineError` with a
 * redacted message: no query, token, cookie or response body is included.
 */

import type {
  AssetContainer,
  AssetKind,
  AudioMimeType,
} from "./contracts/assets.js";
import { assetError, AssetEngineError } from "./errors.js";
import { MAX_MANIFEST_BYTES } from "./manifest.js";

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export interface AssetFetchOptions {
  readonly id: string;
  readonly url: string;
  /** Exact number of decoded body bytes the manifest declares. */
  readonly bytes: number;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly container?: AssetContainer;
  readonly kind?: AssetKind;
  /** Called once per body chunk with the chunk length. */
  readonly onBytes?: (count: number, id: string) => void;
}

export interface ManifestFetchOptions {
  readonly url: string;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 160);
  return String(error).slice(0, 160);
}

function isAbortLike(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function contentTypeBase(value: string): string {
  const semicolon = value.indexOf(";");
  return (semicolon < 0 ? value : value.slice(0, semicolon)).trim().toLowerCase();
}

const JSON_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "text/json",
  "text/plain",
]);

const CONTAINER_TYPES: Readonly<Record<AssetContainer, readonly string[]>> = {
  glb: ["model/gltf-binary", "application/gltf-binary"],
  ktx2: ["image/ktx2"],
  webp: ["image/webp"],
  png: ["image/png"],
  ogg: ["audio/ogg", "application/ogg"],
  webm: ["audio/webm", "video/webm"],
  m4a: ["audio/mp4", "audio/m4a", "video/mp4"],
  wav: ["audio/wav", "audio/wave", "audio/x-wav"],
  woff2: ["font/woff2", "application/font-woff2"],
};

/**
 * True when a response content type is acceptable for the selected container
 * or for a metadata kind. A missing header and `application/octet-stream`
 * are always acceptable (06 §4.3).
 */
export function isAcceptableContentType(
  contentType: string | null,
  container: AssetContainer | undefined,
  kind: AssetKind | undefined,
): boolean {
  if (contentType === null || contentType.trim().length === 0) return true;
  const base = contentTypeBase(contentType);
  if (base === "application/octet-stream") return true;
  if (container !== undefined) return CONTAINER_TYPES[container].includes(base);
  if (
    kind === "json" ||
    kind === "material" ||
    kind === "scene" ||
    kind === "animation"
  ) {
    return JSON_TYPES.has(base);
  }
  if (kind === "font") return base === "application/json" || JSON_TYPES.has(base);
  return true;
}

function combineSignals(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  readonly signal: AbortSignal;
  readonly didTimeout: () => boolean;
  readonly cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));
  let onCallerAbort: (() => void) | null = null;
  if (callerSignal !== undefined) {
    onCallerAbort = () => controller.abort();
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      if (callerSignal !== undefined && onCallerAbort !== null) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}

function contentLengthOf(response: Response): string | null {
  const headers = response.headers as Headers | undefined;
  if (headers === undefined || typeof headers.get !== "function") return null;
  return headers.get("content-length");
}

function checkResponseHead(
  response: Response,
  id: string,
  expectedBytes: number | null,
  expectedContainer: AssetContainer | undefined,
  expectedKind: AssetKind | undefined,
): void {
  if (!response.ok || response.status === 0) {
    throw assetError(
      "E_ASSET_LOAD",
      `${id}: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
      id,
    );
  }
  const contentType = response.headers as Headers | undefined;
  const value =
    contentType !== undefined && typeof contentType.get === "function"
      ? contentType.get("content-type")
      : null;
  if (!isAcceptableContentType(value, expectedContainer, expectedKind)) {
    throw assetError(
      "E_ASSET_FORMAT",
      `${id}: unexpected content type ${contentTypeBase(value ?? "")}`,
      id,
    );
  }
  if (expectedBytes !== null) {
    const rawLength = contentLengthOf(response);
    if (rawLength !== null) {
      const declaredLength = Number(rawLength);
      if (!Number.isInteger(declaredLength) || declaredLength !== expectedBytes) {
        throw assetError(
          "E_ASSET_LOAD",
          `${id}: Content-Length ${rawLength} does not match declared ${expectedBytes} bytes`,
          id,
        );
      }
    }
  }
}

async function readBody(
  response: Response,
  id: string,
  expectedBytes: number,
  onBytes: ((count: number, assetId: string) => void) | undefined,
): Promise<ArrayBuffer> {
  const body = response.body;
  if (body === null) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== expectedBytes) {
      throw assetError(
        "E_ASSET_LOAD",
        `${id}: body length ${bytes.byteLength} does not match declared ${expectedBytes} bytes`,
        id,
      );
    }
    onBytes?.(bytes.byteLength, id);
    return bytes;
  }

  const reader = body.getReader();
  let received = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      received += value.byteLength;
      if (received > expectedBytes) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation is best-effort; the failure below is authoritative.
        }
        throw assetError(
          "E_ASSET_LOAD",
          `${id}: body exceeds declared ${expectedBytes} bytes`,
          id,
        );
      }
      chunks.push(value);
      onBytes?.(value.byteLength, id);
    }
  } finally {
    reader.releaseLock();
  }

  if (received !== expectedBytes) {
    throw assetError(
      "E_ASSET_LOAD",
      `${id}: body ended at ${received} of ${expectedBytes} bytes`,
      id,
    );
  }

  if (chunks.length === 1) {
    const only = chunks[0];
    if (only !== undefined) {
      return only.buffer.slice(
        only.byteOffset,
        only.byteOffset + only.byteLength,
      ) as ArrayBuffer;
    }
  }
  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

/**
 * Fetches exact asset bytes with progress, timeout and cancellation.
 *
 * The caller guarantees a validated same-origin URL. Mapping:
 * caller abort -> `E_ASSET_ABORTED`; timeout, HTTP, content-length and body
 * mismatch -> `E_ASSET_LOAD`; unexpected content type -> `E_ASSET_FORMAT`.
 */
export async function fetchAssetBytes(
  options: AssetFetchOptions,
): Promise<ArrayBuffer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const combined = combineSignals(options.signal, timeoutMs);
  const fail = (error: unknown): never => {
    if (options.signal?.aborted === true) {
      throw assetError(
        "E_ASSET_ABORTED",
        `${options.id}: load aborted`,
        options.id,
      );
    }
    if (combined.didTimeout()) {
      throw assetError(
        "E_ASSET_LOAD",
        `${options.id}: fetch timed out after ${timeoutMs} ms`,
        options.id,
      );
    }
    if (error instanceof AssetEngineError) throw error;
    if (isAbortLike(error)) {
      throw assetError(
        "E_ASSET_ABORTED",
        `${options.id}: load aborted`,
        options.id,
      );
    }
    throw assetError(
      "E_ASSET_LOAD",
      `${options.id}: fetch failed (${errorMessage(error)})`,
      options.id,
    );
  };

  try {
    if (options.signal?.aborted === true) {
      throw assetError(
        "E_ASSET_ABORTED",
        `${options.id}: load aborted`,
        options.id,
      );
    }
    const response = await options.fetchImpl(options.url, {
      method: "GET",
      mode: "same-origin",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-cache",
      signal: combined.signal,
    });
    checkResponseHead(
      response,
      options.id,
      options.bytes,
      options.container,
      options.kind,
    );
    return await readBody(response, options.id, options.bytes, options.onBytes);
  } catch (error) {
    return fail(error);
  } finally {
    combined.cleanup();
  }
}

/**
 * Fetches the manifest text and enforces the 262,144-byte limit while reading,
 * so an oversized document is never fully buffered. JSON parsing is the
 * caller's job (it owns the schema and error paths).
 */
export async function fetchManifestText(
  options: ManifestFetchOptions,
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const combined = combineSignals(options.signal, timeoutMs);
  const id = "asset-manifest";
  const fail = (error: unknown): never => {
    if (options.signal?.aborted === true) {
      throw assetError("E_ASSET_ABORTED", `${id}: load aborted`, id);
    }
    if (combined.didTimeout()) {
      throw assetError(
        "E_ASSET_LOAD",
        `${id}: fetch timed out after ${timeoutMs} ms`,
        id,
      );
    }
    if (error instanceof AssetEngineError) throw error;
    if (isAbortLike(error)) {
      throw assetError("E_ASSET_ABORTED", `${id}: load aborted`, id);
    }
    throw assetError(
      "E_ASSET_LOAD",
      `${id}: fetch failed (${errorMessage(error)})`,
      id,
    );
  };

  try {
    if (options.signal?.aborted === true) {
      throw assetError("E_ASSET_ABORTED", `${id}: load aborted`, id);
    }
    const response = await options.fetchImpl(options.url, {
      method: "GET",
      mode: "same-origin",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-cache",
      signal: combined.signal,
    });
    if (!response.ok || response.status === 0) {
      throw assetError(
        "E_ASSET_LOAD",
        `${id}: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
        id,
      );
    }

    const rawLength = contentLengthOf(response);
    if (rawLength !== null) {
      const declared = Number(rawLength);
      if (!Number.isInteger(declared) || declared < 0) {
        throw assetError("E_ASSET_LOAD", `${id}: invalid Content-Length`, id);
      }
      if (declared > MAX_MANIFEST_BYTES) {
        throw assetError(
          "E_ASSET_FORMAT",
          `${id}: manifest exceeds ${MAX_MANIFEST_BYTES} bytes`,
          id,
        );
      }
    }

    let buffer: Uint8Array;
    const body = response.body;
    if (body === null) {
      const array = await response.arrayBuffer();
      if (array.byteLength > MAX_MANIFEST_BYTES) {
        throw assetError(
          "E_ASSET_FORMAT",
          `${id}: manifest exceeds ${MAX_MANIFEST_BYTES} bytes`,
          id,
        );
      }
      buffer = new Uint8Array(array);
    } else {
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value === undefined || value.byteLength === 0) continue;
          received += value.byteLength;
          if (received > MAX_MANIFEST_BYTES) {
            try {
              await reader.cancel();
            } catch {
              // Best-effort; the size failure below is authoritative.
            }
            throw assetError(
              "E_ASSET_FORMAT",
              `${id}: manifest exceeds ${MAX_MANIFEST_BYTES} bytes`,
              id,
            );
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      if (rawLength !== null && received !== Number(rawLength)) {
        throw assetError(
          "E_ASSET_LOAD",
          `${id}: manifest body length ${received} does not match Content-Length`,
          id,
        );
      }
      buffer = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw assetError(
        "E_ASSET_FORMAT",
        `${id}: manifest is not valid UTF-8`,
        id,
      );
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  } catch (error) {
    return fail(error);
  } finally {
    combined.cleanup();
  }
}

/** Parsed audio MIME from a response's content type, if recognized. */
export function audioMimeFromContentType(
  contentType: string | null,
): AudioMimeType | undefined {
  if (contentType === null) return undefined;
  const base = contentTypeBase(contentType);
  if (base === "audio/ogg" || base === "application/ogg") return "audio/ogg";
  if (base === "audio/webm" || base === "video/webm") return "audio/webm";
  if (base === "audio/mp4" || base === "audio/m4a" || base === "video/mp4") {
    return "audio/mp4";
  }
  if (base === "audio/wav" || base === "audio/wave" || base === "audio/x-wav") {
    return "audio/wav";
  }
  return undefined;
}
