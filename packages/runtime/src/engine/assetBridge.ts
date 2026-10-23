/**
 * Decoded-asset -> GPU-resource bridge (runtime composition root; 06 §3.5,
 * 04 §4.3/§4.5, 05 §4.3/§4.4).
 *
 * The runtime owns this bridge because neither the asset package nor a
 * renderer may import the other. It turns a ready `AssetHandle` value into the
 * opaque handles the `RenderDevice` returns, and keeps one GPU resource per
 * manifest id:
 *
 * - mesh:  ABI 1 `static-pbr-v1`, one interleaved stride-32 vertex buffer and
 *          a uint16/uint32 index buffer. A single primitive uploads zero-copy;
 *          1–8 primitives are merged through a pooled scratch buffer.
 * - texture: `TextureData` levels map directly to `TextureLevel` (no copy),
 *          the decoded format token maps to the canonical core `TextureFormat`,
 *          and an unmappable or unsupported format is refused, never downcast.
 * - material: factors and every texture slot map to `MaterialDesc`; texture
 *          ids resolve through the same cache, so a material keeps one bridge
 *          reference per slot and releases them when it is destroyed.
 *
 * Lifetime mirrors the asset library: the first resolve creates the resource
 * with one reference, `retain` adds one and `release` removes one. The last
 * release destroys the GPU handle exactly once. A failed upload destroys any
 * resource it created before the failure. Cache hits never allocate.
 */

import type {
  AssetKind,
  AssetState,
  AssetTextureFormat,
  MaterialData,
  MeshData,
  MeshPrimitive,
  TextureData,
} from "@lanpad/engine-assets";
import type {
  BoundingSphere,
  EngineErrorCode,
  GpuHandle,
  MaterialDesc,
  MaterialHandle,
  MeshDesc,
  MeshHandle,
  SamplerDesc,
  TextureDesc,
  TextureFormat,
  TextureHandle,
  TextureLevel,
  TextureUsage,
} from "@lanpad/engine-core";

/** What a ready asset id resolves to. The `__kind` member discriminates. */
export type BridgedAssetHandle = MeshHandle | TextureHandle | MaterialHandle;

/**
 * The subset of `RenderDevice` the bridge calls. A real `RenderDevice`
 * satisfies it structurally; tests inject a recorder.
 */
export interface AssetBridgeDevice {
  readonly capabilities: {
    readonly supportedFormats: ReadonlySet<TextureFormat>;
  };
  createMesh(desc: MeshDesc): MeshHandle;
  createTexture(desc: TextureDesc): TextureHandle;
  createMaterial(desc: MaterialDesc): MaterialHandle;
  destroy(handle: GpuHandle): void;
}

/**
 * The subset of `AssetHandle` the bridge reads. Never read `value` before
 * checking `state === "ready"`; the real getter throws otherwise.
 */
export interface AssetBridgeAsset<T = unknown> {
  readonly id: string;
  readonly kind: AssetKind;
  readonly state: AssetState;
  readonly value: T;
}

/**
 * The subset of `AssetLibrary` the bridge calls. An `AssetLibrary` is
 * assignable to this type without an adapter.
 */
export interface AssetBridgeLibrary {
  get<T = unknown>(assetId: string): AssetBridgeAsset<T> | undefined;
}

export interface AssetBridgeOptions {
  /** Inline sampler for uploaded textures (M0 has no sampler cache). */
  readonly sampler?: SamplerDesc;
  /** Forwarded to `TextureDesc.retainCpu`; backend default when absent. */
  readonly retainCpu?: boolean;
}

export interface AssetBridge {
  /**
   * Returns the cached GPU handle for a ready asset, creating it on first
   * use. Returns `undefined` when the asset itself is absent or not ready.
   * Throws `AssetBridgeError` with `E_ASSET_NOT_READY` when a material's
   * texture dependency is missing or not ready, with `E_UNSUPPORTED_FEATURE`
   * for an unmappable format or an asset kind with no GPU resource, and with
   * `E_ASSET_FORMAT` for malformed decoded data.
   */
  resolveHandle(assetId: string): BridgedAssetHandle | undefined;
  /** Adds one reference. False when no GPU resource is cached for the id. */
  retain(assetId: string): boolean;
  /**
   * Removes one reference. Returns true only when this call destroyed the
   * GPU resource; repeated calls for an unknown id are a no-op returning
   * false.
   */
  release(assetId: string): boolean;
  /** Destroys every live GPU resource exactly once. Idempotent. */
  dispose(): void;
}

