/**
 * `.material.json` v1 decode (06 §4.8).
 *
 * Materials are small main-thread documents (06 §5.1 module map). Texture
 * slots name manifest ids, never URLs or GPU handles. Ranges are clamped per
 * 04 §4.7; structural problems fail `E_ASSET_FORMAT`. A referenced texture id
 * must exist and be `kind: "texture"`.
 */

import type { AssetKind, MaterialData } from "../contracts/assets.js";
import { assetError } from "../errors.js";
import { parseJsonValue } from "./json.js";

export const MAX_MATERIAL_BYTES = 1_048_576;
export const MATERIAL_MIN_ROUGHNESS = 0.04;

const TEXTURE_SLOTS = [
  "baseColorTexture",
  "metallicRoughnessTexture",
  "normalTexture",
  "occlusionTexture",
  "emissiveTexture",
] as const;

type TextureSlot = (typeof TEXTURE_SLOTS)[number];
type AlphaMode = "opaque" | "mask" | "blend";

export interface MaterialDecodeOptions {
  readonly id: string;
  readonly bytes: ArrayBuffer;
  /** Manifest lookup used to check that texture ids exist and are textures. */
  readonly lookupKind: (assetId: string) => AssetKind | undefined;
}

function fail(id: string, reason: string): never {
  throw assetError("E_ASSET_FORMAT", `${id}: ${reason}`, id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(
  id: string,
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(id, `${key} must be a finite number`);
  }
  return value;
}

function clamp(value: number, low: number, high: number): number {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

function tupleField(
  id: string,
  raw: Record<string, unknown>,
  key: string,
  size: number,
  fallback: readonly number[],
): readonly number[] {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length !== size) {
    fail(id, `${key} must be an array of ${size} numbers`);
  }
  const output: number[] = [];
  for (let index = 0; index < size; index += 1) {
    const item = value[index];
    if (typeof item !== "number" || !Number.isFinite(item)) {
      fail(id, `${key}[${index}] must be a finite number`);
    }
    output.push(clamp(item, 0, 1));
  }
  return output;
}

function booleanField(
  id: string,
  raw: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(id, `${key} must be a boolean`);
  return value;
}

function textureField(
  id: string,
  raw: Record<string, unknown>,
  key: TextureSlot,
): string | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    fail(id, `${key} must be a texture id or null`);
  }
  return value;
}

function alphaModeField(id: string, raw: Record<string, unknown>): AlphaMode {
  const value = raw.alphaMode;
  if (value === undefined) return "opaque";
  if (value !== "opaque" && value !== "mask" && value !== "blend") {
    fail(id, "alphaMode must be opaque, mask or blend");
  }
  return value;
}

/**
 * Texture ids named by a material document, without full validation. The
 * library uses this to add the material's texture dependencies before decode.
 */
export function readMaterialTextureReferences(
  id: string,
  bytes: ArrayBuffer,
): readonly string[] {
  if (bytes.byteLength > MAX_MATERIAL_BYTES) {
    fail(id, `material exceeds ${MAX_MATERIAL_BYTES} bytes`);
  }
  const raw = parseJsonValue(id, bytes);
  if (!isRecord(raw)) fail(id, "material must be a JSON object");
  const references: string[] = [];
  for (const slot of TEXTURE_SLOTS) {
    const value = raw[slot];
    if (typeof value === "string" && value.length > 0) references.push(value);
  }
  return references;
}

/**
 * Decodes and validates a material document into `MaterialData`.
 *
 * Every named texture must exist in the manifest and be a texture asset;
 * `lookupKind` returns undefined for an unknown id.
 */
export function decodeMaterial(options: MaterialDecodeOptions): MaterialData {
  const { id, bytes, lookupKind } = options;
  if (bytes.byteLength > MAX_MATERIAL_BYTES) {
    fail(id, `material exceeds ${MAX_MATERIAL_BYTES} bytes`);
  }
  const raw = parseJsonValue(id, bytes);
  if (!isRecord(raw)) fail(id, "material must be a JSON object");

  if (raw.formatVersion !== 1) {
    fail(id, "material formatVersion must be 1");
  }
  if (raw.id !== id) {
    fail(id, "material id does not match the manifest entry");
  }

  const baseColorFactor = tupleField(id, raw, "baseColorFactor", 4, [
    1, 1, 1, 1,
  ]);
  const emissiveFactor = tupleField(id, raw, "emissiveFactor", 3, [0, 0, 0]);
  const metallic = clamp(numberField(id, raw, "metallic", 1), 0, 1);
  const roughness = clamp(
    numberField(id, raw, "roughness", 1),
    MATERIAL_MIN_ROUGHNESS,
    1,
  );
  const normalScale = numberField(id, raw, "normalScale", 1);
  const occlusionStrength = clamp(
    numberField(id, raw, "occlusionStrength", 1),
    0,
    1,
  );
  const alphaCutoff = clamp(numberField(id, raw, "alphaCutoff", 0.5), 0, 1);
  const alphaMode = alphaModeField(id, raw);

  const textures: Record<TextureSlot, string | null> = {
    baseColorTexture: textureField(id, raw, "baseColorTexture"),
    metallicRoughnessTexture: textureField(
      id,
      raw,
      "metallicRoughnessTexture",
    ),
    normalTexture: textureField(id, raw, "normalTexture"),
    occlusionTexture: textureField(id, raw, "occlusionTexture"),
    emissiveTexture: textureField(id, raw, "emissiveTexture"),
  };
  for (const slot of TEXTURE_SLOTS) {
    const textureId = textures[slot];
    if (textureId === null) continue;
    if (lookupKind(textureId) !== "texture") {
      fail(id, `${slot} references ${textureId}, which is not a texture asset`);
    }
  }

  return {
    formatVersion: 1,
    id,
    baseColorFactor: [
      baseColorFactor[0] ?? 1,
      baseColorFactor[1] ?? 1,
      baseColorFactor[2] ?? 1,
      baseColorFactor[3] ?? 1,
    ],
    metallic,
    roughness,
    emissiveFactor: [
      emissiveFactor[0] ?? 0,
      emissiveFactor[1] ?? 0,
      emissiveFactor[2] ?? 0,
    ],
    baseColorTexture: textures.baseColorTexture,
    metallicRoughnessTexture: textures.metallicRoughnessTexture,
    normalTexture: textures.normalTexture,
    normalScale,
    occlusionTexture: textures.occlusionTexture,
    occlusionStrength,
    emissiveTexture: textures.emissiveTexture,
    alphaMode,
    alphaCutoff,
    doubleSided: booleanField(id, raw, "doubleSided", false),
    unlit: booleanField(id, raw, "unlit", false),
  };
}
