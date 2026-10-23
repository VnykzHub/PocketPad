/**
 * Legacy `Renderer3D` adapter over an engine 3D `RenderDevice` (00 §5.12).
 *
 * The bundled games draw through the SDK's renderer shape, which the runtime's
 * `Renderer3D` has satisfied since D7. A game that declares
 * `"renderer": "engine"` is routed here: the stage has already selected and
 * initialized a WebGPU or WebGL2 device, and this adapter is the only glue
 * between `setCamera`/`drawCube` and the engine's retained frame contract.
 *
 * Frame model: `setCamera` and `drawCube` only record state. The engine frame
 * exists between `beginFrame` and `endFrame`, so `endFrame` issues one
 * `drawInstanced` per distinct color and then flushes the device. Cube
 * instances are grouped by color because one unit-cube mesh serves every cube
 * and a material owns the color.
 *
 * Allocation: the mesh, camera vectors, matrices and per-material instance
 * buffers are allocated on the cold path (init or first use of a color).
 * Steady-state `beginFrame`/`setCamera`/`drawCube`/`endFrame` allocate nothing
 * unless a color bucket outgrows its preallocated capacity.
 *
 * Backend: the adapter reports `device.backend` (`webgpu` or `webgl2`); the
 * runtime's legacy union was widened additively to include `webgpu` so the
 * overlay never claims WebGL2 while WebGPU is drawing.
 */
import {
  mat4Create,
  mat4LookAt,
  mat4Multiply,
  mat4PerspectiveWebGL2,
  mat4PerspectiveWebGPU,
} from "@lanpad/engine-core";
import type {
  EngineErrorCode,
  Mat4,
  MaterialHandle,
  MeshHandle,
  RenderDevice,
  RenderFrame,
  Vec3,
} from "@lanpad/engine-core";
import type {
  Renderer3D,
  RendererBackend,
  RendererCapabilities,
  RendererSize,
} from "../render/Renderer.js";

/** Matches `WebGL2Renderer` so `CubeDemo` keeps the same framing (FOV 60°). */
const FIELD_OF_VIEW_RADIANS = Math.PI / 3;
const NEAR_PLANE = 0.1;
const FAR_PLANE = 100;

/** The same initial camera `CubeDemo` approaches on its first frame. */
const DEFAULT_CAMERA_X = 0;
const DEFAULT_CAMERA_Y = 1.2;
const DEFAULT_CAMERA_Z = 3.2;

const CUBE_HALF_EXTENT = 0.5;
const FLOATS_PER_INSTANCE = 16;
const DEFAULT_MAX_MATERIALS = 64;
const DEFAULT_INSTANCES_PER_MATERIAL = 256;
const BYTES_PER_MB = 1024 * 1024;

/** Compressed tokens the engine vocabulary may report, in display order. */
const COMPRESSED_FORMATS: ReadonlySet<string> = new Set([
  "s3tc-dxt1",
  "s3tc-dxt3",
  "s3tc-dxt5",
  "etc2-rgb8",
  "etc2-rgba8",
  "astc-4x4",
  "astc-6x6",
  "astc-8x8",
  "bptc-rgba",
]);