export class AssetBridgeError extends Error {
  readonly code: EngineErrorCode;
  readonly layer = "host" as const;
  readonly recoverable: boolean;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.recoverable = code === "E_ASSET_NOT_READY";
  }
}

function bridgeError(code: EngineErrorCode, message: string): AssetBridgeError {
  return new AssetBridgeError(code, message);
}

/**
 * `AssetTextureFormat` -> canonical core `TextureFormat` (06 §4.7).
 *
 * `bc1`/`bc3` map to the S3TC DXT1/DXT5 tokens and BC7 maps to the BPTC RGBA
 * token — the same block formats under the vocabulary 04 owns. The core union
 * has no sRGB compressed token, so every `-srgb` compressed variant is
 * unmappable: dropping the sRGB flag would be a silent downcast.
 */
const TEXTURE_FORMAT_MAP: Readonly<
  Record<AssetTextureFormat, TextureFormat | null>
> = {
  rgba8unorm: "rgba8unorm",
  "rgba8unorm-srgb": "rgba8unorm-srgb",
  "bc1-rgba-unorm": "s3tc-dxt1",
  "bc1-rgba-unorm-srgb": null,
  "bc3-rgba-unorm": "s3tc-dxt5",
  "bc3-rgba-unorm-srgb": null,
  "bc7-rgba-unorm": "bptc-rgba",
  "bc7-rgba-unorm-srgb": null,
  "etc2-rgba8unorm": "etc2-rgba8",
  "etc2-rgba8unorm-srgb": null,
  "astc-4x4-unorm": "astc-4x4",
  "astc-4x4-unorm-srgb": null,
};

const FLOATS_PER_VERTEX = 8;
const VERTEX_STRIDE_BYTES = 32;
const MAX_UINT16_VERTICES = 65_535;
const MAX_PRIMITIVES = 8;

interface EntryBase {
  readonly id: string;
  refs: number;
  destroyed: boolean;
}

interface MeshEntry extends EntryBase {
  readonly kind: "mesh";
  readonly handle: MeshHandle;
}

interface TextureEntry extends EntryBase {
  readonly kind: "texture";
  readonly handle: TextureHandle;
}

interface MaterialEntry extends EntryBase {
  readonly kind: "material";
  readonly handle: MaterialHandle;
  /** One id per acquired texture slot; duplicates are counted. */
  readonly textureIds: readonly string[];
}

type Entry = MeshEntry | TextureEntry | MaterialEntry;

interface PackedMesh {
  readonly vertices: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
  readonly format: "uint16" | "uint32";
  readonly bounds: BoundingSphere;
}

function requireFiniteBounds(
  assetId: string,
  bounds: BoundingSphere,
): BoundingSphere {
  const center = bounds.center;
  if (
    !Number.isFinite(bounds.radius) ||
    bounds.radius < 0 ||
    !Number.isFinite(center.x) ||
    !Number.isFinite(center.y) ||
    !Number.isFinite(center.z)
  ) {
    throw bridgeError(
      "E_ASSET_FORMAT",
      `${assetId}: mesh bounds must be a finite, non-negative sphere`,
    );
  }
  return {
    center: { x: center.x, y: center.y, z: center.z },
    radius: bounds.radius,
  };
}

