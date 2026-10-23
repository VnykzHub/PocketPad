/**
 * Option normalization, capability classification and adapter-info tests
 * (04 §3.2, §5.2, ER-04-17 partial).
 *
 * Pure functions plus the fake adapter; Node-only evidence. The shared core
 * conformance suite and the real-device browser run remain PENDING.
 */

import { describe, expect, test } from "vitest";
import type { DeviceLimits, EngineFeature } from "@lanpad/engine-core";
import {
  adapterInfoOf,
  capabilitiesFromAdapter,
  deviceLimits,
  normalizeOptions,
  preferredCanvasFormat,
  requestedWebGpuFeatures,
  samplerAnisotropyLimit,
  sanitizeAdapterInfo,
} from "../src/device/capabilities.js";
import { supportedFormatsFor } from "../src/texture/formats.js";
import { FakeAdapter, FakeGpu, fakeLimits } from "./fakes/webgpu.js";
import { errorOf } from "./helpers.js";

function asAdapter(adapter: FakeAdapter): GPUAdapter {
  return adapter as unknown as GPUAdapter;
}

describe("option normalization", () => {
  test("[ER-04-17] defaults match the M0 capability subset", () => {
    expect(normalizeOptions()).toEqual({
      quality: "high",
      maxRenderHeight: 0,
      maxTextureBytes: 128 * 1024 * 1024,
      shadowCascades: 0,
      post: false,
      anisotropy: 4,
      retainCpuCopies: true,
      powerPreference: "high-performance",
    });
  });

  test("[ER-04-17] numeric options are floored and clamped", () => {
    const clamped = normalizeOptions({
      anisotropy: 99.8,
      maxRenderHeight: 99_999,
      maxTextureBytes: 1.9,
      shadowCascades: 3,
      post: true,
      quality: "low",
      retainCpuCopies: false,
      powerPreference: "low-power",
    });
    expect(clamped.anisotropy).toBe(16);
    expect(clamped.maxRenderHeight).toBe(16_384);
    expect(clamped.maxTextureBytes).toBe(1);
    expect(clamped.shadowCascades).toBe(3);
    expect(clamped.post).toBe(true);
    expect(clamped.quality).toBe("low");
    expect(clamped.retainCpuCopies).toBe(false);
    expect(clamped.powerPreference).toBe("low-power");

    const low = normalizeOptions({
      anisotropy: -3,
      maxRenderHeight: -10,
    });
    expect(low.anisotropy).toBe(1);
    expect(low.maxRenderHeight).toBe(0);
  });

  test("[ER-04-17] non-finite options fall back and a zero texture budget throws", () => {
    const fallback = normalizeOptions({
      anisotropy: Number.NaN,
      maxRenderHeight: Number.POSITIVE_INFINITY,
      maxTextureBytes: Number.NaN,
    });
    expect(fallback.anisotropy).toBe(4);
    expect(fallback.maxRenderHeight).toBe(0);
    expect(fallback.maxTextureBytes).toBe(128 * 1024 * 1024);

    expect(errorOf(() => normalizeOptions({ maxTextureBytes: 0 })).code).toBe(
      "E_CONTRACT",
    );
    expect(
      errorOf(() => normalizeOptions({ maxTextureBytes: -1 })).code,
    ).toBe("E_CONTRACT");
  });

  test("[ER-04-17] explicit overrides win over base options", () => {
    const base = normalizeOptions({
      quality: "medium",
      anisotropy: 8,
      maxRenderHeight: 720,
    });
    const override = normalizeOptions(base, {
      quality: "low",
      anisotropy: 2,
      maxRenderHeight: 1080,
    });
    expect(override.quality).toBe("low");
    expect(override.anisotropy).toBe(2);
    expect(override.maxRenderHeight).toBe(1080);
    // Unspecified override fields keep the base value.
    expect(override.maxTextureBytes).toBe(base.maxTextureBytes);
  });
});

