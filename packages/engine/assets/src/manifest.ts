/**
 * Manifest parsing and validation (06 §4.2, §4.3, §4.8).
 *
 * Pure and dependency-free apart from URL rules; the same validator is used
 * by the host and by tooling. Validation never fetches an asset: a manifest
 * that names an over-budget, duplicate, escaping or cyclic entry is rejected
 * before a network request exists.
 */

import type {
  AssetCapability,
  AssetContainer,
  AssetErrorCode,
  AssetKind,
  AssetManifest,
  AssetManifestBudget,
  AssetManifestEntry,
  AssetTextureFormat,
  AssetVariant,
  AudioMimeType,
} from "./contracts/assets.js";
import { assetError } from "./errors.js";
import {
  normalizeBaseUrl,
  resolveAssetUrl,
  validateRelativeUrl,
} from "./url.js";
import { ASSET_MANIFEST_VERSION } from "./version.js";

export const MAX_MANIFEST_BYTES = 262_144;
export const MAX_MANIFEST_ASSETS = 4096;
export const MAX_ASSET_BYTES = 268_435_456;
export const INITIAL_BUDGET_BYTES = 5_242_880;
export const DEFAULT_MAX_TOTAL_BYTES = 268_435_456;
export const MAX_VARIANTS = 8;
export const MAX_DEPENDENCIES = 16;
export const MAX_META_KEYS = 16;
export const MAX_META_VALUE_CHARS = 256;
export const MAX_JSON_ASSET_BYTES = 4_194_304;
export const MAX_FONT_ATLAS_BYTES = 2_097_152;

export const ASSET_KINDS: readonly AssetKind[] = [
  "mesh",
  "texture",
  "material",
  "audio",
  "font",
  "json",
  "scene",
  "animation",
];

export const ASSET_CAPABILITIES: readonly AssetCapability[] = [
  "compressed-s3tc",
  "compressed-etc2",
  "compressed-astc",
  "texture-array",
  "float-render-target",
];

export const ASSET_CONTAINERS: readonly AssetContainer[] = [
  "glb",
  "ktx2",
  "webp",
  "png",
  "ogg",
  "webm",
  "m4a",
  "wav",
  "woff2",
];

export const ASSET_TEXTURE_FORMATS: readonly AssetTextureFormat[] = [
  "rgba8unorm",
  "rgba8unorm-srgb",
  "bc1-rgba-unorm",
  "bc1-rgba-unorm-srgb",
  "bc3-rgba-unorm",
  "bc3-rgba-unorm-srgb",
  "bc7-rgba-unorm",
  "bc7-rgba-unorm-srgb",
  "etc2-rgba8unorm",
  "etc2-rgba8unorm-srgb",
  "astc-4x4-unorm",
  "astc-4x4-unorm-srgb",
];

export const AUDIO_MIME_TYPES: readonly AudioMimeType[] = [
  "audio/ogg",
  "audio/webm",
  "audio/mp4",
  "audio/wav",
];

const KIND_SET: ReadonlySet<string> = new Set<string>(ASSET_KINDS);
const CAPABILITY_SET: ReadonlySet<string> = new Set<string>(ASSET_CAPABILITIES);
const CONTAINER_SET: ReadonlySet<string> = new Set<string>(ASSET_CONTAINERS);
const TEXTURE_FORMAT_SET: ReadonlySet<string> = new Set<string>(
  ASSET_TEXTURE_FORMATS,
);
const AUDIO_MIME_SET: ReadonlySet<string> = new Set<string>(AUDIO_MIME_TYPES);

const ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9/_.-]{0,127}$/;
const GAME_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const GROUP_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HASH_PATTERN = /^fnv1a32:[0-9a-f]{8}$/;

const KIND_EXTENSIONS: Readonly<Record<AssetKind, readonly string[]>> = {
  mesh: [".glb"],
  texture: [".webp", ".png", ".ktx2"],
  material: [".material.json"],
  audio: [".ogg", ".webm", ".wav", ".m4a", ".mp4"],
  font: [".woff2", ".json"],
  json: [".json"],
  scene: [".json"],
  animation: [".json"],
};

