/**
 * ER-05-01: the pipeline key, the 24 precompiled defaults and the bounded
 * variant cache (05 §4.2). The fake records compile/link/delete calls; these
 * tests prove cache behaviour and key stability, not shader correctness.
 */

import { describe, expect, test } from "vitest";
import {
  DEFAULT_DEPTH_FORMAT,
  MAX_PIPELINES,
  PIPELINE_VARIANT_COUNT,
  PROGRAM_FORWARD_LIT_ID,
  PipelineCache,
  SWAPCHAIN_COLOR_FORMAT,
  defineMaskFor,
  fnv1a32,
  pipelineKey,
  pipelineVariantIndex,
  type CullMode,
  type PipelineKeyParts,
} from "../src/pipelineCache.js";
import { createStats } from "../src/stats.js";
import { StateCache } from "../src/state.js";
import {
  FRAME_UBO_BINDING,
  MATERIAL_UBO_BINDING,
} from "../src/shaders/forwardLit.js";
import { createFakeWebGL2 } from "./fake/webgl2.js";
import { errorCodeOf } from "./helpers.js";

const BASE_PARTS: PipelineKeyParts = {
  programId: PROGRAM_FORWARD_LIT_ID,
  colorFormat: SWAPCHAIN_COLOR_FORMAT,
  depthFormat: DEFAULT_DEPTH_FORMAT,
  blendMode: "opaque",
  depthTest: true,
  depthWrite: true,
  cullMode: "back",
  topology: "triangle-list",
  sampleCount: 1,
  vertexLayoutId: "static-pbr-v1",
  defineMask: 0,
};

function freshCache(): {
  cache: PipelineCache;
  fake: ReturnType<typeof createFakeWebGL2>["fake"];
  gl: ReturnType<typeof createFakeWebGL2>["gl"];
  stats: ReturnType<typeof createStats>;
} {
  const { gl, fake } = createFakeWebGL2();
  const stats = createStats();
  const cache = new PipelineCache(gl, new StateCache(gl), stats);
  return { cache, fake, gl, stats };
}

describe("[ER-05-01] pipeline keys and hashes", () => {
  test("[ER-05-01] the key string uses the frozen field order", () => {
    expect(pipelineKey(BASE_PARTS)).toBe(
      "pipeline/1|forward-lit|swapchain|depth24plus|opaque|1|1|back|triangle-list|1|static-pbr-v1|0",
    );
    expect(
      pipelineKey({
        ...BASE_PARTS,
        blendMode: "blend",
        depthTest: false,
        depthWrite: false,
        cullMode: "none",
        vertexLayoutId: "instanced-transform-v1",
        defineMask: 1,
      }),
    ).toBe(
      "pipeline/1|forward-lit|swapchain|depth24plus|blend|0|0|none|triangle-list|1|instanced-transform-v1|1",
    );
  });

  test("[ER-05-01] FNV-1a 32 matches the published vectors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  test("[ER-05-01] variant indices and define masks follow 05 §4.2", () => {
    expect(pipelineVariantIndex("static-pbr-v1", "opaque", false, false)).toBe(0);
    expect(pipelineVariantIndex("static-pbr-v1", "opaque", false, true)).toBe(1);
    expect(pipelineVariantIndex("static-pbr-v1", "opaque", true, false)).toBe(2);
    expect(pipelineVariantIndex("static-pbr-v1", "mask", false, false)).toBe(4);
    expect(pipelineVariantIndex("static-pbr-v1", "blend", true, true)).toBe(11);
    expect(pipelineVariantIndex("instanced-transform-v1", "opaque", false, false)).toBe(12);
    expect(pipelineVariantIndex("instanced-transform-v1", "mask", true, true)).toBe(19);

    expect(defineMaskFor("static-pbr-v1", "opaque", false)).toBe(0);
    expect(defineMaskFor("instanced-transform-v1", "opaque", false)).toBe(1);
    expect(defineMaskFor("static-pbr-v1", "mask", false)).toBe(2);
    expect(defineMaskFor("static-pbr-v1", "opaque", true)).toBe(4);
    expect(defineMaskFor("instanced-transform-v1", "mask", true)).toBe(7);
  });
});

