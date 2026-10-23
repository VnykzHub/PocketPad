/**
 * Generic JSON asset decode (06 §4.10).
 *
 * ≤ 4 MiB, UTF-8, parsed on the main thread. Any JSON value is legal. The
 * result is data only: no proto/prototype merge ever happens in this package.
 */

import type { JsonAssetData } from "../contracts/assets.js";
import { assetError } from "../errors.js";

export const MAX_JSON_ASSET_BYTES = 4_194_304;

function fail(id: string, reason: string): never {
  throw assetError("E_ASSET_FORMAT", `${id}: ${reason}`, id);
}

/**
 * Parses a JSON asset body. Throws `E_ASSET_FORMAT` for oversize input,
 * invalid UTF-8 or invalid JSON.
 */
export function parseJsonValue(id: string, bytes: ArrayBuffer): unknown {
  if (bytes.byteLength > MAX_JSON_ASSET_BYTES) {
    fail(id, `JSON asset exceeds ${MAX_JSON_ASSET_BYTES} bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(id, "JSON asset is not valid UTF-8");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail(id, "JSON asset is not valid JSON");
  }
}

/** Wraps a parsed JSON value in the contract shape. */
export function decodeJson(options: {
  readonly id: string;
  readonly bytes: ArrayBuffer;
}): JsonAssetData {
  return { json: parseJsonValue(options.id, options.bytes) };
}
