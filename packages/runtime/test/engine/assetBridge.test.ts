// @req ER-00-16 — decoded assets resolve to cached GPU handles.
import type {
  AssetKind,
  AssetState,
  AssetTextureFormat,
  MaterialData,
  MeshData,
  MeshPrimitive,
  TextureData,
  TextureLevelData,
} from "@lanpad/engine-assets";
import type {
  BoundingSphere,
  EngineErrorCode,
  GpuHandle,
  MaterialDesc,
  MaterialHandle,
  MeshDesc,
  MeshHandle,
  TextureDesc,
  TextureFormat,
  TextureHandle,
} from "@lanpad/engine-core";
import { describe, expect, test } from "vitest";
import {
  ASSET_BRIDGE_VERTEX_STRIDE,
  AssetBridgeError,
  createAssetBridge,
  type AssetBridgeAsset,
  type AssetBridgeDevice,
  type AssetBridgeLibrary,
  type BridgedAssetHandle,
} from "../../src/engine/assetBridge.js";

/** Every core token the decoded-format table can reach. */
const ALL_MAPPED_FORMATS: readonly TextureFormat[] = [
  "rgba8unorm",
  "rgba8unorm-srgb",
  "s3tc-dxt1",
  "s3tc-dxt5",
  "bptc-rgba",
  "etc2-rgba8",
  "astc-4x4",
];

class FakeDevice implements AssetBridgeDevice {
  readonly capabilities: {
    readonly supportedFormats: ReadonlySet<TextureFormat>;
  };
  readonly meshes: MeshDesc[] = [];
  readonly textures: TextureDesc[] = [];
  readonly materials: MaterialDesc[] = [];
  readonly destroyed: BridgedAssetHandle[] = [];
  failMaterialCreation: Error | null = null;
  private nextIndex = 1;

  constructor(
    supportedFormats: readonly TextureFormat[] = ALL_MAPPED_FORMATS,
  ) {
    this.capabilities = { supportedFormats: new Set(supportedFormats) };
  }

  createMesh(desc: MeshDesc): MeshHandle {
    this.meshes.push(desc);
    return { index: this.nextIndex++, generation: 1, __kind: "mesh" };
  }

  createTexture(desc: TextureDesc): TextureHandle {
    this.textures.push(desc);
    return { index: this.nextIndex++, generation: 1, __kind: "texture" };
  }

  createMaterial(desc: MaterialDesc): MaterialHandle {
    if (this.failMaterialCreation !== null) throw this.failMaterialCreation;
    this.materials.push(desc);
    return { index: this.nextIndex++, generation: 1, __kind: "material" };
  }

  destroy(handle: GpuHandle): void {
    // The bridge only ever hands this device the handles it created.
    this.destroyed.push(handle as BridgedAssetHandle);
  }
}

class FakeLibrary implements AssetBridgeLibrary {
  readonly calls: string[] = [];
  private readonly entries = new Map<
    string,
    { kind: AssetKind; state: AssetState; value: unknown }
  >();

  add(
    id: string,
    kind: AssetKind,
    value: unknown,
    state: AssetState = "ready",
  ): void {
    this.entries.set(id, { kind, state, value });
  }

  get<T>(id: string): AssetBridgeAsset<T> | undefined {
    this.calls.push(id);
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    return {
      id,
      kind: entry.kind,
      state: entry.state,
      get value(): T {
        if (entry.state !== "ready") {
          throw new Error(`asset ${id} was read before it was ready`);
        }
        return entry.value as T;
      },
    };
  }
}

function codeOf(run: () => unknown): EngineErrorCode {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AssetBridgeError);
    return (error as AssetBridgeError).code;
  }
  throw new Error("expected the bridge to throw AssetBridgeError");
}

function bounds(radius = 1): BoundingSphere {
  return { center: { x: 0, y: 1, z: 2 }, radius };
}

/**
 * A triangle-list primitive whose x position equals the vertex ordinal, so a
 * merged buffer's placement can be read back float by float. `vertexCount`
 * must be a multiple of 3.
 */
