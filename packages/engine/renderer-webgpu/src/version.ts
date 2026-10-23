/**
 * Runtime constants owned by spec 04 that `@lanpad/engine-core` does not
 * already export.
 *
 * `RENDERER_ABI_VERSION` and `SHADER_ABI_VERSION` live in
 * `@lanpad/engine-core` and are re-used from there; they are deliberately not
 * duplicated. A constant 04 owns but does not name (for example a
 * `WEBGPU_BACKEND_VERSION`) is omitted until the spec names it.
 */

/**
 * Pipeline cache key canonicalisation version (04 §4.1). Changing the
 * canonical key encoding is a bump; the value is part of every pipeline key.
 */
export const PIPELINE_CACHE_VERSION = 1 as const;
