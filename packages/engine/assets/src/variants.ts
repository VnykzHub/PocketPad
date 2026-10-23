/**
 * Deterministic variant selection (06 §3.6, §5.4).
 *
 * The first qualifying variant in manifest order wins; the entry's own URL is
 * the default. `quality` narrows the capability set (low drops every
 * compressed-* token) but never changes the scan order.
 */

import type {
  AssetCapability,
  AssetContainer,
  AssetManifestEntry,
  AssetTextureFormat,
  AssetVariant,
  AudioMimeType,
} from "./contracts/assets.js";
import { assetError } from "./errors.js";
import {
  audioMimeForUrl,
  containerForUrl,
  urlMatchesKind,
} from "./manifest.js";

export type AssetQuality = "low" | "medium" | "high";

export interface SelectedAssetSource {
  readonly url: string;
  readonly bytes: number;
  readonly container: AssetContainer | undefined;
  readonly format: AssetTextureFormat | undefined;
  readonly mimeType: AudioMimeType | undefined;
  readonly hash: string | undefined;
  /** "default" when the entry URL is used; otherwise the variant index. */
  readonly variantIndex: number;
  readonly requires: readonly AssetCapability[];
}

const FORMAT_CAPABILITY: Readonly<
  Record<AssetTextureFormat, AssetCapability | null>
> = {
  rgba8unorm: null,
  "rgba8unorm-srgb": null,
  "bc1-rgba-unorm": "compressed-s3tc",
  "bc1-rgba-unorm-srgb": "compressed-s3tc",
  "bc3-rgba-unorm": "compressed-s3tc",
  "bc3-rgba-unorm-srgb": "compressed-s3tc",
  "bc7-rgba-unorm": "compressed-s3tc",
  "bc7-rgba-unorm-srgb": "compressed-s3tc",
  "etc2-rgba8unorm": "compressed-etc2",
  "etc2-rgba8unorm-srgb": "compressed-etc2",
  "astc-4x4-unorm": "compressed-astc",
  "astc-4x4-unorm-srgb": "compressed-astc",
};

/** Capability a texture format needs beyond what the manifest lists. */
export function formatCapability(
  format: AssetTextureFormat,
): AssetCapability | null {
  return FORMAT_CAPABILITY[format];
}

/** Kinds with a decoder in M0. scene/animation validate but cannot load. */
export function isKindSupportedInM0(kind: AssetManifestEntry["kind"]): boolean {
  return kind !== "scene" && kind !== "animation";
}

function effectiveCapability(
  capabilities: ReadonlySet<AssetCapability>,
  capability: AssetCapability,
  quality: AssetQuality,
): boolean {
  if (quality === "low" && capability.startsWith("compressed-")) return false;
  return capabilities.has(capability);
}

function variantQualifies(
  variant: AssetVariant,
  entry: AssetManifestEntry,
  capabilities: ReadonlySet<AssetCapability>,
  quality: AssetQuality,
): boolean {
  const required = variant.requires ?? [];
  for (const capability of required) {
    if (!effectiveCapability(capabilities, capability, quality)) return false;
  }

  let container = variant.container;
  if (container === undefined) {
    container = containerForUrl(variant.url);
  }
  if (container === undefined) return false;

  // A variant must stay in the same kind family as its entry.
  if (!urlMatchesKind(variant.url, entry.kind)) return false;

  if (entry.kind === "texture") {
    if (variant.format === undefined) {
      // Uncompressed variants may omit a token; the header decides at decode.
      return container === "webp" || container === "png";
    }
    const capability = formatCapability(variant.format);
    if (
      capability !== null &&
      !effectiveCapability(capabilities, capability, quality)
    ) {
      return false;
    }
    return true;
  }

  if (entry.kind === "audio" && variant.mimeType !== undefined) {
    const expected = audioMimeForUrl(variant.url);
    if (expected === undefined || expected !== variant.mimeType) return false;
  }
  return true;
}

function defaultContainer(entry: AssetManifestEntry): AssetContainer | undefined {
  return containerForUrl(entry.url);
}

/**
 * Selects the URL/bytes/container the loader must fetch.
 *
 * Throws `E_ASSET_UNSUPPORTED` for a compressed KTX2 used as the default
 * texture URL (Tier B cannot load it) and for scene/animation in M0.
 * Throws `E_ASSET_FORMAT` when a URL/container cannot be identified.
 */
export function selectVariant(
  entry: AssetManifestEntry,
  capabilities: ReadonlySet<AssetCapability> = new Set<AssetCapability>(),
  quality: AssetQuality = "high",
): SelectedAssetSource {
  if (!isKindSupportedInM0(entry.kind)) {
    throw assetError(
      "E_ASSET_UNSUPPORTED",
      `${entry.id}: kind ${entry.kind} is not implemented in M0`,
      entry.id,
    );
  }

  const variants = entry.variants ?? [];
  for (let index = 0; index < variants.length; index += 1) {
    const variant = variants[index];
    if (variant === undefined) continue;
    if (!variantQualifies(variant, entry, capabilities, quality)) continue;
    const container = variant.container ?? containerForUrl(variant.url);
    return {
      url: variant.url,
      bytes: variant.bytes,
      container,
      format: variant.format,
      mimeType: variant.mimeType ?? audioMimeForUrl(variant.url),
      hash: variant.hash ?? entry.hash,
      variantIndex: index,
      requires: variant.requires ?? [],
    };
  }

  const container = defaultContainer(entry);
  if (entry.kind === "texture" && container === "ktx2") {
    throw assetError(
      "E_ASSET_UNSUPPORTED",
      `${entry.id}: a compressed KTX2 default cannot be loaded on every device`,
      entry.id,
    );
  }
  if (
    container === undefined &&
    (entry.kind === "mesh" || entry.kind === "texture" || entry.kind === "audio")
  ) {
    throw assetError(
      "E_ASSET_FORMAT",
      `${entry.id}: no container can be inferred from the url`,
      entry.id,
    );
  }

  const mimeType = entry.mimeType ?? audioMimeForUrl(entry.url);
  if (entry.kind === "audio" && mimeType === undefined) {
    throw assetError(
      "E_ASSET_FORMAT",
      `${entry.id}: audio url has no recognized container`,
      entry.id,
    );
  }

  return {
    url: entry.url,
    bytes: entry.bytes,
    container,
    format: undefined,
    mimeType,
    hash: entry.hash,
    variantIndex: -1,
    requires: [],
  };
}