function validatePrimitive(assetId: string, primitive: MeshPrimitive): void {
  if (
    !Number.isInteger(primitive.vertexCount) ||
    primitive.vertexCount <= 0 ||
    primitive.vertices.length !== primitive.vertexCount * FLOATS_PER_VERTEX
  ) {
    throw bridgeError(
      "E_ASSET_FORMAT",
      `${assetId}: a primitive must carry ${FLOATS_PER_VERTEX} floats per vertex`,
    );
  }
  if (
    !Number.isInteger(primitive.indexCount) ||
    primitive.indexCount <= 0 ||
    primitive.indexCount % 3 !== 0 ||
    primitive.indices.length !== primitive.indexCount
  ) {
    throw bridgeError(
      "E_ASSET_FORMAT",
      `${assetId}: triangle-list index count must be a positive multiple of 3`,
    );
  }
  const is16 = primitive.indices instanceof Uint16Array;
  const is32 = primitive.indices instanceof Uint32Array;
  if (
    (!is16 && !is32) ||
    (primitive.indexFormat === "uint16" && !is16) ||
    (primitive.indexFormat === "uint32" && !is32)
  ) {
    throw bridgeError(
      "E_ASSET_FORMAT",
      `${assetId}: index format "${String(primitive.indexFormat)}" does not match the index data`,
    );
  }
  if (
    primitive.indexFormat === "uint16" &&
    primitive.vertexCount > MAX_UINT16_VERTICES
  ) {
    throw bridgeError(
      "E_ASSET_FORMAT",
      `${assetId}: uint16 indices cannot address ${primitive.vertexCount} vertices`,
    );
  }
  const indices = primitive.indices;
  let maxIndex = 0;
  for (let index = 0; index < indices.length; index += 1) {
    const value = indices[index]!;
    if (value > maxIndex) maxIndex = value;
  }
  if (maxIndex >= primitive.vertexCount) {
    throw bridgeError(
      "E_ASSET_FORMAT",
      `${assetId}: index ${maxIndex} is outside ${primitive.vertexCount} vertices`,
    );
  }
}

class AssetBridgeImpl implements AssetBridge {
  private readonly device: AssetBridgeDevice;
  private readonly library: AssetBridgeLibrary;
  private readonly options: AssetBridgeOptions;
  private readonly entries = new Map<string, Entry>();
  /**
   * Merge scratch for multi-primitive meshes. Grows to the largest merge seen
   * and is never handed to the device: the device retains descriptors for
   * restoration, so each upload gets its own exact-size copy.
   */
  private scratch = new Float32Array(0);
  private disposed = false;

  constructor(
    device: AssetBridgeDevice,
    library: AssetBridgeLibrary,
    options: AssetBridgeOptions,
  ) {
    this.device = device;
    this.library = library;
    this.options = options;
  }

  resolveHandle(assetId: string): BridgedAssetHandle | undefined {
    const cached = this.entries.get(assetId);
    if (cached !== undefined) return cached.handle;
    if (this.disposed) return undefined;

    const asset = this.library.get(assetId);
    if (asset === undefined || asset.state !== "ready") return undefined;

    let entry: Entry;
    switch (asset.kind) {
      case "mesh":
        entry = this.createMeshEntry(assetId, asset.value as MeshData);
        break;
      case "texture":
        entry = this.createTextureEntry(assetId, asset.value as TextureData);
        break;
      case "material":
        entry = this.createMaterialEntry(assetId, asset.value as MaterialData);
        break;
      default:
        throw bridgeError(
          "E_UNSUPPORTED_FEATURE",
          `${assetId}: asset kind "${asset.kind}" has no GPU resource`,
        );
    }
    this.entries.set(assetId, entry);
    return entry.handle;
  }

  retain(assetId: string): boolean {
    const entry = this.entries.get(assetId);
    if (entry === undefined) return false;
    entry.refs += 1;
    return true;
  }

  release(assetId: string): boolean {
    const entry = this.entries.get(assetId);
    if (entry === undefined) return false;
    if (entry.refs > 0) entry.refs -= 1;
    if (entry.refs > 0) return false;
    this.destroyEntry(entry);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // A material destroy releases its texture references, so destroy every
    // entry exactly once through the same guarded path.
    const live = Array.from(this.entries.values());
    for (let index = 0; index < live.length; index += 1) {
      this.destroyEntry(live[index]!);
    }
    this.entries.clear();
    this.scratch = new Float32Array(0);
  }

  private destroyEntry(entry: Entry): void {
    if (entry.destroyed) return;
    entry.destroyed = true;
    this.entries.delete(entry.id);
    if (entry.kind === "material") {
      const textureIds = entry.textureIds;
      for (let index = 0; index < textureIds.length; index += 1) {
        const texture = this.entries.get(textureIds[index]!);
        if (texture === undefined || texture.kind !== "texture") continue;
        if (texture.refs > 0) texture.refs -= 1;
        if (texture.refs === 0) this.destroyEntry(texture);
      }
    }
    this.device.destroy(entry.handle);
  }