const CONTAINER_EXTENSIONS: Readonly<
  Record<AssetContainer, readonly string[]>
> = {
  glb: [".glb"],
  ktx2: [".ktx2"],
  webp: [".webp"],
  png: [".png"],
  ogg: [".ogg"],
  webm: [".webm"],
  m4a: [".m4a", ".mp4"],
  wav: [".wav"],
  woff2: [".woff2"],
};

const KIND_CONTAINERS: Readonly<Record<AssetKind, readonly AssetContainer[]>> =
  {
    mesh: ["glb"],
    texture: ["webp", "png", "ktx2"],
    material: [],
    audio: ["ogg", "webm", "m4a", "wav"],
    font: ["woff2"],
    json: [],
    scene: [],
    animation: [],
  };

const AUDIO_EXTENSION_MIME: Readonly<Record<string, AudioMimeType>> = {
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
};

export interface ManifestIssue {
  readonly code: AssetErrorCode;
  readonly path: string;
  readonly message: string;
}

export interface ManifestValidationOptions {
  /** When present, the manifest id must equal this game id. */
  readonly gameId?: string;
  /** Engine ceiling for `budget.totalBytes`; default 256 MiB. */
  readonly maxTotalBytes?: number;
  /** Directory all entry URLs must stay under; default "./". */
  readonly baseUrl?: string;
}

export interface ManifestValidationResult {
  readonly ok: boolean;
  readonly manifest: AssetManifest | null;
  readonly issues: readonly ManifestIssue[];
}

