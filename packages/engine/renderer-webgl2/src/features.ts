/**
 * `EngineFeature` refusal rules and fixed copy (05 §3.4).
 *
 * The feature vocabulary is the frozen core union; this module only maps it to
 * Tier B behaviour and sentences. It never declares a second feature union.
 */

import type { EngineFeature } from "@lanpad/engine-core";

const SENTENCES: Readonly<Record<EngineFeature, string>> = {
  compute:
    "This game needs WebGPU compute, which this browser does not provide. It can run on a WebGPU-capable desktop browser.",
  "storage-buffers":
    "This game needs GPU storage buffers, which WebGL2 does not provide.",
  "timestamp-query":
    "This game requires GPU timing queries, which this device does not expose.",
  "float-render-target":
    "This game needs HDR rendering, which this device's WebGL2 cannot provide.",
  "texture-array": "This game requires texture arrays, which this device does not provide.",
  msaa4:
    "This game requires 4× anti-aliasing, which this device's WebGL2 cannot provide.",
  "compressed-astc":
    "This game requires a compressed texture format this device does not support.",
  "compressed-etc2":
    "This game requires a compressed texture format this device does not support.",
  "compressed-s3tc":
    "This game requires a compressed texture format this device does not support.",
};

/** Features the game requires that the device lacks, in declaration order. */
export function missingFeatures(
  required: readonly EngineFeature[],
  available: ReadonlySet<EngineFeature>,
): EngineFeature[] {
  const missing: EngineFeature[] = [];
  const seen = new Set<EngineFeature>();
  for (let index = 0; index < required.length; index += 1) {
    const feature = required[index];
    if (feature === undefined || available.has(feature) || seen.has(feature)) continue;
    seen.add(feature);
    missing.push(feature);
  }
  return missing;
}

/** Fixed failure sentence for one missing feature (05 §3.4). */
export function describeMissingFeature(feature: EngineFeature): string {
  return SENTENCES[feature];
}
