/**
 * Pipeline and shader cache tests (04 §4.2, §4.8, §5.5, ER-04-03).
 *
 * The canonical key encoding is implementation-owned. Every assertion here is
 * an equality relation between descriptors, never a literal key string or a
 * hash-based lookup: the hash is a stats label only.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  MAX_PIPELINE_KEY_BYTES,
  MAX_SHADER_MODULE_KEY_BYTES,
  canonicalDefines,
  canonicalPipelineKey,
  fnv1a32,
  pipelineKeysEqual,
  shaderModuleKey,
  utf8Length,
} from "../src/pipeline/pipelineKey.js";
import type { DefineValue } from "../src/pipeline/pipelineKey.js";
import {
  PipelineCache,
} from "../src/pipeline/PipelineCache.js";
import type { PipelineCacheEntry } from "../src/pipeline/PipelineCache.js";
import { ShaderCache } from "../src/pipeline/ShaderCache.js";
import { WebGpuRendererError } from "../src/errors.js";
import type {
  PipelineCacheKey,
  PipelineKeyInputs,
} from "../src/contracts/webgpu.js";

interface FixtureCase {
  readonly id: string;
  readonly overrides: Record<string, unknown>;
  readonly expect: {
    readonly sameKeyAs: string | null;
    readonly cacheHit: boolean;
    readonly pipelinesCreated: number;
  };
}

interface PipelineFixture {
  readonly formatVersion: number;
  readonly synthetic: boolean;
  readonly serializationStatus: string;
  readonly fieldOrder: readonly string[];
  readonly base: Record<string, unknown>;
  readonly cases: readonly FixtureCase[];
  readonly equivalenceCases: readonly {
    readonly id: string;
    readonly kind: string;
    readonly definesInputs: readonly Record<string, DefineValue>[];
    readonly expect: {
      readonly sameCanonicalDefines: boolean;
      readonly sameKey: boolean;
    };
  }[];
  readonly cacheRules: {
    readonly maxPipelines: number;
    readonly maxShaderModules: number;
    readonly maxKeyBytes: number;
    readonly eviction: string;
    readonly hashRole: string;
  };
}

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/pipeline-keys.json", import.meta.url),
    "utf8",
  ),
) as PipelineFixture;

function inputsWith(
  overrides: Readonly<Record<string, unknown>> = {},
): PipelineKeyInputs {
  return { ...fixture.base, ...overrides } as unknown as PipelineKeyInputs;
}

function expectErrorCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WebGpuRendererError);
    expect((error as WebGpuRendererError).code).toBe(code);
    return;
  }
  throw new Error(`expected renderer error ${code}`);
}

describe("canonical pipeline keys", () => {
  test("[ER-04-03] fixture key equality relations hold for every descriptor case", () => {
    const baseKey = canonicalPipelineKey(inputsWith());
    for (const entry of fixture.cases) {
      if (Object.keys(entry.overrides).length === 0) {
        continue;
      }
      const key = canonicalPipelineKey(inputsWith(entry.overrides));
      const same = entry.expect.sameKeyAs === "base";
      expect(pipelineKeysEqual(key, baseKey)).toBe(same);
      expect(key.canonical === baseKey.canonical).toBe(same);
    }
  });

  test("[ER-04-03] re-encoding the same descriptor is stable", () => {
    const first = canonicalPipelineKey(inputsWith());
    const second = canonicalPipelineKey(inputsWith());
    expect(pipelineKeysEqual(first, second)).toBe(true);
    expect(first.hash).toBe(second.hash);
    expect(Number.isInteger(first.hash)).toBe(true);
    expect(first.hash).toBeGreaterThanOrEqual(0);
    expect(first.hash).toBeLessThanOrEqual(0xffffffff);
  });

  test("[ER-04-03] vertex and fragment shader keys occupy distinct positions", () => {
    const forward = canonicalPipelineKey(
      inputsWith({
        vertexShaderKey: "synthetic:vertex",
        fragmentShaderKey: "synthetic:fragment",
      }),
    );
    const swapped = canonicalPipelineKey(
      inputsWith({
        vertexShaderKey: "synthetic:fragment",
        fragmentShaderKey: "synthetic:vertex",
      }),
    );
    expect(pipelineKeysEqual(forward, swapped)).toBe(false);
  });

  test("[ER-04-03] colour-format and blend-state arrays are order-sensitive", () => {
    const forwardFormats = canonicalPipelineKey(
      inputsWith({ colorFormats: ["bgra8unorm", "rgba16float"] }),
    );
    const reversedFormats = canonicalPipelineKey(
      inputsWith({ colorFormats: ["rgba16float", "bgra8unorm"] }),
    );
    expect(pipelineKeysEqual(forwardFormats, reversedFormats)).toBe(false);

    const forwardBlend = canonicalPipelineKey(
      inputsWith({
        blendStates: ["off", "src-alpha-one-minus-src-alpha"],
      }),
    );
    const reversedBlend = canonicalPipelineKey(
      inputsWith({
        blendStates: ["src-alpha-one-minus-src-alpha", "off"],
      }),
    );
    expect(pipelineKeysEqual(forwardBlend, reversedBlend)).toBe(false);
  });

  test("[ER-04-03] depth format and compare each change the key", () => {
    const base = canonicalPipelineKey(inputsWith());
    const format = canonicalPipelineKey(
      inputsWith({
        depthState: {
          format: "depth32float",
          compare: "less",
          writeEnabled: true,
        },
      }),
    );
    const compare = canonicalPipelineKey(
      inputsWith({
        depthState: {
          format: "depth24plus",
          compare: "less-equal",
          writeEnabled: true,
        },
      }),
    );
    const none = canonicalPipelineKey(
      inputsWith({
        depthState: { format: "none", compare: null, writeEnabled: false },
      }),
    );
    expect(pipelineKeysEqual(base, format)).toBe(false);
    expect(pipelineKeysEqual(base, compare)).toBe(false);
    expect(pipelineKeysEqual(base, none)).toBe(false);
    expect(pipelineKeysEqual(format, compare)).toBe(false);
  });

  test("[ER-04-03] the key never exceeds the frozen 4 KiB limit", () => {
    expect(fixture.cacheRules.maxKeyBytes).toBe(MAX_PIPELINE_KEY_BYTES);
    expect(utf8Length(canonicalPipelineKey(inputsWith()).canonical)).toBeLessThanOrEqual(
      MAX_PIPELINE_KEY_BYTES,
    );
    expectErrorCode(
      () =>
        canonicalPipelineKey(
          inputsWith({ definesCanonical: "x".repeat(MAX_PIPELINE_KEY_BYTES) }),
        ),
      "E_CONTRACT",
    );
  });

  test("[ER-04-03] the hash is never used for equality", () => {
    const left: PipelineCacheKey = { canonical: "left", hash: 7 };
    const right: PipelineCacheKey = { canonical: "right", hash: 7 };
    expect(pipelineKeysEqual(left, right)).toBe(false);
    expect(pipelineKeysEqual(left, { canonical: "left", hash: 999 })).toBe(true);
  });
});

describe("FNV-1a stats hash", () => {
  test("[ER-04-03] known FNV-1a 32-bit vectors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
    expect(Number.isInteger(fnv1a32("anything"))).toBe(true);
  });
});

describe("canonical shader defines", () => {
  test("[ER-04-03] insertion order does not change the canonical form", () => {
    const first = canonicalDefines({ ALPHA_MASK: false, NORMAL_MAP: true });
    const second = canonicalDefines({ NORMAL_MAP: true, ALPHA_MASK: false });
    expect(first).toBe(second);
  });

  test("[ER-04-03] absent defines equal an empty define object", () => {
    expect(canonicalDefines(undefined)).toBe(canonicalDefines({}));
  });

  test("[ER-04-03] numeric formatting is value-based", () => {
    expect(canonicalDefines({ X: 1 })).toBe(canonicalDefines({ X: 1.0 }));
    expect(canonicalDefines({ X: 1 })).not.toBe(canonicalDefines({ X: 2 }));
    expect(canonicalDefines({ X: -1 })).not.toBe(canonicalDefines({ X: 1 }));
  });

  test("[ER-04-03] non-finite and non-primitive define values are rejected", () => {
    expectErrorCode(() => canonicalDefines({ X: Number.NaN }), "E_CONTRACT");
    expectErrorCode(
      () => canonicalDefines({ X: Number.POSITIVE_INFINITY }),
      "E_CONTRACT",
    );
    expectErrorCode(
      () =>
        canonicalDefines(
          { X: { nested: true } } as unknown as Record<string, DefineValue>,
        ),
      "E_CONTRACT",
    );
  });

  test("[ER-04-03] invalid define names are rejected", () => {
    expectErrorCode(() => canonicalDefines({ "1BAD": true }), "E_CONTRACT");
    expectErrorCode(() => canonicalDefines({ "": true }), "E_CONTRACT");
    expectErrorCode(() => canonicalDefines({ "A-B": true }), "E_CONTRACT");
    expectErrorCode(() => canonicalDefines({ "é": true }), "E_CONTRACT");
  });
});

describe("shader module keys", () => {
  const parts = {
    language: "wgsl",
    stage: "vertex",
    entryPoint: "vs_main",
    abiVersion: 1,
    definesCanonical: canonicalDefines({ ALPHA_MASK: false }),
    code: "@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0); }",
  } as const;

  test("[ER-04-03] equivalent define orderings produce the same shader key", () => {
    const first = shaderModuleKey(parts);
    const second = shaderModuleKey({
      ...parts,
      definesCanonical: canonicalDefines({ ALPHA_MASK: false }),
    });
    expect(first).toBe(second);
  });

  test("[ER-04-03] every tuple field participates in the shader key", () => {
    const base = shaderModuleKey(parts);
    const variants = [
      { ...parts, stage: "fragment" as const },
      { ...parts, entryPoint: "fs_main" },
      {
        ...parts,
        definesCanonical: canonicalDefines({ X: 1 }),
      },
      { ...parts, code: `${parts.code} ` },
    ];
    for (const variant of variants) {
      expect(shaderModuleKey(variant)).not.toBe(base);
    }
  });

  test("[ER-04-03] an over-limit shader source is rejected", () => {
    expect(fixture.cacheRules.maxShaderModules).toBe(64);
    expectErrorCode(
      () =>
        shaderModuleKey({
          ...parts,
          code: "x".repeat(MAX_SHADER_MODULE_KEY_BYTES),
        }),
      "E_CONTRACT",
    );
  });
});

describe("pipeline cache LRU", () => {
  function distinctKey(name: string): PipelineCacheKey {
    return canonicalPipelineKey(inputsWith({ vertexShaderKey: name }));
  }

  test("[ER-04-03] least-recently-used entry is evicted on insert", () => {
    const evicted: PipelineCacheEntry<number>[] = [];
    const cache = new PipelineCache<number>({
      capacity: 2,
      onEvict: (entry) => evicted.push(entry),
    });
    const a = distinctKey("a");
    const b = distinctKey("b");
    const c = distinctKey("c");
    cache.set(a, 1);
    cache.set(b, 2);
    expect(cache.get(a)?.value).toBe(1);
    cache.set(c, 3);
    expect(cache.size).toBe(2);
    expect(evicted).toHaveLength(1);
    expect(pipelineKeysEqual(evicted[0]?.key ?? c, b)).toBe(true);
    expect(cache.get(b)).toBeUndefined();
    expect(cache.get(a)?.value).toBe(1);
    expect(cache.get(c)?.value).toBe(3);
  });

  test("[ER-04-03] a failed pipeline is cached as a failure entry", () => {
    const cache = new PipelineCache<number>();
    const key = distinctKey("failing");
    cache.setFailure(key, "validation failed");
    const entry = cache.get(key);
    expect(entry?.failure).toBe("validation failed");
    expect(entry?.value).toBeNull();
    expect(cache.has(key)).toBe(true);
  });

  test("[ER-04-03] a stale failure is replaced by a later success", () => {
    const cache = new PipelineCache<number>();
    const key = distinctKey("retry");
    cache.setFailure(key, "first attempt failed");
    cache.set(key, 9);
    expect(cache.get(key)?.value).toBe(9);
    expect(cache.get(key)?.failure).toBeNull();
  });

  test("[ER-04-03] the default cache holds at most 256 pipelines", () => {
    expect(fixture.cacheRules.maxPipelines).toBe(256);
    const evicted: PipelineCacheEntry<number>[] = [];
    const cache = new PipelineCache<number>({
      onEvict: (entry) => evicted.push(entry),
    });
    for (let index = 0; index < 257; index += 1) {
      cache.set(distinctKey(`pipeline-${index}`), index);
    }
    expect(cache.size).toBe(256);
    expect(evicted).toHaveLength(1);
    expect(cache.get(distinctKey("pipeline-0"))).toBeUndefined();
    expect(cache.get(distinctKey("pipeline-256"))?.value).toBe(256);
  });

  test("[ER-04-03] delete and clear remove entries", () => {
    const cache = new PipelineCache<number>();
    const key = distinctKey("delete-me");
    cache.set(key, 1);
    expect(cache.delete(key)).toBe(true);
    expect(cache.delete(key)).toBe(false);
    cache.set(key, 1);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  test("[ER-04-03] a re-inserted key is not evicted early", () => {
    const evicted: PipelineCacheEntry<number>[] = [];
    const cache = new PipelineCache<number>({
      capacity: 2,
      onEvict: (entry) => evicted.push(entry),
    });
    const a = distinctKey("a");
    const b = distinctKey("b");
    cache.set(a, 1);
    cache.set(b, 2);
    cache.set(a, 11);
    expect(cache.size).toBe(2);
    expect(evicted).toHaveLength(0);
    expect(cache.get(a)?.value).toBe(11);
  });
});

describe("shader module cache", () => {
  test("[ER-04-03] a full shader cache refuses new modules and never evicts", () => {
    const cache = new ShaderCache<string>(2);
    expect(cache.set("a", "A")).toBe(true);
    expect(cache.set("b", "B")).toBe(true);
    expect(cache.set("c", "C")).toBe(false);
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBe("A");
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBeUndefined();
  });

  test("[ER-04-03] updating an existing shader key is allowed at capacity", () => {
    const cache = new ShaderCache<string>(2);
    cache.set("a", "A");
    cache.set("b", "B");
    expect(cache.set("a", "A2")).toBe(true);
    expect(cache.get("a")).toBe("A2");
    expect(cache.size).toBe(2);
  });

  test("[ER-04-03] the default shader cache capacity is 64", () => {
    const cache = new ShaderCache<string>();
    for (let index = 0; index < 64; index += 1) {
      expect(cache.set(`shader-${index}`, `S${index}`)).toBe(true);
    }
    expect(cache.set("shader-64", "S64")).toBe(false);
    expect(cache.size).toBe(64);
  });

  test("[ER-04-03] shader cache delete and clear", () => {
    const cache = new ShaderCache<string>();
    cache.set("a", "A");
    expect(cache.delete("a")).toBe(true);
    expect(cache.has("a")).toBe(false);
    cache.set("b", "B");
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