const FACES = [
  { normal: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { normal: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { normal: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
] as const;

const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

const UVS = [
  [0, 1],
  [1, 1],
  [1, 0],
  [0, 0],
] as const;

export interface EngineGameRendererOptions {
  /** Distinct colors cached before `E_UNSUPPORTED_FEATURE`. Default 64. */
  readonly maxMaterials?: number;
  /** Preallocated instances per color. Default 256; grows on demand. */
  readonly instancesPerMaterial?: number;
  /** Vertical field of view in radians. Default 60°. */
  readonly fovY?: number;
  /** Default 0.1. */
  readonly near?: number;
  /** Default 100. */
  readonly far?: number;
  /** Stable label prefix for GPU resources. Default "engine-game". */
  readonly label?: string;
}

/** Engine-shaped error for adapter limits; `code` is the public contract. */
export class EngineGameRendererError extends Error {
  readonly code: EngineErrorCode;
  readonly layer = "host" as const;
  readonly recoverable = false;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = "EngineGameRendererError";
    this.code = code;
  }
}

interface MaterialBucket {
  readonly key: string;
  readonly handle: MaterialHandle;
  capacity: number;
  count: number;
  transforms: Float32Array;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

/** Builds one interleaved ABI 1 cube: position(3), normal(3), uv(2). */
function buildCubeGeometry(): {
  vertices: Float32Array;
  indices: Uint16Array;
} {
  const vertices = new Float32Array(FACES.length * 4 * 8);
  const indices = new Uint16Array(FACES.length * 6);
  let vertexIndex = 0;
  let indexOffset = 0;

  for (let faceIndex = 0; faceIndex < FACES.length; faceIndex += 1) {
    const face = FACES[faceIndex]!;
    for (let corner = 0; corner < 4; corner += 1) {
      const [su, sv] = CORNERS[corner]!;
      const [uvU, uvV] = UVS[corner]!;
      const offset = vertexIndex * 8;
      vertices[offset] =
        face.normal[0] * CUBE_HALF_EXTENT +
        face.u[0] * su * CUBE_HALF_EXTENT +
        face.v[0] * sv * CUBE_HALF_EXTENT;
      vertices[offset + 1] =
        face.normal[1] * CUBE_HALF_EXTENT +
        face.u[1] * su * CUBE_HALF_EXTENT +
        face.v[1] * sv * CUBE_HALF_EXTENT;
      vertices[offset + 2] =
        face.normal[2] * CUBE_HALF_EXTENT +
        face.u[2] * su * CUBE_HALF_EXTENT +
        face.v[2] * sv * CUBE_HALF_EXTENT;
      vertices[offset + 3] = face.normal[0];
      vertices[offset + 4] = face.normal[1];
      vertices[offset + 5] = face.normal[2];
      vertices[offset + 6] = uvU;
      vertices[offset + 7] = uvV;
      vertexIndex += 1;
    }

    const base = faceIndex * 4;
    indices[indexOffset] = base;
    indices[indexOffset + 1] = base + 1;
    indices[indexOffset + 2] = base + 2;
    indices[indexOffset + 3] = base;
    indices[indexOffset + 4] = base + 2;
    indices[indexOffset + 5] = base + 3;
    indexOffset += 6;
  }

  return { vertices, indices };
}

function hexDigit(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

/**
 * Parses `#rgb` / `#rrggbb` into normalized channels. Invalid colors become
 * white, matching the legacy WebGL2 renderer. Cold path only: called when a
 * color is first seen.
 */
/**
 * CSS colors are passed through as normalized sRGB values for now. The engine
 * WebGPU swapchain is `bgra8unorm` and its shader does not encode linear
 * output (RV-76), so a true sRGB→linear conversion here would make the cubes
 * darker, not correct. The fix belongs in the renderer: an sRGB canvas format
 * or a shader output encode, followed by re-recorded goldens.
 */
function parseHexColor(color: string): [number, number, number] {
  if (
    color.length === 7 &&
    color.charCodeAt(0) === 35 &&
    hexDigit(color.charCodeAt(1)) >= 0 &&
    hexDigit(color.charCodeAt(2)) >= 0 &&
    hexDigit(color.charCodeAt(3)) >= 0 &&
    hexDigit(color.charCodeAt(4)) >= 0 &&
    hexDigit(color.charCodeAt(5)) >= 0 &&
    hexDigit(color.charCodeAt(6)) >= 0
  ) {
    return [
      (hexDigit(color.charCodeAt(1)) * 16 + hexDigit(color.charCodeAt(2))) / 255,
      (hexDigit(color.charCodeAt(3)) * 16 + hexDigit(color.charCodeAt(4))) / 255,
      (hexDigit(color.charCodeAt(5)) * 16 + hexDigit(color.charCodeAt(6))) / 255,
    ];
  }
  if (
    color.length === 4 &&
    color.charCodeAt(0) === 35 &&
    hexDigit(color.charCodeAt(1)) >= 0 &&
    hexDigit(color.charCodeAt(2)) >= 0 &&
    hexDigit(color.charCodeAt(3)) >= 0
  ) {
    const r = hexDigit(color.charCodeAt(1));
    const g = hexDigit(color.charCodeAt(2));
    const b = hexDigit(color.charCodeAt(3));
    return [(r * 17) / 255, (g * 17) / 255, (b * 17) / 255];
  }
  return [1, 1, 1];
}

function isFinitePosition(position: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}): boolean {
  return (
    Number.isFinite(position.x) &&
    Number.isFinite(position.y) &&
    Number.isFinite(position.z)
  );
}

/** Writes a column-major translate * rotateY * scale instance matrix. */
function writeCubeTransform(
  data: Float32Array,
  index: number,
  x: number,
  y: number,
  z: number,
  size: number,
  rotationY: number,
): void {
  const cosine = Math.cos(rotationY);
  const sine = Math.sin(rotationY);
  const base = index * FLOATS_PER_INSTANCE;
  data[base] = cosine * size;
  data[base + 1] = 0;
  data[base + 2] = -sine * size;
  data[base + 3] = 0;
  data[base + 4] = 0;
  data[base + 5] = size;
  data[base + 6] = 0;
  data[base + 7] = 0;
  data[base + 8] = sine * size;
  data[base + 9] = 0;
  data[base + 10] = cosine * size;
  data[base + 11] = 0;
  data[base + 12] = x;
  data[base + 13] = y;
  data[base + 14] = z;
  data[base + 15] = 1;
}

/**
 * Wraps an already-initialized engine device. `init` only verifies the canvas
 * and uploads the shared cube mesh; it never initializes the device twice.
 * The adapter owns the device and disposes it exactly once.
 */
export class EngineGameRenderer implements Renderer3D {
  /** See the module note: the frozen legacy union has no "webgpu". */
  get backend(): RendererBackend {
    return this.device.backend;
  }

  private readonly device: RenderDevice;
  private readonly canvas: HTMLCanvasElement;
  private readonly label: string;
  private readonly fovY: number;
  private readonly near: number;
  private readonly far: number;
  private readonly maxMaterials: number;
  private readonly instancesPerMaterial: number;
  private readonly capabilities: RendererCapabilities;
  private readonly surfaceSize = { width: 0, height: 0 };

  private readonly eye: Vec3 = {
    x: DEFAULT_CAMERA_X,
    y: DEFAULT_CAMERA_Y,
    z: DEFAULT_CAMERA_Z,
  };
  private readonly target: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly up: Vec3 = { x: 0, y: 1, z: 0 };
  private readonly view: Mat4 = mat4Create();
  private readonly projection: Mat4 = mat4Create();
  private readonly viewProjection: Mat4 = mat4Create();

  private readonly materials: MaterialBucket[] = [];
  private mesh: MeshHandle | null = null;
  private frame: RenderFrame | null = null;
  private frameDrawCalls = 0;
  private disposed = false;

  constructor(
    device: RenderDevice,
    canvas: HTMLCanvasElement,
    options: EngineGameRendererOptions = {},
  ) {
    this.device = device;
    this.canvas = canvas;
    this.label = options.label ?? "engine-game";
    this.fovY = positiveOr(options.fovY, FIELD_OF_VIEW_RADIANS);
    this.near = positiveOr(options.near, NEAR_PLANE);
    const far = positiveOr(options.far, FAR_PLANE);
    this.far = far > this.near ? far : FAR_PLANE;
    this.maxMaterials = positiveIntegerOr(
      options.maxMaterials,
      DEFAULT_MAX_MATERIALS,
    );
    this.instancesPerMaterial = positiveIntegerOr(
      options.instancesPerMaterial,
      DEFAULT_INSTANCES_PER_MATERIAL,
    );

    const compressedFormats: string[] = [];
    for (const format of device.capabilities.supportedFormats) {
      if (COMPRESSED_FORMATS.has(format)) compressedFormats.push(format);
    }
    compressedFormats.sort();
    this.capabilities = {
      maxTextureSize: device.capabilities.maxTextureSize,
      compressedFormats,
    };
    this.updateCamera();
  }

  /** CSS size since the last `resize`; zero before the host's first call. */
  get size(): RendererSize {
    return this.surfaceSize;
  }

  get drawCalls(): number {
    return this.frameDrawCalls;
  }

  get textureMemoryMB(): number {
    return this.device.stats.textureBytes / BYTES_PER_MB;
  }

  async init(target: HTMLCanvasElement): Promise<RendererCapabilities> {
    if (this.disposed) {
      throw new Error("EngineGameRenderer cannot be reused after dispose().");
    }
    if (target !== this.canvas) {
      throw new Error("The engine device was created for a different canvas.");
    }
    if (this.mesh !== null) return this.capabilities;

    try {
      const geometry = buildCubeGeometry();
      this.mesh = this.device.createMesh({
        label: `${this.label}-unit-cube`,
        layout: "instanced-transform-v1",
        vertices: [geometry.vertices],
        indices: {
          data: geometry.indices,
          format: "uint16",
        },
        bounds: {
          center: { x: 0, y: 0, z: 0 },
          radius: Math.sqrt(3) * CUBE_HALF_EXTENT,
        },
      });
    } catch (error) {
      // The stage never received this adapter, so it cannot dispose it.
      this.dispose();
      throw error;
    }

    return this.capabilities;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const width = positiveOr(cssWidth, 1);
    const height = positiveOr(cssHeight, 1);
    this.surfaceSize.width = width;
    this.surfaceSize.height = height;
    this.device.resize(width, height, positiveOr(dpr, 1));
    this.updateCamera();
  }

  beginFrame(alpha: number): void {
    void alpha;
    if (this.disposed) {
      throw new Error("EngineGameRenderer cannot be used after dispose().");
    }
    this.frameDrawCalls = 0;
    for (const bucket of this.materials) bucket.count = 0;

    const frame = this.device.beginFrame();
    this.frame = frame;
    this.updateCamera();
    if (frame.valid) frame.setCamera(this.viewProjection);
  }

  endFrame(): void {
    const frame = this.frame;
    if (frame === null) {
      this.frameDrawCalls = 0;
      return;
    }
    this.frame = null;

    let drawCalls = 0;
    const mesh = this.mesh;
    if (frame.valid && mesh !== null) {
      for (const bucket of this.materials) {
        if (bucket.count === 0) continue;
        frame.drawInstanced(mesh, bucket.handle, bucket.transforms, bucket.count);
        bucket.count = 0;
        drawCalls += 1;
      }
    } else {
      for (const bucket of this.materials) bucket.count = 0;
    }
    this.frameDrawCalls = drawCalls;
    this.device.endFrame();
  }

  setCamera(
    position: { x: number; y: number; z: number },
    target: { x: number; y: number; z: number },
  ): void {
    this.eye.x = position.x;
    this.eye.y = position.y;
    this.eye.z = position.z;
    this.target.x = target.x;
    this.target.y = target.y;
    this.target.z = target.z;
    this.updateCamera();
    if (this.frame !== null && this.frame.valid) {
      this.frame.setCamera(this.viewProjection);
    }
  }

  drawCube(
    position: { x: number; y: number; z: number },
    size: number,
    color: string,
    rotationY: number,
  ): void {
    if (this.mesh === null) {
      throw new Error("EngineGameRenderer.init() must complete before drawCube().");
    }
    if (!isFinitePosition(position)) return;
    if (!Number.isFinite(rotationY)) return;
    const safeSize = Number.isFinite(size) && size > 0 ? size : 0;
    if (safeSize === 0) return;

    const bucket = this.materialFor(color);
    if (bucket.count >= bucket.capacity) {
      const grown = new Float32Array(bucket.capacity * 2 * FLOATS_PER_INSTANCE);
      grown.set(bucket.transforms);
      bucket.transforms = grown;
      bucket.capacity *= 2;
    }
    writeCubeTransform(
      bucket.transforms,
      bucket.count,
      position.x,
      position.y,
      position.z,
      safeSize,
      rotationY,
    );
    bucket.count += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.frame = null;

    const mesh = this.mesh;
    this.mesh = null;
    if (mesh !== null) this.device.destroy(mesh);
    for (const bucket of this.materials) this.device.destroy(bucket.handle);
    this.materials.length = 0;
    this.device.dispose();
  }

  private updateCamera(): void {
    const width = this.surfaceSize.width;
    const height = this.surfaceSize.height;
    const aspect = width > 0 && height > 0 ? width / height : 1;
    if (this.device.backend === "webgpu") {
      mat4PerspectiveWebGPU(
        this.projection,
        this.fovY,
        aspect,
        this.near,
        this.far,
      );
    } else {
      mat4PerspectiveWebGL2(
        this.projection,
        this.fovY,
        aspect,
        this.near,
        this.far,
      );
    }
    mat4LookAt(this.view, this.eye, this.target, this.up);
    mat4Multiply(this.viewProjection, this.projection, this.view);
  }

  private materialFor(color: string): MaterialBucket {
    for (const bucket of this.materials) {
      if (bucket.key === color) return bucket;
    }
    if (this.materials.length >= this.maxMaterials) {
      throw new EngineGameRendererError(
        "E_UNSUPPORTED_FEATURE",
        `engine renderer caches at most ${this.maxMaterials} distinct cube colors; "${color.slice(0, 32)}" would exceed that`,
      );
    }

    const [r, g, b] = parseHexColor(color);
    const handle = this.device.createMaterial({
      label: `${this.label}-material-${this.materials.length}`,
      baseColorFactor: [r, g, b, 1],
      metallic: 0,
      roughness: 0.62,
      emissiveFactor: [0, 0, 0],
    });
    const bucket: MaterialBucket = {
      key: color,
      handle,
      capacity: this.instancesPerMaterial,
      count: 0,
      transforms: new Float32Array(
        this.instancesPerMaterial * FLOATS_PER_INSTANCE,
      ),
    };
    this.materials.push(bucket);
    return bucket;
  }
}
