/**
 * Runtime constants owned by spec 05 that `@lanpad/engine-core` does not own.
 *
 * The matching declaration is `WebGL2DesignCaps` in
 * `src/contracts/webgl2.d.ts`; both must agree. Renderer ABI constants
 * (`RENDERER_ABI_VERSION`, `SHADER_ABI_VERSION`) stay in `engine-core` and are
 * not redefined here.
 */

import type { WebGL2DesignCaps } from "./contracts/webgl2.js";

/**
 * Fixed design caps (05 §4.5), derived from WebGL2 minimums. They are design
 * budgets, not device measurements.
 */
export const WEBGL2_DESIGN_CAPS = {
  maxBones: 256,
  maxDirectionalLights: 4,
  maxPointLights: 8,
  maxShadowMaps: 1,
} as const satisfies WebGL2DesignCaps;
