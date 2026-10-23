/**
 * Runtime version constants for `@lanpad/engine-core`.
 *
 * The matching declarations live in `src/contracts/engine.d.ts` and
 * `src/contracts/render-device.d.ts`. The contract files declare the types;
 * this module is the single runtime source of truth and the values must agree.
 */

/** Lockstep version for every `@lanpad/engine-*` package (00 §4.1). */
export const ENGINE_VERSION = "0.1.0" as const;

/** Renderer ABI 1 (04 §4.1). Any change invalidates the pipeline cache. */
export const RENDERER_ABI_VERSION = 1 as const;

/** Built-in shader ABI 1 (04 §4.1). Part of every shader cache key. */
export const SHADER_ABI_VERSION = 1 as const;