describe("capability surfaces", () => {
  test("[ER-04-17] sampler anisotropy floors and falls back to one", () => {
    const limitsFor = (value: unknown): GPUSupportedLimits =>
      value === undefined
        ? ({} as GPUSupportedLimits)
        : ({ maxSamplerAnisotropy: value } as unknown as GPUSupportedLimits);
    expect(samplerAnisotropyLimit(limitsFor(8.9))).toBe(8);
    expect(samplerAnisotropyLimit(limitsFor(16))).toBe(16);
    expect(samplerAnisotropyLimit(limitsFor(undefined))).toBe(1);
    expect(samplerAnisotropyLimit(limitsFor(Number.NaN))).toBe(1);
    expect(samplerAnisotropyLimit(limitsFor(0.5))).toBe(1);
    expect(samplerAnisotropyLimit(limitsFor("8"))).toBe(1);
  });

  test("[ER-04-17] device limits mirror the adapter limits", () => {
    const limits = fakeLimits({ maxTextureDimension2D: 4096 });
    expect(deviceLimits(limits as unknown as GPUSupportedLimits)).toEqual({
      maxTextureDimension2D: 4096,
      maxTextureArrayLayers: 256,
      maxBindGroups: 4,
      maxUniformBufferBindingSize: 65_536,
      maxStorageBufferBindingSize: 134_217_728,
      maxBufferSize: 268_435_456,
      maxVertexBuffers: 8,
      maxColorAttachments: 8,
      maxSamplerAnisotropy: 16,
      minUniformBufferOffsetAlignment: 256,
      maxComputeWorkgroupSizeX: 256,
    } satisfies DeviceLimits);
  });

  test("[ER-04-17] only bgra8unorm and rgba8unorm are accepted canvas formats", () => {
    const gpu = new FakeGpu();
    expect(preferredCanvasFormat(gpu as unknown as GPU)).toBe("bgra8unorm");
    gpu.preferredFormat = "rgba8unorm";
    expect(preferredCanvasFormat(gpu as unknown as GPU)).toBe("rgba8unorm");
    for (const format of ["rgba16float", "bgra8unorm-srgb", ""]) {
      gpu.preferredFormat = format;
      expect(errorOf(() => preferredCanvasFormat(gpu as unknown as GPU)).code).toBe(
        "E_BACKEND_INIT",
      );
    }
  });

  test("[ER-04-17] only supported compression features are requested", () => {
    const bare = new FakeAdapter();
    expect(requestedWebGpuFeatures(asAdapter(bare))).toEqual([]);

    const supported = new FakeAdapter(
      fakeLimits(),
      new Set([
        "texture-compression-bc",
        "texture-compression-astc",
        "depth-clip-control",
      ]),
    );
    expect(requestedWebGpuFeatures(asAdapter(supported))).toEqual([
      "texture-compression-bc",
      "texture-compression-astc",
    ]);
  });

  test("[ER-04-17] adapter features expand the engine feature and format sets", () => {
    const bare = new FakeAdapter();
    const noFeatures = capabilitiesFromAdapter(
      asAdapter(bare),
      normalizeOptions(),
      [],
    );
    expect([...noFeatures.features]).toEqual(["texture-array"]);
    expect(noFeatures.supportedFormats.size).toBe(10);
    expect(noFeatures.supportedFormats.has("rgba8unorm-srgb")).toBe(true);
    expect(noFeatures.supportedFormats.has("s3tc-dxt1")).toBe(false);

    const compressed = new FakeAdapter(
      fakeLimits(),
      new Set(["texture-compression-bc", "texture-compression-etc2"]),
    );
    const requested: GPUFeatureName[] = [
      "texture-compression-bc",
      "texture-compression-etc2",
    ];
    const withCompression = capabilitiesFromAdapter(
      asAdapter(compressed),
      normalizeOptions(),
      requested,
    );
    const features: EngineFeature[] = [...withCompression.features];
    expect(features.sort()).toEqual([
      "compressed-etc2",
      "compressed-s3tc",
      "texture-array",
    ]);
    expect(withCompression.supportedFormats.size).toBe(16);
    expect(withCompression.supportedFormats.has("s3tc-dxt5")).toBe(true);
    expect(withCompression.supportedFormats.has("etc2-rgba8")).toBe(true);
    expect(withCompression.supportedFormats.has("astc-4x4")).toBe(false);
    expect(
      [...supportedFormatsFor(new Set(["texture-compression-bc", "texture-compression-etc2"]))],
    ).toEqual([...withCompression.supportedFormats]);
  });

  test("[ER-04-17] reported anisotropy is the minimum of option, adapter and limits", () => {
    const adapter = new FakeAdapter(
      fakeLimits({ maxSamplerAnisotropy: 8 }),
      new Set(),
    );
    const optionBound = capabilitiesFromAdapter(
      asAdapter(adapter),
      normalizeOptions({ anisotropy: 4 }),
      [],
    );
    expect(optionBound.anisotropy).toBe(4);

    const adapterBound = capabilitiesFromAdapter(
      asAdapter(adapter),
      normalizeOptions({ anisotropy: 16 }),
      [],
    );
    expect(adapterBound.anisotropy).toBe(8);

    const limitBound = capabilitiesFromAdapter(
      asAdapter(adapter),
      normalizeOptions({ anisotropy: 16 }),
      [],
      {
        ...deviceLimits(adapter.limits as unknown as GPUSupportedLimits),
        maxSamplerAnisotropy: 2,
      },
    );
    expect(limitBound.anisotropy).toBe(2);
  });

  test("[ER-04-17] the M0 capability report is not inflated", () => {
    const adapter = new FakeAdapter();
    const capabilities = capabilitiesFromAdapter(
      asAdapter(adapter),
      normalizeOptions({ quality: "low" }),
      [],
    );
    expect(capabilities.backend).toBe("webgpu");
    expect(capabilities.quality).toBe("low");
    expect(capabilities.maxSamples).toBe(1);
    expect(capabilities.directionalLights).toBe(1);
    expect(capabilities.pointLights).toBe(0);
    expect(capabilities.shadowCascades).toBe(0);
    expect(capabilities.supportsPost).toBe(false);
    expect(capabilities.supportsTimestamps).toBe(false);
    expect(capabilities.maxTextureSize).toBe(8192);
    expect(capabilities.maxTextureLayers).toBe(256);
    expect(capabilities.maxBindGroups).toBe(4);
    expect(capabilities.maxUniformBufferBytes).toBe(65_536);
  });
});

