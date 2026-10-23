/**
 * `@lanpad/engine-assets` public entry.
 *
 * The frozen contract surface (06 §3) is re-exported unchanged. The values
 * below are the additive W1 implementation: manifest validation, the asset
 * library factory and the asset-layer error type.
 */

export type * from "./contracts/assets.js";

export {
  ASSET_CACHE_VERSION,
  ASSET_MANIFEST_VERSION,
  MATERIAL_FORMAT_VERSION,
  MESH_FORMAT_VERSION,
  TEXTURE_ASSET_FORMAT_VERSION,
} from "./version.js";

export { AssetEngineError, isRetryableAssetCode } from "./errors.js";

export { createAssetLibrary } from "./library.js";

export {
  requireAssetManifest,
  validateAssetManifest,
  type ManifestIssue,
  type ManifestValidationOptions,
  type ManifestValidationResult,
} from "./manifest.js";