  private createTextureEntry(assetId: string, data: TextureData): TextureEntry {
    const mapped = TEXTURE_FORMAT_MAP[data.format];
    if (mapped === null || mapped === undefined) {
      throw bridgeError(
        "E_UNSUPPORTED_FEATURE",
        `${assetId}: texture format "${data.format}" has no canonical core TextureFormat`,
      );
    }
    if (!this.device.capabilities.supportedFormats.has(mapped)) {
      throw bridgeError(
        "E_UNSUPPORTED_FEATURE",
        `${assetId}: the device does not support texture format "${mapped}"`,
      );
    }

    const levels: readonly TextureLevel[] = data.levels;
    const usage: TextureUsage[] =
      levels.length > 0 ? ["sample", "copy-dst"] : ["sample"];
    const desc: TextureDesc = {
      label: assetId,
      width: data.width,
      height: data.height,
      mipLevels: data.mipLevels,
      format: mapped,
      usage,
      data: levels,
      ...(data.layers > 1 ? { depthOrArrayLayers: data.layers } : {}),
      ...(this.options.sampler !== undefined
        ? { sampler: this.options.sampler }
        : {}),
      ...(this.options.retainCpu !== undefined
        ? { retainCpu: this.options.retainCpu }
        : {}),
    };
    const handle = this.device.createTexture(desc);
    return {
      kind: "texture",
      id: assetId,
      handle,
      refs: 1,
      destroyed: false,
    };
  }

  private createMeshEntry(assetId: string, data: MeshData): MeshEntry {
    const packed = this.packMesh(assetId, data);
    const desc: MeshDesc = {
      label: assetId,
      layout: "static-pbr-v1",
      vertices: [packed.vertices],
      indices: { data: packed.indices, format: packed.format },
      bounds: packed.bounds,
      topology: "triangle-list",
    };
    const handle = this.device.createMesh(desc);
    return { kind: "mesh", id: assetId, handle, refs: 1, destroyed: false };
  }

  /**
   * Packs 1–8 `static-pbr-v1` primitives into one ABI 1 mesh. The decoded
   * primitive layout is already stride-32 interleaved, so a single primitive
   * is uploaded without a copy.
   */
  private packMesh(assetId: string, data: MeshData): PackedMesh {
    const primitives = data.primitives;
    if (primitives.length === 0 || primitives.length > MAX_PRIMITIVES) {
      throw bridgeError(
        "E_ASSET_FORMAT",
        `${assetId}: a mesh must have 1-${MAX_PRIMITIVES} primitives`,
      );
    }
    const bounds = requireFiniteBounds(assetId, data.bounds);

    for (let index = 0; index < primitives.length; index += 1) {
      validatePrimitive(assetId, primitives[index]!);
    }

    if (primitives.length === 1) {
      const primitive = primitives[0]!;
      return {
        vertices: primitive.vertices,
        indices: primitive.indices,
        format: primitive.indexFormat,
        bounds,
      };
    }

    let totalVertices = 0;
    let totalIndices = 0;
    let needsUint32 = false;
    for (let index = 0; index < primitives.length; index += 1) {
      const primitive = primitives[index]!;
      totalVertices += primitive.vertexCount;
      totalIndices += primitive.indexCount;
      if (primitive.indexFormat === "uint32") needsUint32 = true;
    }
    if (totalVertices > MAX_UINT16_VERTICES) needsUint32 = true;

    const floatCount = totalVertices * FLOATS_PER_VERTEX;
    if (this.scratch.length < floatCount) {
      this.scratch = new Float32Array(floatCount);
    }
    const scratch = this.scratch;
    let floatOffset = 0;
    for (let index = 0; index < primitives.length; index += 1) {
      const vertices = primitives[index]!.vertices;
      scratch.set(vertices, floatOffset);
      floatOffset += vertices.length;
    }
    const vertices = scratch.slice(0, floatCount);

    const indices = needsUint32
      ? new Uint32Array(totalIndices)
      : new Uint16Array(totalIndices);
    let indexOffset = 0;
    let vertexOffset = 0;
    for (let index = 0; index < primitives.length; index += 1) {
      const primitive = primitives[index]!;
      const source = primitive.indices;
      for (let item = 0; item < source.length; item += 1) {
        indices[indexOffset + item] = source[item]! + vertexOffset;
      }
      indexOffset += source.length;
      vertexOffset += primitive.vertexCount;
    }

    return {
      vertices,
      indices,
      format: needsUint32 ? "uint32" : "uint16",
      bounds,
    };
  }