function primitive(
  vertexCount = 3,
  indexFormat: "uint16" | "uint32" = "uint16",
): MeshPrimitive {
  const vertices = new Float32Array(
    (vertexCount * ASSET_BRIDGE_VERTEX_STRIDE) / 4,
  );
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const base = vertex * 8;
    vertices[base] = vertex;
    vertices[base + 4] = 1;
  }
  const indices =
    indexFormat === "uint32"
      ? Uint32Array.from({ length: vertexCount }, (_, index) => index)
      : Uint16Array.from({ length: vertexCount }, (_, index) => index);
  return {
    vertices,
    indices,
    indexFormat,
    vertexCount,
    indexCount: vertexCount,
    bounds: bounds(),
    materialSlot: 0,
  };
}

function meshData(
  primitives: readonly MeshPrimitive[] = [primitive()],
): MeshData {
  return {
    formatVersion: 1,
    id: "mesh",
    bounds: bounds(),
    primitives,
    materialNames: ["material"],
  };
}

function textureLevels(layers = 1): TextureLevelData[] {
  const levels: TextureLevelData[] = [];
  for (let layer = 0; layer < layers; layer += 1) {
    levels.push({
      mipLevel: 0,
      layer,
      bytes: new Uint8Array(16),
      bytesPerRow: 8,
    });
  }
  return levels;
}

function textureData(patch: Partial<TextureData> = {}): TextureData {
  return {
    formatVersion: 1,
    id: "texture",
    container: "png",
    width: 2,
    height: 2,
    mipLevels: 1,
    layers: 1,
    format: "rgba8unorm",
    sourceColorSpace: "srgb",
    levels: textureLevels(),
    gpuBytes: 16,
    completeMipChain: true,
    ...patch,
  };
}

function materialData(patch: Partial<MaterialData> = {}): MaterialData {
  return {
    formatVersion: 1,
    id: "material",
    baseColorFactor: [1, 1, 1, 1],
    metallic: 0,
    roughness: 1,
    emissiveFactor: [0, 0, 0],
    baseColorTexture: null,
    metallicRoughnessTexture: null,
    normalTexture: null,
    normalScale: 1,
    occlusionTexture: null,
    occlusionStrength: 1,
    emissiveTexture: null,
    alphaMode: "opaque",
    alphaCutoff: 0.5,
    doubleSided: false,
    unlit: false,
    ...patch,
  };
}

