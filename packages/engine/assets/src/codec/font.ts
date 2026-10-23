/**
 * Font container decode (06 §4.10).
 *
 * WOFF2 is transported as raw bytes; family/weight/style live in spec 13's
 * font stack. A JSON atlas is parsed but its schema belongs to spec 13, so
 * this file validates only size and syntax. TTF/OTF are refused at runtime.
 */

import type { FontAssetData } from "../contracts/assets.js";
import { assetError } from "../errors.js";

export const MAX_FONT_ATLAS_BYTES = 2_097_152;
const WOFF2_SIGNATURE = 0x774f4632;

export interface FontDecodeOptions {
  readonly id: string;
  readonly bytes: ArrayBuffer;
  /** `woff2` forces the font path; undefined lets the signature decide. */
  readonly container?: "woff2" | undefined;
}

function fail(id: string, reason: string): never {
  throw assetError("E_ASSET_FORMAT", `${id}: ${reason}`, id);
}

function isWoff2(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 4) return false;
  return new DataView(bytes).getUint32(0, false) === WOFF2_SIGNATURE;
}

function looksLikeSfnt(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 4) return false;
  const tag = new Uint8Array(bytes, 0, 4);
  const otf =
    tag[0] === 0x4f && tag[1] === 0x54 && tag[2] === 0x54 && tag[3] === 0x4f;
  const ttc =
    tag[0] === 0x74 && tag[1] === 0x74 && tag[2] === 0x63 && tag[3] === 0x66;
  const ttf =
    tag[0] === 0x00 && tag[1] === 0x01 && tag[2] === 0x00 && tag[3] === 0x00;
  return otf || ttc || ttf;
}

function parseAtlas(id: string, bytes: ArrayBuffer): unknown {
  if (bytes.byteLength > MAX_FONT_ATLAS_BYTES) {
    fail(id, `font atlas exceeds ${MAX_FONT_ATLAS_BYTES} bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(id, "font atlas is not valid UTF-8");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail(id, "font atlas is not valid JSON");
  }
}

/**
 * Decodes a font entry. WOFF2 also validates the header length fields, so a
 * truncated file fails here rather than at `FontFace` registration.
 */
export function decodeFont(options: FontDecodeOptions): FontAssetData {
  const { id, bytes } = options;
  const woff2 =
    options.container === "woff2" ||
    (options.container === undefined && isWoff2(bytes));
  if (woff2) {
    if (!isWoff2(bytes)) fail(id, "font is not a WOFF2 container");
    if (bytes.byteLength < 48) fail(id, "WOFF2 header is truncated");
    const data = new DataView(bytes);
    const flavor = data.getUint32(4, false);
    const length = data.getUint32(8, false);
    const numTables = data.getUint16(12, false);
    if (flavor === 0x74746366 || numTables === 0) {
      fail(id, "WOFF2 font collection is not supported");
    }
    if (length !== bytes.byteLength) {
      fail(id, "WOFF2 length field does not match the buffer");
    }
    return { kind: "woff2", bytes };
  }

  if (looksLikeSfnt(bytes)) {
    fail(id, "TTF/OTF is not accepted; convert the font to WOFF2");
  }
  return { kind: "atlas", json: parseAtlas(id, bytes) };
}