interface EntryParse {
  readonly index: number;
  readonly id: string;
  readonly bytes: number;
  readonly initial: boolean;
  readonly dependencies: readonly string[];
  readonly entry: AssetManifestEntry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function lowerEndsWith(value: string, endings: readonly string[]): boolean {
  const lower = value.toLowerCase();
  return endings.some((ending) => lower.endsWith(ending));
}

export function isAssetKind(value: unknown): value is AssetKind {
  return typeof value === "string" && KIND_SET.has(value);
}

export function isAssetContainer(value: unknown): value is AssetContainer {
  return typeof value === "string" && CONTAINER_SET.has(value);
}

export function isAssetCapability(value: unknown): value is AssetCapability {
  return typeof value === "string" && CAPABILITY_SET.has(value);
}

export function isAssetTextureFormat(
  value: unknown,
): value is AssetTextureFormat {
  return typeof value === "string" && TEXTURE_FORMAT_SET.has(value);
}

/** Chrome of the URL without a query/fragment (both forbidden by rule). */
export function urlExtension(url: string): string {
  const lower = url.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot < 0 ? "" : lower.slice(dot);
}

/** True when the URL ends with an extension allowed for `kind`. */
export function urlMatchesKind(url: string, kind: AssetKind): boolean {
  return lowerEndsWith(url, KIND_EXTENSIONS[kind]);
}

/** True when the URL ends with an extension implied by `container`. */
export function urlMatchesContainer(
  url: string,
  container: AssetContainer,
): boolean {
  return lowerEndsWith(url, CONTAINER_EXTENSIONS[container]);
}

/** Container inferred from a validated URL extension, if any. */
export function containerForUrl(url: string): AssetContainer | undefined {
  const lower = url.toLowerCase();
  if (lower.endsWith(".material.json")) return undefined;
  if (lower.endsWith(".glb")) return "glb";
  if (lower.endsWith(".ktx2")) return "ktx2";
  if (lower.endsWith(".webp")) return "webp";
  if (lower.endsWith(".png")) return "png";
  if (lower.endsWith(".ogg")) return "ogg";
  if (lower.endsWith(".webm")) return "webm";
  if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "m4a";
  if (lower.endsWith(".wav")) return "wav";
  if (lower.endsWith(".woff2")) return "woff2";
  return undefined;
}

/** Audio MIME type implied by a validated URL extension. */
export function audioMimeForUrl(url: string): AudioMimeType | undefined {
  return AUDIO_EXTENSION_MIME[urlExtension(url)];
}

/** True when a manifest asset id satisfies the 06 §4.2 id rule. */
export function isValidAssetId(id: string): boolean {
  if (!ASSET_ID_PATTERN.test(id)) return false;
  if (id.startsWith("/") || id.endsWith("/")) return false;
  if (id.includes("//")) return false;
  const segments = id.split("/");
  return segments.every((segment) => segment !== "." && segment !== "..");
}

function issue(
  issues: ManifestIssue[],
  code: AssetErrorCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

interface VariantParse {
  readonly valid: boolean;
  readonly variant: AssetVariant | null;
}

function validateVariant(
  value: unknown,
  path: string,
  kind: AssetKind | null,
  baseUrl: string,
  issues: ManifestIssue[],
): VariantParse {
  if (!isRecord(value)) {
    issue(issues, "E_ASSET_FORMAT", path, "variant must be an object");
    return { valid: false, variant: null };
  }

  let valid = true;
  const urlValue = value["url"];
  let url: string | null = null;
  if (typeof urlValue !== "string") {
    issue(issues, "E_ASSET_FORMAT", `${path}.url`, "url is required");
    valid = false;
  } else {
    const reason = validateRelativeUrl(urlValue);
    if (reason !== null) {
      issue(issues, "E_ASSET_FORMAT", `${path}.url`, `url ${reason}`);
      valid = false;
    } else {
      url = urlValue;
    }
  }

  const bytesValue = value["bytes"];
  let bytes: number | null = null;
  if (!isPositiveInteger(bytesValue) || bytesValue > MAX_ASSET_BYTES) {
    issue(
      issues,
      "E_ASSET_FORMAT",
      `${path}.bytes`,
      `bytes must be a positive integer <= ${MAX_ASSET_BYTES}`,
    );
    valid = false;
  } else {
    bytes = bytesValue;
  }

  let container: AssetContainer | null = null;
  const containerValue = value["container"];
  if (containerValue !== undefined) {
    if (!isAssetContainer(containerValue)) {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.container`,
        "container is not a known token",
      );
      valid = false;
    } else {
      container = containerValue;
      if (kind !== null && !KIND_CONTAINERS[kind].includes(container)) {
        issue(
          issues,
          "E_ASSET_FORMAT",
          `${path}.container`,
          `container ${container} is not allowed for kind ${kind}`,
        );
        valid = false;
      }
    }
  }

  if (url !== null) {
    if (container !== null && !urlMatchesContainer(url, container)) {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.url`,
        `url extension does not match container ${container}`,
      );
      valid = false;
    } else if (
      container === null &&
      kind !== null &&
      !urlMatchesKind(url, kind)
    ) {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.url`,
        `url extension does not match kind ${kind}`,
      );
      valid = false;
    }
    if (valid) {
      try {
        resolveAssetUrl(url, baseUrl);
      } catch (error) {
        issue(
          issues,
          "E_ASSET_FORMAT",
          `${path}.url`,
          error instanceof Error ? error.message : "url resolution failed",
        );
        valid = false;
      }
    }
  }

  let requires: readonly AssetCapability[] | undefined;
  const requiresValue = value["requires"];
  if (requiresValue !== undefined) {
    if (!Array.isArray(requiresValue)) {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.requires`,
        "requires must be an array",
      );
      valid = false;
    } else {
      const parsed: AssetCapability[] = [];
      const seen = new Set<string>();
      for (
        let index = 0;
        index < requiresValue.length;
        index += 1
      ) {
        const token = requiresValue[index];
        if (!isAssetCapability(token)) {
          issue(
            issues,
            "E_ASSET_FORMAT",
            `${path}.requires[${index}]`,
            "unknown capability token",
          );
          valid = false;
        } else if (seen.has(token)) {
          issue(
            issues,
            "E_ASSET_FORMAT",
            `${path}.requires[${index}]`,
            "duplicate capability token",
          );
          valid = false;
        } else {
          seen.add(token);
          parsed.push(token);
        }
      }
      requires = parsed;
    }
  }