describe("[ER-05-01] the precompiled default table", () => {
  test("[ER-05-01] construction builds 24 variants over 8 programs and 16 shaders", () => {
    const { cache, fake, stats } = freshCache();
    expect(cache.size).toBe(PIPELINE_VARIANT_COUNT);
    expect(cache.size).toBe(24);
    expect(fake.count("createShader")).toBe(16);
    expect(fake.count("createProgram")).toBe(8);
    expect(fake.count("getUniformLocation")).toBe(12);
    expect(stats.pipelinesCreated).toBe(24);
    expect(stats.shaderModulesCreated).toBe(16);
  });

  test("[ER-05-01] every variant slot resolves and out-of-range slots do not", () => {
    const { cache } = freshCache();
    for (let variant = 0; variant < PIPELINE_VARIANT_COUNT; variant += 1) {
      const record = cache.defaultPipeline(variant);
      expect(record).not.toBeNull();
      expect(record?.variant).toBe(variant);
    }
    expect(cache.defaultPipeline(-1)).toBeNull();
    expect(cache.defaultPipeline(PIPELINE_VARIANT_COUNT)).toBeNull();
  });

  test("[ER-05-01] default records expose the expected layout and locations", () => {
    const { cache } = freshCache();
    expect(cache.defaultPipeline(0)).toMatchObject({
      layout: "static-pbr-v1",
      alphaMode: "opaque",
      unlit: false,
      doubleSided: false,
      depthTest: true,
      depthWrite: true,
      cullMode: "back",
    });
    expect(cache.defaultPipeline(0)?.uModelLocation).not.toBeNull();
    expect(cache.defaultPipeline(1)?.cullMode).toBe("none");
    expect(cache.defaultPipeline(2)?.unlit).toBe(true);
    expect(cache.defaultPipeline(8)?.alphaMode).toBe("blend");
    expect(cache.defaultPipeline(12)?.layout).toBe("instanced-transform-v1");
    expect(cache.defaultPipeline(12)?.uModelLocation).toBeNull();
  });

  test("[ER-05-01] every program associates FrameBlock with 0 and MaterialBlock with 1", () => {
    const { fake } = freshCache();
    const indexCalls = fake.callsNamed("getUniformBlockIndex");
    expect(indexCalls).toHaveLength(16);
    expect(fake.count("uniformBlockBinding")).toBe(16);

    const framePrograms = new Set<unknown>();
    const materialPrograms = new Set<unknown>();
    for (const call of indexCalls) {
      const blockName = call.args[1];
      if (blockName === "FrameBlock") framePrograms.add(call.args[0]);
      if (blockName === "MaterialBlock") materialPrograms.add(call.args[0]);
    }
    expect(framePrograms.size).toBe(8);
    expect(materialPrograms.size).toBe(8);

    const boundPrograms = new Set<unknown>();
    const bindingsPerIndex = new Map<number, number>();
    for (const call of fake.callsNamed("uniformBlockBinding")) {
      const blockIndex = call.args[1];
      const binding = call.args[2];
      if (blockIndex === 0) expect(binding).toBe(FRAME_UBO_BINDING);
      else if (blockIndex === 1) expect(binding).toBe(MATERIAL_UBO_BINDING);
      else throw new Error(`Unexpected uniform block index ${String(blockIndex)}`);
      boundPrograms.add(call.args[0]);
      bindingsPerIndex.set(
        Number(binding),
        (bindingsPerIndex.get(Number(binding)) ?? 0) + 1,
      );
    }
    expect(boundPrograms.size).toBe(8);
    expect(bindingsPerIndex.get(FRAME_UBO_BINDING)).toBe(8);
    expect(bindingsPerIndex.get(MATERIAL_UBO_BINDING)).toBe(8);
    expect(FRAME_UBO_BINDING).not.toBe(MATERIAL_UBO_BINDING);
  });

  test("[ER-05-01] the default key equals keyFor for the same fields", () => {
    const { cache } = freshCache();
    expect(cache.defaultPipeline(0)?.key).toBe(
      cache.keyFor("static-pbr-v1", "opaque", false, false, true, true),
    );
    expect(cache.defaultPipeline(8)?.key).toBe(
      cache.keyFor("static-pbr-v1", "blend", false, false, true, false),
    );
  });
});

