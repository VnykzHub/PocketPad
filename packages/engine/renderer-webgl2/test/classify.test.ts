/**
 * ER-05-05: deterministic, monotone tier classification against
 * `test/fixtures/capability-cases.json`. The fixture is synthetic; these tests
 * prove the pure function, not any device capability.
 */

import { describe, expect, test } from "vitest";
import type { EngineFeature } from "@lanpad/engine-core";
import { COMPRESSED_FAMILY_EXTENSIONS, EXT, classifyWebGL2 } from "../src/classify.js";
import type { WebGL2Limits } from "../src/contracts/webgl2.js";
import { readFixture } from "./helpers.js";

interface CapabilityCase {
  readonly id: string;
  readonly limits: WebGL2Limits;
  readonly extensions: readonly string[];
  readonly expected: {
    readonly tier: "extended" | "standard" | "minimal";
    readonly features: readonly EngineFeature[];
  };
}

interface CapabilityFixture {
  readonly schema: string;
  readonly cases: readonly CapabilityCase[];
}

const FIXTURE = readFixture<CapabilityFixture>("capability-cases.json");
const TIER_RANK = { minimal: 0, standard: 1, extended: 2 } as const;

function sortedFeatures(features: ReadonlySet<EngineFeature>): string[] {
  return [...features].sort();
}

function raisedLimits(limits: WebGL2Limits): WebGL2Limits {
  const raised: Record<string, number> = {};
  for (const [key, value] of Object.entries(limits)) {
    raised[key] = value * 4;
  }
  return raised as unknown as WebGL2Limits;
}

describe("[ER-05-05] WebGL2 tier classification", () => {
  for (const fixtureCase of FIXTURE.cases) {
    test(`[ER-05-05] ${fixtureCase.id} classifies as ${fixtureCase.expected.tier} with the exact feature set`, () => {
      const result = classifyWebGL2({
        limits: fixtureCase.limits,
        extensions: fixtureCase.extensions,
      });
      expect(result.tier).toBe(fixtureCase.expected.tier);
      expect(sortedFeatures(result.features)).toEqual(
        [...fixtureCase.expected.features].sort(),
      );
    });
  }

  test("[ER-05-05] classification is deterministic for identical inputs", () => {
    for (const fixtureCase of FIXTURE.cases) {
      const first = classifyWebGL2({
        limits: { ...fixtureCase.limits },
        extensions: [...fixtureCase.extensions],
      });
      const second = classifyWebGL2({
        limits: { ...fixtureCase.limits },
        extensions: [...fixtureCase.extensions],
      });
      expect(second.tier).toBe(first.tier);
      expect(sortedFeatures(second.features)).toEqual(sortedFeatures(first.features));
    }
  });

  test("[ER-05-05] adding any extension can never lower the tier or remove a feature", () => {
    const extras = [
      ...COMPRESSED_FAMILY_EXTENSIONS,
      EXT.floatColorBuffer,
      EXT.floatLinear,
      EXT.timerQuery,
      EXT.anisotropy,
    ];
    for (const fixtureCase of FIXTURE.cases) {
      const base = classifyWebGL2({
        limits: fixtureCase.limits,
        extensions: fixtureCase.extensions,
      });
      for (const extra of extras) {
        if (fixtureCase.extensions.includes(extra)) continue;
        const next = classifyWebGL2({
          limits: fixtureCase.limits,
          extensions: [...fixtureCase.extensions, extra],
        });
        expect(TIER_RANK[next.tier]).toBeGreaterThanOrEqual(TIER_RANK[base.tier]);
        for (const feature of base.features) {
          expect(next.features.has(feature)).toBe(true);
        }
      }
    }
  });

  test("[ER-05-05] raising every limit can never lower the tier", () => {
    for (const fixtureCase of FIXTURE.cases) {
      const base = classifyWebGL2({
        limits: fixtureCase.limits,
        extensions: fixtureCase.extensions,
      });
      const raised = classifyWebGL2({
        limits: raisedLimits(fixtureCase.limits),
        extensions: fixtureCase.extensions,
      });
      expect(TIER_RANK[raised.tier]).toBeGreaterThanOrEqual(TIER_RANK[base.tier]);
      for (const feature of base.features) {
        expect(raised.features.has(feature)).toBe(true);
      }
    }
  });

  test("[ER-05-05] a minimal tier still reports texture-array support", () => {
    const minimalCases = FIXTURE.cases.filter((item) => item.expected.tier === "minimal");
    expect(minimalCases.length).toBeGreaterThan(0);
    for (const fixtureCase of minimalCases) {
      const result = classifyWebGL2({
        limits: fixtureCase.limits,
        extensions: fixtureCase.extensions,
      });
      expect(result.features.has("texture-array")).toBe(true);
    }
  });

  test("[ER-05-05] Tier B never reports compute or storage-buffers", () => {
    for (const fixtureCase of FIXTURE.cases) {
      const result = classifyWebGL2({
        limits: fixtureCase.limits,
        extensions: [...fixtureCase.extensions, ...COMPRESSED_FAMILY_EXTENSIONS],
      });
      expect(result.features.has("compute")).toBe(false);
      expect(result.features.has("storage-buffers")).toBe(false);
    }
  });

  test("[ER-05-05] extension names are the frozen WebGL2 strings", () => {
    expect(EXT).toEqual({
      floatColorBuffer: "EXT_color_buffer_float",
      floatLinear: "OES_texture_float_linear",
      timerQuery: "EXT_disjoint_timer_query_webgl2",
      astc: "WEBGL_compressed_texture_astc",
      etc: "WEBGL_compressed_texture_etc",
      s3tc: "WEBGL_compressed_texture_s3tc",
      bptc: "EXT_texture_compression_bptc",
      anisotropy: "EXT_texture_filter_anisotropic",
      parallelCompile: "KHR_parallel_shader_compile",
      loseContext: "WEBGL_lose_context",
      debugRenderer: "WEBGL_debug_renderer_info",
    });
    expect(COMPRESSED_FAMILY_EXTENSIONS).toEqual([
      EXT.astc,
      EXT.etc,
      EXT.s3tc,
      EXT.bptc,
    ]);
  });
});