  let format: AssetTextureFormat | undefined;
  const formatValue = value["format"];
  if (formatValue !== undefined) {
    if (!isAssetTextureFormat(formatValue)) {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.format`,
        "unknown texture format token",
      );
      valid = false;
    } else if (kind !== null && kind !== "texture") {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.format`,
        "format is allowed only on texture variants",
      );
      valid = false;
    } else {
      format = formatValue;
    }
  }

  let mimeType: AudioMimeType | undefined;
  const mimeValue = value["mimeType"];
  if (mimeValue !== undefined) {
    if (typeof mimeValue !== "string" || !AUDIO_MIME_SET.has(mimeValue)) {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.mimeType`,
        "unknown audio MIME type",
      );
      valid = false;
    } else if (kind !== null && kind !== "audio") {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.mimeType`,
        "mimeType is allowed only on audio variants",
      );
      valid = false;
    } else if (url !== null) {
      const expected = audioMimeForUrl(url);
      if (expected === undefined || expected !== mimeValue) {
        issue(
          issues,
          "E_ASSET_FORMAT",
          `${path}.mimeType`,
          "mimeType does not agree with the url extension",
        );
        valid = false;
      } else {
        mimeType = mimeValue as AudioMimeType;
      }
    } else {
      mimeType = mimeValue as AudioMimeType;
    }
  }

  let hash: string | undefined;
  const hashValue = value["hash"];
  if (hashValue !== undefined) {
    if (typeof hashValue !== "string" || !HASH_PATTERN.test(hashValue)) {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.hash`,
        "hash must match fnv1a32:[0-9a-f]{8}",
      );
      valid = false;
    } else {
      hash = hashValue;
    }
  }

  if (!valid || url === null || bytes === null) {
    return { valid: false, variant: null };
  }

  const variant: AssetVariant = {
    url,
    bytes,
    ...(requires !== undefined ? { requires } : {}),
    ...(container !== null ? { container } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(hash !== undefined ? { hash } : {}),
  };
  return { valid: true, variant };
}

interface EntryValidation {
  readonly valid: boolean;
  readonly parse: EntryParse | null;
}

function validateEntry(
  value: unknown,
  index: number,
  baseUrl: string,
  issues: ManifestIssue[],
): EntryValidation {
  const path = `assets[${index}]`;
  if (!isRecord(value)) {
    issue(issues, "E_ASSET_FORMAT", path, "asset entry must be an object");
    return { valid: false, parse: null };
  }

  let valid = true;

  const idValue = value["id"];
  let id: string | null = null;
  if (typeof idValue !== "string" || !isValidAssetId(idValue)) {
    issue(
      issues,
      "E_ASSET_FORMAT",
      `${path}.id`,
      "id must match ^[a-z0-9][a-z0-9/_.-]{0,127}$ with no dot segments",
    );
    valid = false;
  } else {
    id = idValue;
  }

  const kindValue = value["kind"];
  let kind: AssetKind | null = null;
  if (!isAssetKind(kindValue)) {
    issue(
      issues,
      "E_ASSET_FORMAT",
      `${path}.kind`,
      `kind must be one of: ${ASSET_KINDS.join(", ")}`,
    );
    valid = false;
  } else {
    kind = kindValue;
  }

  const urlValue = value["url"];
  let url: string | null = null;
  if (typeof urlValue !== "string") {
    issue(issues, "E_ASSET_FORMAT", `${path}.url`, "url is required");
    valid = false;
  } else {
    const reason = validateRelativeUrl(urlValue);
    if (reason !== null) {
      issue(issues, "E_ASSET_FORMAT", `${path}.url`, `url ${reason}`);
      valid = false;
    } else if (kind !== null && !urlMatchesKind(urlValue, kind)) {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.url`,
        `url extension does not match kind ${kind}`,
      );
      valid = false;
    } else {
      try {
        resolveAssetUrl(urlValue, baseUrl);
        url = urlValue;
      } catch (error) {
        issue(
          issues,
          "E_ASSET_FORMAT",
          `${path}.url`,
          error instanceof Error ? error.message : "url resolution failed",
        );
        valid = false;
      }
    }
  }

  const bytesValue = value["bytes"];
  let bytes: number | null = null;
  if (!isPositiveInteger(bytesValue) || bytesValue > MAX_ASSET_BYTES) {
    issue(
      issues,
      "E_ASSET_FORMAT",
      `${path}.bytes`,
      `bytes must be a positive integer <= ${MAX_ASSET_BYTES}`,
    );
    valid = false;
  } else {
    bytes = bytesValue;
  }

  let hash: string | undefined;
  const hashValue = value["hash"];
  if (hashValue !== undefined) {
    if (typeof hashValue !== "string" || !HASH_PATTERN.test(hashValue)) {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.hash`,
        "hash must match fnv1a32:[0-9a-f]{8}",
      );
      valid = false;
    } else {
      hash = hashValue;
    }
  }

  let initial: boolean | undefined;
  const initialValue = value["initial"];
  if (initialValue !== undefined) {
    if (typeof initialValue !== "boolean") {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.initial`,
        "initial must be a boolean",
      );
      valid = false;
    } else {
      initial = initialValue;
    }
  }

  let group: string | undefined;
  const groupValue = value["group"];
  if (groupValue !== undefined) {
    if (typeof groupValue !== "string" || !GROUP_PATTERN.test(groupValue)) {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.group`,
        "group must match ^[a-z0-9][a-z0-9-]{0,31}$",
      );
      valid = false;
    } else {
      group = groupValue;
    }
  }

  const dependencies: string[] = [];
  const dependenciesValue = value["dependencies"];
  if (dependenciesValue !== undefined) {
    if (!Array.isArray(dependenciesValue)) {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.dependencies`,
        "dependencies must be an array",
      );
      valid = false;
    } else if (dependenciesValue.length > MAX_DEPENDENCIES) {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.dependencies`,
        `dependencies must contain at most ${MAX_DEPENDENCIES} ids`,
      );
      valid = false;
    } else {
      const seen = new Set<string>();
      for (
        let dependencyIndex = 0;
        dependencyIndex < dependenciesValue.length;
        dependencyIndex += 1
      ) {
        const dependency = dependenciesValue[dependencyIndex];
        if (typeof dependency !== "string") {
          issue(
            issues,
            "E_ASSET_FORMAT",
            `${path}.dependencies[${dependencyIndex}]`,
            "dependency must be an id string",
          );
          valid = false;
        } else if (seen.has(dependency)) {
          issue(
            issues,
            "E_ASSET_FORMAT",
            `${path}.dependencies[${dependencyIndex}]`,
            "duplicate dependency",
          );
          valid = false;
        } else {
          seen.add(dependency);
          dependencies.push(dependency);
        }
      }
    }
  }

  let variants: AssetVariant[] | undefined;
  const variantsValue = value["variants"];
  if (variantsValue !== undefined) {
    if (!Array.isArray(variantsValue)) {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.variants`,
        "variants must be an array",
      );
      valid = false;
    } else if (variantsValue.length > MAX_VARIANTS) {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.variants`,
        `variants must contain at most ${MAX_VARIANTS} entries`,
      );
      valid = false;
    } else {
      const parsed: AssetVariant[] = [];
      for (
        let variantIndex = 0;
        variantIndex < variantsValue.length;
        variantIndex += 1
      ) {
        const result = validateVariant(
          variantsValue[variantIndex],
          `${path}.variants[${variantIndex}]`,
          kind,
          baseUrl,
          issues,
        );
        if (result.valid && result.variant !== null) {
          parsed.push(result.variant);
        } else {
          valid = false;
        }
      }
      variants = parsed;
    }
  }

  let streaming: boolean | undefined;
  const streamingValue = value["streaming"];
  if (streamingValue !== undefined) {
    if (typeof streamingValue !== "boolean") {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.streaming`,
        "streaming must be a boolean",
      );
      valid = false;
    } else if (kind !== null && kind !== "audio") {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.streaming`,
        "streaming is allowed only on audio entries",
      );
      valid = false;
    } else {
      streaming = streamingValue;
    }
  }

  let mimeType: AudioMimeType | undefined;
  const mimeValue = value["mimeType"];
  if (mimeValue !== undefined) {
    if (typeof mimeValue !== "string" || !AUDIO_MIME_SET.has(mimeValue)) {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.mimeType`,
        "unknown audio MIME type",
      );
      valid = false;
    } else if (kind !== null && kind !== "audio") {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.mimeType`,
        "mimeType is allowed only on audio entries",
      );
      valid = false;
    } else if (url !== null) {
      const expected = audioMimeForUrl(url);
      if (expected === undefined || expected !== mimeValue) {
        issue(
          issues,
          "E_ASSET_FORMAT",
          `${path}.mimeType`,
          "mimeType does not agree with the url extension",
        );
        valid = false;
      } else {
        mimeType = mimeValue as AudioMimeType;
      }
    } else {
      mimeType = mimeValue as AudioMimeType;
    }
  }

  let durationSeconds: number | undefined;
  const durationValue = value["durationSeconds"];
  if (durationValue !== undefined) {
    if (!isFinitePositive(durationValue)) {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.durationSeconds`,
        "durationSeconds must be a positive number",
      );
      valid = false;
    } else if (kind !== null && kind !== "audio") {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.durationSeconds`,
        "durationSeconds is allowed only on audio entries",
      );
      valid = false;
    } else {
      durationSeconds = durationValue;
    }
  }

  let meta: Record<string, string | number | boolean> | undefined;
  const metaValue = value["meta"];
  if (metaValue !== undefined) {
    if (!isRecord(metaValue)) {
      issue(
        issues,
        "E_ASSET_FORMAT",
        `${path}.meta`,
        "meta must be a flat object",
      );
      valid = false;
    } else {
      const keys = Object.keys(metaValue);
      if (keys.length > MAX_META_KEYS) {
        issue(
          issues,
          "E_ASSET_FORMAT",
          `${path}.meta`,
          `meta must contain at most ${MAX_META_KEYS} keys`,
        );
        valid = false;
      } else {
        const normalized: Record<string, string | number | boolean> =
          Object.create(null) as Record<string, string | number | boolean>;
        for (const key of keys) {
          const metaEntry = metaValue[key];
          if (
            typeof metaEntry !== "string" &&
            typeof metaEntry !== "number" &&
            typeof metaEntry !== "boolean"
          ) {
            issue(
              issues,
              "E_ASSET_FORMAT",
              `${path}.meta.${key}`,
              "meta values must be string, number or boolean",
            );
            valid = false;
          } else if (
            typeof metaEntry === "string" &&
            metaEntry.length > MAX_META_VALUE_CHARS
          ) {
            issue(
              issues,
              "E_ASSET_FORMAT",
              `${path}.meta.${key}`,
              `meta strings must be at most ${MAX_META_VALUE_CHARS} characters`,
            );
            valid = false;
          } else if (
            typeof metaEntry === "number" &&
            !Number.isFinite(metaEntry)
          ) {
            issue(
              issues,
              "E_ASSET_FORMAT",
              `${path}.meta.${key}`,
              "meta numbers must be finite",
            );
            valid = false;
          } else {
            normalized[key] = metaEntry;
          }
        }
        meta = normalized;
      }
    }
  }

  if (
    !valid ||
    id === null ||
    kind === null ||
    url === null ||
    bytes === null
  ) {
    return { valid: false, parse: null };
  }

  const entry: AssetManifestEntry = {
    id,
    kind,
    url,
    bytes,
    ...(hash !== undefined ? { hash } : {}),
    ...(initial !== undefined ? { initial } : {}),
    ...(group !== undefined ? { group } : {}),
    ...(dependencies.length > 0 ? { dependencies } : {}),
    ...(variants !== undefined ? { variants } : {}),
    ...(streaming !== undefined ? { streaming } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(meta !== undefined ? { meta } : {}),
  };

  return {
    valid: true,
    parse: {
      index,
      id,
      bytes,
      initial: initial === true,
      dependencies,
      entry,
    },
  };
}

/**
 * Validates a parsed manifest value. Returns every issue found so tooling can
 * report the whole manifest; the library throws the first issue.
 */
export function validateAssetManifest(
  input: unknown,
  options: ManifestValidationOptions = {},
): ManifestValidationResult {
  const issues: ManifestIssue[] = [];

  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(options.baseUrl ?? "./");
  } catch (error) {
    issue(
      issues,
      "E_ASSET_FORMAT",
      "baseUrl",
      error instanceof Error ? error.message : "base url is invalid",
    );
    baseUrl = normalizeBaseUrl("./");
  }
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  if (!isRecord(input)) {
    issue(issues, "E_ASSET_FORMAT", "", "manifest must be an object");
    return { ok: false, manifest: null, issues };
  }

  const formatVersion = input["formatVersion"];
  if (formatVersion !== ASSET_MANIFEST_VERSION) {
    issue(
      issues,
      "E_ASSET_FORMAT",
      "formatVersion",
      `formatVersion must be exactly ${ASSET_MANIFEST_VERSION}`,
    );
  }

  const manifestId = input["id"];
  if (typeof manifestId !== "string" || !GAME_ID_PATTERN.test(manifestId)) {
    issue(
      issues,
      "E_ASSET_FORMAT",
      "id",
      "manifest id must match ^[a-z0-9][a-z0-9._-]{0,63}$",
    );
  } else if (options.gameId !== undefined && manifestId !== options.gameId) {
    issue(
      issues,
      "E_ASSET_FORMAT",
      "id",
      `manifest id ${manifestId} does not equal options.gameId`,
    );
  }

  let budget: AssetManifestBudget | null = null;
  let budgetDeclaredOrderValid = false;
  const budgetValue = input["budget"];
  if (!isRecord(budgetValue)) {
    issue(issues, "E_ASSET_FORMAT", "budget", "budget is required");
  } else {
    const initialBytes = budgetValue["initialBytes"];
    const totalBytes = budgetValue["totalBytes"];
    let budgetValid = true;
    if (!isPositiveInteger(initialBytes)) {
      issue(
        issues,
        "E_ASSET_FORMAT",
        "budget.initialBytes",
        "initialBytes must be a positive integer",
      );
      budgetValid = false;
    }
    if (!isPositiveInteger(totalBytes)) {
      issue(
        issues,
        "E_ASSET_FORMAT",
        "budget.totalBytes",
        "totalBytes must be a positive integer",
      );
      budgetValid = false;
    }
    if (budgetValid) {
      budget = {
        initialBytes: initialBytes as number,
        totalBytes: totalBytes as number,
      };
      if (budget.totalBytes < budget.initialBytes) {
        issue(
          issues,
          "E_ASSET_FORMAT",
          "budget.totalBytes",
          "budget.totalBytes must be >= budget.initialBytes",
        );
      } else {
        budgetDeclaredOrderValid = true;
      }
    }
  }

  const assetsValue = input["assets"];
  const parses: EntryParse[] = [];
  const idToIndex = new Map<string, number>();

  if (!Array.isArray(assetsValue)) {
    issue(issues, "E_ASSET_FORMAT", "assets", "assets must be an array");
  } else if (assetsValue.length > MAX_MANIFEST_ASSETS) {
    issue(
      issues,
      "E_ASSET_FORMAT",
      "assets",
      `assets must contain at most ${MAX_MANIFEST_ASSETS} entries`,
    );
  } else {
    for (let index = 0; index < assetsValue.length; index += 1) {
      const result = validateEntry(assetsValue[index], index, baseUrl, issues);
      const parse = result.parse;
      if (parse === null) continue;
      if (idToIndex.has(parse.id)) {
        issue(
          issues,
          "E_ASSET_FORMAT",
          `assets[${index}].id`,
          `duplicate asset id ${parse.id}`,
        );
        continue;
      }
      idToIndex.set(parse.id, index);
      parses.push(parse);
    }
  }

  for (const parse of parses) {
    for (let index = 0; index < parse.dependencies.length; index += 1) {
      const dependency = parse.dependencies[index];
      if (dependency === undefined) continue;
      if (dependency === parse.id) {
        issue(
          issues,
          "E_ASSET_FORMAT",
          `assets[${parse.index}].dependencies[${index}]`,
          "an asset cannot depend on itself",
        );
      } else if (!idToIndex.has(dependency)) {
        issue(
          issues,
          "E_ASSET_FORMAT",
          `assets[${parse.index}].dependencies[${index}]`,
          `unknown dependency id ${dependency}`,
        );
      }
    }
  }

  const byId = new Map<string, EntryParse>();
  for (const parse of parses) byId.set(parse.id, parse);
  const visitState = new Map<string, 0 | 1 | 2>();
  // A holder object keeps TypeScript from narrowing the closure-written null
  // to `never` at the check below.
  const cycle: { source: EntryParse | null } = { source: null };
  const visit = (id: string): boolean => {
    const state = visitState.get(id) ?? 0;
    if (state === 1) return true;
    if (state === 2) return false;
    visitState.set(id, 1);
    const parse = byId.get(id);
    if (parse !== undefined) {
      for (const dependency of parse.dependencies) {
        const dependencyState = visitState.get(dependency) ?? 0;
        if (dependencyState === 1) {
          cycle.source = parse;
          return true;
        }
        if (dependencyState === 0 && visit(dependency)) return true;
      }
    }
    visitState.set(id, 2);
    return false;
  };
  for (const parse of parses) {
    if ((visitState.get(parse.id) ?? 0) === 0 && visit(parse.id)) break;
  }
  const cycleSource = cycle.source;
  if (cycleSource !== null) {
    issue(
      issues,
      "E_ASSET_FORMAT",
      `assets[${cycleSource.index}].dependencies`,
      "asset dependencies must be acyclic",
    );
  }

  let sumDefault = 0;
  let sumInitial = 0;
  for (const parse of parses) {
    sumDefault += parse.bytes;
    if (parse.initial) sumInitial += parse.bytes;
  }

  if (budget !== null && budgetDeclaredOrderValid) {
    if (budget.initialBytes > INITIAL_BUDGET_BYTES) {
      issue(
        issues,
        "E_ASSET_BUDGET",
        "budget.initialBytes",
        `initialBytes exceeds the ${INITIAL_BUDGET_BYTES}-byte boot budget`,
      );
    } else if (sumInitial > INITIAL_BUDGET_BYTES) {
      issue(
        issues,
        "E_ASSET_BUDGET",
        "budget.initialBytes",
        `initial asset bytes (${sumInitial}) exceed the ${INITIAL_BUDGET_BYTES}-byte boot budget`,
      );
    } else if (budget.initialBytes < sumInitial) {
      issue(
        issues,
        "E_ASSET_BUDGET",
        "budget.initialBytes",
        `initialBytes (${budget.initialBytes}) is below the initial asset sum (${sumInitial})`,
      );
    }

    if (budget.totalBytes > maxTotalBytes) {
      issue(
        issues,
        "E_ASSET_BUDGET",
        "budget.totalBytes",
        `totalBytes exceeds the engine ceiling of ${maxTotalBytes}`,
      );
    } else if (budget.totalBytes < sumDefault) {
      issue(
        issues,
        "E_ASSET_BUDGET",
        "budget.totalBytes",
        `totalBytes (${budget.totalBytes}) is below the declared asset sum (${sumDefault})`,
      );
    }
  }

  if (issues.length > 0) {
    return { ok: false, manifest: null, issues };
  }

  const manifest: AssetManifest = {
    formatVersion: ASSET_MANIFEST_VERSION,
    id: manifestId as string,
    budget: budget as AssetManifestBudget,
    assets: parses.map((parse) => parse.entry),
  };
  return { ok: true, manifest, issues };
}

/**
 * Validates and returns the manifest, or throws the first issue as an
 * `AssetEngineError`. Library construction uses this path.
 */
export function requireAssetManifest(
  input: unknown,
  options: ManifestValidationOptions = {},
): AssetManifest {
  const result = validateAssetManifest(input, options);
  const first = result.issues[0];
  if (!result.ok || result.manifest === null || first !== undefined) {
    const path = first === undefined ? "" : first.path;
    const message = first === undefined ? "manifest is invalid" : first.message;
    throw assetError(
      first?.code ?? "E_ASSET_FORMAT",
      path.length > 0 ? `${path}: ${message}` : message,
    );
  }
  return result.manifest;
}