describe("adapter info", () => {
  test("[ER-04-17] adapter info is display-only and sanitized", () => {
    expect(sanitizeAdapterInfo(null)).toBe("WebGPU adapter");
    expect(sanitizeAdapterInfo({})).toBe("WebGPU adapter");
    expect(
      sanitizeAdapterInfo({
        description: "Fake GPU",
        vendor: "fake",
        architecture: "test",
        device: "fake-device",
      }),
    ).toBe("Fake GPU fake test fake-device");

    const dirty = sanitizeAdapterInfo({
      description: "GPU https://secret.test/path token=abc123",
      vendor: "Vendor",
      architecture: "arch",
      device: "device",
    });
    expect(dirty).not.toContain("https://");
    expect(dirty).not.toContain("token=abc123");
    expect(dirty).not.toContain("\u0001");
    expect(dirty).toContain("Vendor");
    expect(dirty.length).toBeLessThanOrEqual(120);

    const long = sanitizeAdapterInfo({ description: "a".repeat(200) });
    expect(long.length).toBe(120);
  });

  test("[ER-04-17] adapterInfoOf reads the adapter info object", () => {
    const adapter = new FakeAdapter(fakeLimits(), new Set(), {
      description: "Fake GPU",
      vendor: "fake",
      architecture: "test",
      device: "fake-device",
    });
    expect(adapterInfoOf(asAdapter(adapter))).toBe(
      "Fake GPU fake test fake-device",
    );
  });
});