  private createMaterialEntry(
    assetId: string,
    data: MaterialData,
  ): MaterialEntry {
    const created: TextureEntry[] = [];
    const acquired: TextureEntry[] = [];
    try {
      const baseColorTexture = this.acquireTexture(
        data.baseColorTexture,
        created,
        acquired,
      );
      const metallicRoughnessTexture = this.acquireTexture(
        data.metallicRoughnessTexture,
        created,
        acquired,
      );
      const normalTexture = this.acquireTexture(
        data.normalTexture,
        created,
        acquired,
      );
      const occlusionTexture = this.acquireTexture(
        data.occlusionTexture,
        created,
        acquired,
      );
      const emissiveTexture = this.acquireTexture(
        data.emissiveTexture,
        created,
        acquired,
      );

      const desc: MaterialDesc = {
        label: assetId,
        baseColorFactor: data.baseColorFactor,
        metallic: data.metallic,
        roughness: data.roughness,
        emissiveFactor: data.emissiveFactor,
        baseColorTexture,
        metallicRoughnessTexture,
        normalTexture,
        normalScale: data.normalScale,
        occlusionTexture,
        occlusionStrength: data.occlusionStrength,
        emissiveTexture,
        alphaMode: data.alphaMode,
        alphaCutoff: data.alphaCutoff,
        doubleSided: data.doubleSided,
        unlit: data.unlit,
      };
      const handle = this.device.createMaterial(desc);
      const textureIds: string[] = [];
      for (let index = 0; index < acquired.length; index += 1) {
        textureIds.push(acquired[index]!.id);
      }
      return {
        kind: "material",
        id: assetId,
        handle,
        refs: 1,
        destroyed: false,
        textureIds,
      };
    } catch (error) {
      // Drop every reference this attempt acquired, then destroy the
      // resources it created; nothing from a failed upload is cached.
      for (let index = 0; index < acquired.length; index += 1) {
        const texture = acquired[index]!;
        if (texture.refs > 0) texture.refs -= 1;
      }
      for (let index = 0; index < created.length; index += 1) {
        this.destroyEntry(created[index]!);
      }
      throw error;
    }
  }

  /**
   * Resolves one `MaterialData` texture id through the same cache. The
   * material takes one reference; `created` records textures this material
   * attempt brought into existence so a failure can destroy them.
   */
  private acquireTexture(
    textureId: string | null,
    created: TextureEntry[],
    acquired: TextureEntry[],
  ): TextureHandle | null {
    if (textureId === null) return null;

    const cached = this.entries.get(textureId);
    if (cached !== undefined) {
      if (cached.kind !== "texture") {
        throw bridgeError(
          "E_ASSET_FORMAT",
          `${textureId}: material texture slot is not a texture asset`,
        );
      }
      cached.refs += 1;
      acquired.push(cached);
      return cached.handle;
    }

    const asset = this.library.get<TextureData>(textureId);
    if (asset === undefined || asset.state !== "ready") {
      throw bridgeError(
        "E_ASSET_NOT_READY",
        `${textureId}: material texture is not ready`,
      );
    }
    if (asset.kind !== "texture") {
      throw bridgeError(
        "E_ASSET_FORMAT",
        `${textureId}: material texture slot is not a texture asset`,
      );
    }

    const entry = this.createTextureEntry(textureId, asset.value);
    this.entries.set(textureId, entry);
    entry.refs += 1;
    created.push(entry);
    acquired.push(entry);
    return entry.handle;
  }
}

/** Creates the decoded-asset -> GPU-resource bridge. */
export function createAssetBridge(
  device: AssetBridgeDevice,
  library: AssetBridgeLibrary,
  options: AssetBridgeOptions = {},
): AssetBridge {
  return new AssetBridgeImpl(device, library, options);
}

/** Exposed for tests and tooling: the ABI 1 vertex stride. */
export const ASSET_BRIDGE_VERTEX_STRIDE = VERTEX_STRIDE_BYTES;