describe("[ER-05-01] lazy pipeline cache", () => {
  test("[ER-05-01] a default descriptor is a cache hit, not a new pipeline", () => {
    const { cache, stats } = freshCache();
    const record = cache.ensure(BASE_PARTS);
    expect(record).not.toBeNull();
    expect(record?.key).toBe(pipelineKey(BASE_PARTS));
    expect(cache.size).toBe(24);
    expect(stats.pipelineCacheHits).toBe(1);
    expect(stats.pipelinesCreated).toBe(24);
  });

  test("[ER-05-01] a supported non-default descriptor is created once and reused", () => {
    const { cache, stats } = freshCache();
    const custom = { ...BASE_PARTS, depthTest: false };
    const first = cache.ensure(custom);
    const second = cache.ensure(custom);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(cache.size).toBe(25);
    expect(stats.pipelinesCreated).toBe(25);
    expect(stats.pipelineMisses).toBe(1);
    expect(stats.pipelineCacheHits).toBe(1);
  });

  test("[ER-05-01] contracts outside the M0 subset return null", () => {
    const { cache } = freshCache();
    const unsupported: ReadonlyArray<Partial<PipelineKeyParts>> = [
      { programId: "other" },
      { colorFormat: "rgba8unorm" },
      { depthFormat: "depth32float" },
      { topology: "indexed" },
      { sampleCount: 4 },
      { vertexLayoutId: "skinned-pbr-v1" },
      { blendMode: "additive" },
      { defineMask: 99 },
    ];
    for (const override of unsupported) {
      expect(cache.ensure({ ...BASE_PARTS, ...override })).toBeNull();
    }
    expect(cache.size).toBe(24);
  });

  test("[ER-05-01] the cache stops at 128 pipelines and refuses new keys", () => {
    const { cache, stats } = freshCache();
    const masks = [0, 1, 2, 3, 4, 5, 6, 7] as const;
    const blendModes = ["opaque", "mask", "blend"] as const;
    const flags = [true, false] as const;
    const culls: readonly CullMode[] = ["back", "front", "none"];
    let created = 0;
    let refused = 0;
    for (const defineMask of masks) {
      for (const blendMode of blendModes) {
        for (const depthTest of flags) {
          for (const depthWrite of flags) {
            for (const cullMode of culls) {
              const record = cache.ensure({
                ...BASE_PARTS,
                defineMask,
                blendMode,
                depthTest,
                depthWrite,
                cullMode,
              });
              if (record === null) {
                refused += 1;
              } else {
                created += 1;
              }
            }
          }
        }
      }
    }
    expect(cache.size).toBe(MAX_PIPELINES);
    // 12 of the 24 defaults are static-layout variants reachable from this loop.
    expect(created).toBe(MAX_PIPELINES - 12);
    expect(refused).toBeGreaterThan(0);
    expect(stats.pipelineMisses).toBeGreaterThan(0);
  });

  test("[ER-05-01] dispose deletes every program and clears the defaults", () => {
    const { cache, fake } = freshCache();
    cache.dispose();
    expect(fake.count("deleteProgram")).toBe(8);
    expect(cache.size).toBe(0);
    expect(cache.defaultPipeline(0)).toBeNull();
  });
});

describe("[ER-05-01] compile failures", () => {
  test("[ER-05-01] a failed shader compile surfaces E_PIPELINE_COMPILE", () => {
    const { gl, fake } = createFakeWebGL2();
    fake.shaderCompiles = false;
    expect(
      errorCodeOf(() => new PipelineCache(gl, new StateCache(gl), createStats())),
    ).toBe("E_PIPELINE_COMPILE");
    expect(fake.count("createProgram")).toBe(0);
    expect(fake.count("deleteShader")).toBe(1);
  });

  test("[ER-05-01] a failed program link surfaces E_PIPELINE_COMPILE", () => {
    const { gl, fake } = createFakeWebGL2();
    fake.programLinks = false;
    expect(
      errorCodeOf(() => new PipelineCache(gl, new StateCache(gl), createStats())),
    ).toBe("E_PIPELINE_COMPILE");
    expect(fake.count("createProgram")).toBe(1);
    expect(fake.count("deleteProgram")).toBe(1);
  });
});
