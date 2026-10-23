/**
 * Runtime version constants for `@lanpad/engine-assets` (06 §3.5, §4.1).
 *
 * The matching declarations live in `src/contracts/assets.d.ts`; the values
 * here are the single runtime source of truth and must agree with them.
 */

/** 06 §4.1. Breaking required-field or semantic manifest change. */
export const ASSET_MANIFEST_VERSION = 1 as const;

/** 06 §4.1. New required vertex attribute, index rule or compression requirement. */
export const MESH_FORMAT_VERSION = 1 as const;

/** 06 §4.1. New texture container, level layout or colour-space rule. */
export const TEXTURE_ASSET_FORMAT_VERSION = 1 as const;

/** 06 §4.1. Breaking material field change. */
export const MATERIAL_FORMAT_VERSION = 1 as const;

/** 06 §4.1. Persistent cache-key or storage-layout change (M1). */
export const ASSET_CACHE_VERSION = 1 as const;