describe("asset bridge", () => {
  test("[ER-04-04] caches one GPU resource per ready asset and reuses its handle", () => {
    const device = new FakeDevice();
    const library = new FakeLibrary();
    library.add("mesh", "mesh", meshData());
    library.add("texture", "texture", textureData());
    library.add("material", "material", materialData());

    const bridge = createAssetBridge(device, library);
    const mesh = bridge.resolveHandle("mesh");
    const texture = bridge.resolveHandle("texture");
    const material = bridge.resolveHandle("material");

    expect(mesh?.__kind).toBe("mesh");
    expect(texture?.__kind).toBe("texture");
    expect(material?.__kind).toBe("material");
    expect(device.meshes).toHaveLength(1);
    expect(device.textures).toHaveLength(1);
    expect(device.materials).toHaveLength(1);

    const lookups = library.calls.length;
    expect(bridge.resolveHandle("mesh")).toBe(mesh);
    expect(bridge.resolveHandle("texture")).toBe(texture);
    expect(bridge.resolveHandle("material")).toBe(material);
    expect(library.calls).toHaveLength(lookups);
    expect(device.meshes).toHaveLength(1);
    expect(device.textures).toHaveLength(1);
    expect(device.materials).toHaveLength(1);
  });

  test("[ER-04-04] resolves missing and not-ready assets to undefined without reading their value", () => {
    const device = new FakeDevice();
    const library = new FakeLibrary();
    library.add("loading", "mesh", meshData(), "loading");
    library.add("failed", "texture", textureData(), "failed");

    const bridge = createAssetBridge(device, library);

    expect(bridge.resolveHandle("absent")).toBeUndefined();
    expect(bridge.resolveHandle("loading")).toBeUndefined();
    expect(bridge.resolveHandle("failed")).toBeUndefined();
    expect(device.meshes).toHaveLength(0);
    expect(device.textures).toHaveLength(0);
    expect(device.materials).toHaveLength(0);
  });

  test("[ER-04-04] refuses a ready asset kind that has no GPU resource", () => {
    const device = new FakeDevice();
    const library = new FakeLibrary();
    library.add("sound", "audio", {
      kind: "encoded",
      bytes: new ArrayBuffer(0),
      mimeType: "audio/ogg",
      streaming: false,
    });

    const bridge = createAssetBridge(device, library);

    expect(codeOf(() => bridge.resolveHandle("sound"))).toBe(
      "E_UNSUPPORTED_FEATURE",
    );
    expect(device.meshes).toHaveLength(0);
    expect(device.textures).toHaveLength(0);
    expect(device.materials).toHaveLength(0);
  });

  test("[ER-05-01] uploads a single primitive as ABI 1 without copying", () => {
    const device = new FakeDevice();
    const library = new FakeLibrary();
    const source = primitive();
    const mesh = meshData([source]);
    library.add("mesh", "mesh", mesh);

    const bridge = createAssetBridge(device, library);
    const handle = bridge.resolveHandle("mesh");
    const desc = device.meshes[0];

    expect(handle?.__kind).toBe("mesh");
    expect(desc).toBeDefined();
    if (desc === undefined) return;
    expect(desc.label).toBe("mesh");
    expect(desc.layout).toBe("static-pbr-v1");
    expect(desc.topology).toBe("triangle-list");
    expect(desc.vertices).toHaveLength(1);
    expect(desc.vertices[0]).toBe(source.vertices);
    expect(desc.vertices[0]?.byteLength).toBe(
      source.vertexCount * ASSET_BRIDGE_VERTEX_STRIDE,
    );
    expect(desc.indices?.data).toBe(source.indices);
    expect(desc.indices?.format).toBe("uint16");
    expect(desc.bounds).toEqual(mesh.bounds);
    expect(ASSET_BRIDGE_VERTEX_STRIDE).toBe(32);
  });

  test("[ER-05-01] merges primitives into one ABI 1 buffer and offsets each index", () => {
    const device = new FakeDevice();
    const library = new FakeLibrary();
    const first = primitive();
    const second = primitive();
    library.add("mesh", "mesh", meshData([first, second]));

    const bridge = createAssetBridge(device, library);
    bridge.resolveHandle("mesh");
    const desc = device.meshes[0];

    expect(desc).toBeDefined();
    if (desc === undefined) return;
    expect(desc.vertices).toHaveLength(1);
    const vertices = desc.vertices[0];
    expect(vertices).toBeInstanceOf(Float32Array);
    if (!(vertices instanceof Float32Array)) return;
    expect(vertices).toHaveLength(6 * 8);
    expect(Array.from(vertices.slice(0, 24))).toEqual(
      Array.from(first.vertices),
    );
    expect(Array.from(vertices.slice(24))).toEqual(
      Array.from(second.vertices),
    );
    expect(Array.from(desc.indices?.data ?? new Uint16Array(0))).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(desc.indices?.format).toBe("uint16");
  });

  test("[ER-05-01] widens merged indices to uint32 above the uint16 vertex limit", () => {
    const device = new FakeDevice();
    const library = new FakeLibrary();
    const first = primitive(39_999);
    const second = primitive(39_999);
    expect(first.indexFormat).toBe("uint16");
    library.add("mesh", "mesh", meshData([first, second]));

    const bridge = createAssetBridge(device, library);
    bridge.resolveHandle("mesh");
    const desc = device.meshes[0];

    expect(desc).toBeDefined();
    if (desc === undefined) return;
    expect(desc.indices?.format).toBe("uint32");
    const indices = desc.indices?.data;
    expect(indices).toBeInstanceOf(Uint32Array);
    if (indices === undefined) return;
    expect(indices).toHaveLength(79_998);
    expect(indices[39_998]).toBe(39_998);
    expect(indices[39_999]).toBe(39_999);
  });

  test("[ER-04-04] rejects malformed decoded mesh data before touching the device", () => {
    const device = new FakeDevice();
    const base = primitive();
    const wrongFloatCount = { ...base, vertices: new Float32Array(8) };
    const wrongIndexCount = {
      ...base,
      indexCount: 2,
      indices: base.indices.slice(0, 2),
    };
    const wrongIndexFormat = { ...base, indexFormat: "uint32" as const };
    const outOfRange = primitive();
    outOfRange.indices[0] = 9;

    const cases: ReadonlyArray<readonly [string, MeshPrimitive]> = [
      ["vertex float count", wrongFloatCount],
      ["triangle-list index count", wrongIndexCount],
      ["index format", wrongIndexFormat],
      ["index range", outOfRange],
    ];
    for (const [label, badPrimitive] of cases) {
      const library = new FakeLibrary();
      library.add("mesh", "mesh", meshData([badPrimitive]));
      const bridge = createAssetBridge(device, library);
      expect(codeOf(() => bridge.resolveHandle("mesh")), label).toBe(
        "E_ASSET_FORMAT",
      );
    }
    expect(device.meshes).toHaveLength(0);
  });

  test("[ER-05-01] maps texture levels, array layers and usage through without copying", () => {
    const device = new FakeDevice();
    const library = new FakeLibrary();
    const sampler = {
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "nearest",
      addressU: "repeat",
      addressV: "clamp-to-edge",
    } as const;
    const atlas = textureData({
      id: "atlas",
      layers: 4,
      levels: textureLevels(4),
    });
    library.add("atlas", "texture", atlas);
    library.add("empty", "texture", textureData({ id: "empty", levels: [] }));

    const bridge = createAssetBridge(device, library, {
      sampler,
      retainCpu: true,
    });
    bridge.resolveHandle("atlas");
    bridge.resolveHandle("empty");
    const atlasDesc = device.textures[0];
    const emptyDesc = device.textures[1];

    expect(atlasDesc).toBeDefined();
    expect(emptyDesc).toBeDefined();
    if (atlasDesc === undefined || emptyDesc === undefined) return;
    expect(atlasDesc.label).toBe("atlas");
    expect(atlasDesc.width).toBe(2);
    expect(atlasDesc.height).toBe(2);
    expect(atlasDesc.mipLevels).toBe(1);
    expect(atlasDesc.depthOrArrayLayers).toBe(4);
    expect(atlasDesc.format).toBe("rgba8unorm");
    expect(atlasDesc.usage).toEqual(["sample", "copy-dst"]);
    expect(atlasDesc.data).toBe(atlas.levels);
    expect(atlasDesc.sampler).toBe(sampler);
    expect(atlasDesc.retainCpu).toBe(true);
    // Nothing was uploaded for the empty texture, so no copy-dst usage.
    expect(emptyDesc.usage).toEqual(["sample"]);
  });

  test("[ER-06-04] maps every decoded texture token to a canonical core format", () => {
    const table: ReadonlyArray<readonly [AssetTextureFormat, TextureFormat]> = [
      ["rgba8unorm", "rgba8unorm"],
      ["rgba8unorm-srgb", "rgba8unorm-srgb"],
      ["bc1-rgba-unorm", "s3tc-dxt1"],
      ["bc3-rgba-unorm", "s3tc-dxt5"],
      ["bc7-rgba-unorm", "bptc-rgba"],
      ["etc2-rgba8unorm", "etc2-rgba8"],
      ["astc-4x4-unorm", "astc-4x4"],
    ];
    const device = new FakeDevice();
    const library = new FakeLibrary();
    for (const [token] of table) {
      library.add(token, "texture", textureData({ id: token, format: token }));
    }

    const bridge = createAssetBridge(device, library);
    for (const [token, expected] of table) {
      expect(bridge.resolveHandle(token)?.__kind, token).toBe("texture");
      const desc = device.textures[device.textures.length - 1];
      expect(desc?.format, token).toBe(expected);
    }
  });

  test("[ER-06-04] refuses sRGB compressed tokens and formats the device does not support", () => {
    const device = new FakeDevice();
    const library = new FakeLibrary();
    library.add(
      "srgb-bc1",
      "texture",
      textureData({ format: "bc1-rgba-unorm-srgb" }),
    );
    const bridge = createAssetBridge(device, library);

    expect(codeOf(() => bridge.resolveHandle("srgb-bc1"))).toBe(
      "E_UNSUPPORTED_FEATURE",
    );
    expect(device.textures).toHaveLength(0);

    const limited = new FakeDevice(["rgba8unorm"]);
    const limitedLibrary = new FakeLibrary();
    limitedLibrary.add(
      "astc",
      "texture",
      textureData({ format: "astc-4x4-unorm" }),
    );
    const limitedBridge = createAssetBridge(limited, limitedLibrary);

    expect(codeOf(() => limitedBridge.resolveHandle("astc"))).toBe(
      "E_UNSUPPORTED_FEATURE",
    );
    expect(limited.textures).toHaveLength(0);
  });

  test("[ER-06-06] maps material factors and resolves texture ids through the same cache", () => {
    const device = new FakeDevice();
    const library = new FakeLibrary();
    library.add("albedo", "texture", textureData({ id: "albedo" }));
    library.add("normal", "texture", textureData({ id: "normal" }));
    library.add(
      "glass",
      "material",
      materialData({
        id: "glass",
        baseColorFactor: [0.1, 0.2, 0.3, 0.4],
        metallic: 0.8,
        roughness: 0.2,
        emissiveFactor: [0.5, 0.25, 0],
        baseColorTexture: "albedo",
        normalTexture: "normal",
        normalScale: 2,
        occlusionStrength: 0.4,
        alphaMode: "blend",
        alphaCutoff: 0.25,
        doubleSided: true,
        unlit: true,
      }),
    );

    const bridge = createAssetBridge(device, library);
    const materialHandle = bridge.resolveHandle("glass");
    const albedo = bridge.resolveHandle("albedo");
    const normal = bridge.resolveHandle("normal");
    const desc = device.materials[0];

    expect(materialHandle?.__kind).toBe("material");
    expect(desc).toBeDefined();
    if (desc === undefined) return;
    expect(desc.label).toBe("glass");
    expect(desc.baseColorFactor).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(desc.metallic).toBe(0.8);
    expect(desc.roughness).toBe(0.2);
    expect(desc.emissiveFactor).toEqual([0.5, 0.25, 0]);
    expect(desc.baseColorTexture).toBe(albedo);
    expect(desc.normalTexture).toBe(normal);
    expect(desc.normalScale).toBe(2);
    expect(desc.occlusionStrength).toBe(0.4);
    expect(desc.alphaMode).toBe("blend");
    expect(desc.alphaCutoff).toBe(0.25);
    expect(desc.doubleSided).toBe(true);
    expect(desc.unlit).toBe(true);
    // The material shared the cache entries instead of creating duplicates.
    expect(device.textures).toHaveLength(2);
  });

  test("[ER-06-06] fails material uploads whose texture is missing, not ready or not a texture", () => {
    const missingDevice = new FakeDevice();
    const missingLibrary = new FakeLibrary();
    missingLibrary.add(
      "mat",
      "material",
      materialData({ baseColorTexture: "missing" }),
    );
    const missingBridge = createAssetBridge(missingDevice, missingLibrary);

    expect(codeOf(() => missingBridge.resolveHandle("mat"))).toBe(
      "E_ASSET_NOT_READY",
    );
    expect(missingDevice.materials).toHaveLength(0);
    expect(missingDevice.textures).toHaveLength(0);

    const wrongKindDevice = new FakeDevice();
    const wrongKindLibrary = new FakeLibrary();
    wrongKindLibrary.add("notATexture", "mesh", meshData());
    wrongKindLibrary.add(
      "mat",
      "material",
      materialData({ baseColorTexture: "notATexture" }),
    );
    const wrongKindBridge = createAssetBridge(
      wrongKindDevice,
      wrongKindLibrary,
    );

    expect(codeOf(() => wrongKindBridge.resolveHandle("mat"))).toBe(
      "E_ASSET_FORMAT",
    );
    expect(wrongKindDevice.materials).toHaveLength(0);
  });

  test("[ER-06-07] counts references, destroys on the last release and disposes once", () => {
    const device = new FakeDevice();
    const library = new FakeLibrary();
    library.add("texture", "texture", textureData());
    library.add("mesh", "mesh", meshData());
    const bridge = createAssetBridge(device, library);

    const texture = bridge.resolveHandle("texture");
    expect(texture).toBeDefined();
    expect(bridge.retain("texture")).toBe(true);
    expect(bridge.release("texture")).toBe(false);
    expect(device.destroyed).toHaveLength(0);
    expect(bridge.release("texture")).toBe(true);
    expect(device.destroyed).toEqual([texture]);
    expect(bridge.release("texture")).toBe(false);
    expect(bridge.retain("texture")).toBe(false);

    const mesh = bridge.resolveHandle("mesh");
    expect(mesh).toBeDefined();
    bridge.dispose();
    bridge.dispose();
    expect(device.destroyed).toHaveLength(2);
    expect(device.destroyed[1]).toBe(mesh);
    expect(bridge.resolveHandle("mesh")).toBeUndefined();
    expect(bridge.retain("mesh")).toBe(false);
  });

  test("[ER-06-07] material destruction releases every texture reference it acquired", () => {
    const device = new FakeDevice();
    const library = new FakeLibrary();
    library.add("albedo", "texture", textureData({ id: "albedo" }));
    library.add(
      "mat",
      "material",
      materialData({ baseColorTexture: "albedo", normalTexture: "albedo" }),
    );
    const bridge = createAssetBridge(device, library);

    const albedo = bridge.resolveHandle("albedo");
    const material = bridge.resolveHandle("mat");
    expect(device.destroyed).toHaveLength(0);

    expect(bridge.release("mat")).toBe(true);
    expect(device.destroyed).toEqual([material]);
    expect(bridge.release("albedo")).toBe(true);
    expect(device.destroyed).toEqual([material, albedo]);
  });

  test("[ER-06-07] destroys partial resources when a material upload fails", () => {
    const device = new FakeDevice();
    const library = new FakeLibrary();
    library.add("albedo", "texture", textureData({ id: "albedo" }));
    library.add("normal", "texture", textureData({ id: "normal" }));
    library.add(
      "mat",
      "material",
      materialData({ baseColorTexture: "albedo", normalTexture: "normal" }),
    );
    const bridge = createAssetBridge(device, library);
    const albedo = bridge.resolveHandle("albedo");

    device.failMaterialCreation = new Error("boom");
    expect(() => bridge.resolveHandle("mat")).toThrow("boom");
    expect(device.materials).toHaveLength(0);
    expect(device.destroyed).toHaveLength(1);
    expect(device.destroyed[0]?.__kind).toBe("texture");
    expect(device.destroyed[0]).not.toBe(albedo);

    // The failed attempt cached nothing: the retry creates the normal map
    // again and reuses the pre-existing albedo entry.
    device.failMaterialCreation = null;
    const rebuilt = bridge.resolveHandle("mat");
    expect(rebuilt?.__kind).toBe("material");
    expect(device.materials).toHaveLength(1);
    expect(device.textures).toHaveLength(3);
  });

  test("[ER-04-04] resolves a warm cache hit without a library lookup or descriptor rebuild", () => {
    const device = new FakeDevice();
    const library = new FakeLibrary();
    library.add("texture", "texture", textureData());
    const bridge = createAssetBridge(device, library);

    const handle = bridge.resolveHandle("texture");
    const desc = device.textures[0];
    library.calls.length = 0;

    const again = bridge.resolveHandle("texture");

    expect(again).toBe(handle);
    expect(library.calls).toEqual([]);
    expect(device.textures).toHaveLength(1);
    expect(device.textures[0]).toBe(desc);
  });
});
