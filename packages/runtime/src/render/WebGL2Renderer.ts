/**
 * Thin custom WebGL2 renderer (D3-RT-02).
 *
 * Implements `Renderer3D` with one shader program, one cube mesh and an
 * instanced draw path. It is intentionally small: no textures, no shadows, no
 * post-processing, and no third-party engine. E12 (D3-EXP-01) decides whether
 * a Three.js backend or this custom path wins; either way the swap stays
 * behind `Renderer3D` and `CubeDemo` is untouched.
 *
 * Hot-path rules (PR-9.3/9.5):
 * - matrices, instance data, camera state and the frustum planes are
 *   preallocated at construction; `setCamera`, `drawCube` and `drawCubes`
 *   only write into those buffers;
 * - repeated cubes are packed into one instance buffer and drawn with one
 *   `drawArraysInstanced` call (PR-9.6);
 * - every cube is sphere-tested against the view frustum before it reaches
 *   the GPU (PR-9.7);
 * - the only possible allocation in `drawCubes` is growing the instance
 *   buffer when a batch exceeds its current capacity.
 *
 * The instance shader applies the per-instance Y rotation so a single mesh
 * serves every cube. `drawCube` is the same path with one instance, which
 * keeps one code path for both calls.
 */
import {
  listCompressedFormats,
  readMaxTextureSize,
  readSupportedExtensions,
} from "./capability.js";
import type {
  Renderer3D,
  RendererCapabilities,
  RendererOptions,
  RendererSize,
} from "./Renderer.js";

const FLOATS_PER_VERTEX = 6;
const FLOATS_PER_INSTANCE = 8;
const VERTICES_PER_CUBE = 36;
const DEFAULT_INSTANCE_CAPACITY = 256;
const MAX_INSTANCE_CAPACITY = 65536;
/** PLAN rule: repeated meshes above ten copies use instancing (PR-9.6). */
export const INSTANCING_THRESHOLD = 10;
/** Half-diagonal of a unit cube: bounding sphere radius for `size`. */
const CUBE_BOUNDING_RADIUS = Math.sqrt(3) / 2;
const FIELD_OF_VIEW_RADIANS = Math.PI / 3;
const NEAR_PLANE = 0.1;
const FAR_PLANE = 100;
const BACKGROUND_R = 0.043;
const BACKGROUND_G = 0.059;
const BACKGROUND_B = 0.078;

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aShade;
layout(location = 2) in vec3 iOffset;
layout(location = 3) in float iSize;
layout(location = 4) in float iRotation;
layout(location = 5) in vec3 iTint;
uniform mat4 uViewProjection;
out vec3 vColor;
void main() {
  float c = cos(iRotation);
  float s = sin(iRotation);
  vec3 p = aPosition * iSize;
  vec3 rotated = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  vec3 world = rotated + iOffset;
  gl_Position = uViewProjection * vec4(world, 1.0);
  vColor = aShade * iTint;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec3 vColor;
out vec4 outColor;
void main() {
  outColor = vec4(vColor, 1.0);
}
`;

interface FaceDefinition {
  readonly shade: number;
  /** Four corners in counter-clockwise order, unit cube centered on origin. */
  readonly corners: ReadonlyArray<readonly [number, number, number]>;
}

const CUBE_FACES: ReadonlyArray<FaceDefinition> = [
  {
    shade: 0.72,
    corners: [
      [0.5, -0.5, -0.5],
      [-0.5, -0.5, -0.5],
      [-0.5, 0.5, -0.5],
      [0.5, 0.5, -0.5],
    ],
  },
  {
    shade: 1,
    corners: [
      [-0.5, -0.5, 0.5],
      [0.5, -0.5, 0.5],
      [0.5, 0.5, 0.5],
      [-0.5, 0.5, 0.5],
    ],
  },
  {
    shade: 0.84,
    corners: [
      [0.5, -0.5, 0.5],
      [0.5, -0.5, -0.5],
      [0.5, 0.5, -0.5],
      [0.5, 0.5, 0.5],
    ],
  },
  {
    shade: 0.76,
    corners: [
      [-0.5, -0.5, -0.5],
      [-0.5, -0.5, 0.5],
      [-0.5, 0.5, 0.5],
      [-0.5, 0.5, -0.5],
    ],
  },
  {
    shade: 1,
    corners: [
      [-0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
      [0.5, 0.5, -0.5],
      [-0.5, 0.5, -0.5],
    ],
  },
  {
    shade: 0.55,
    corners: [
      [-0.5, -0.5, -0.5],
      [0.5, -0.5, -0.5],
      [0.5, -0.5, 0.5],
      [-0.5, -0.5, 0.5],
    ],
  },
];

/** Preallocated per-instance fields; caller-owned and read, never retained. */
export interface CubeInstance {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly size: number;
  readonly rotationY: number;
  readonly color: string;
}

function at(array: Float32Array, index: number): number {
  const value = array[index];
  return value === undefined ? 0 : value;
}

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function buildCubeVertices(): Float32Array {
  const vertices = new Float32Array(
    CUBE_FACES.length * 6 * FLOATS_PER_VERTEX,
  );
  let offset = 0;
  for (const face of CUBE_FACES) {
    const a = face.corners[0];
    const b = face.corners[1];
    const c = face.corners[2];
    const d = face.corners[3];
    if (a === undefined || b === undefined || c === undefined || d === undefined) {
      continue;
    }
    for (const corner of [a, b, c, a, c, d]) {
      vertices[offset] = corner[0];
      vertices[offset + 1] = corner[1];
      vertices[offset + 2] = corner[2];
      vertices[offset + 3] = face.shade;
      vertices[offset + 4] = face.shade;
      vertices[offset + 5] = face.shade;
      offset += FLOATS_PER_VERTEX;
    }
  }
  return vertices;
}

function hexDigit(code: number): number {
  if (code >= 48 && code <= 57) {
    return code - 48;
  }
  if (code >= 65 && code <= 70) {
    return code - 55;
  }
  if (code >= 97 && code <= 102) {
    return code - 87;
  }
  return -1;
}

/**
 * Parses `#rgb` / `#rrggbb` into `target[offset..offset+2]`. Invalid colors
 * become white. Character codes are read directly so a constant color string
 * costs no allocations per frame.
 */
export function parseHexColorInto(
  color: string,
  target: Float32Array,
  offset: number,
): void {
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
    target[offset] =
      (hexDigit(color.charCodeAt(1)) * 16 + hexDigit(color.charCodeAt(2))) / 255;
    target[offset + 1] =
      (hexDigit(color.charCodeAt(3)) * 16 + hexDigit(color.charCodeAt(4))) / 255;
    target[offset + 2] =
      (hexDigit(color.charCodeAt(5)) * 16 + hexDigit(color.charCodeAt(6))) / 255;
    return;
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
    target[offset] = (r * 17) / 255;
    target[offset + 1] = (g * 17) / 255;
    target[offset + 2] = (b * 17) / 255;
    return;
  }
  target[offset] = 1;
  target[offset + 1] = 1;
  target[offset + 2] = 1;
}

function writeInstance(
  data: Float32Array,
  index: number,
  x: number,
  y: number,
  z: number,
  size: number,
  rotationY: number,
  color: string,
): void {
  const base = index * FLOATS_PER_INSTANCE;
  data[base] = x;
  data[base + 1] = y;
  data[base + 2] = z;
  data[base + 3] = size;
  data[base + 4] = rotationY;
  parseHexColorInto(color, data, base + 5);
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) {
    throw new Error("WebGL2 failed to create a shader.");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    throw new Error(`WebGL2 shader compilation failed: ${log}`);
  }
  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (program === null) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    throw new Error("WebGL2 failed to create a program.");
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "";
    gl.deleteProgram(program);
    throw new Error(`WebGL2 program link failed: ${log}`);
  }
  return program;
}

export class WebGL2Renderer implements Renderer3D {
  readonly backend = "webgl2" as const;

  private readonly maxRenderHeight: number;

  private gl: WebGL2RenderingContext | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private program: WebGLProgram | null = null;
  private vertexArray: WebGLVertexArrayObject | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private instanceBuffer: WebGLBuffer | null = null;
  private viewProjectionLocation: WebGLUniformLocation | null = null;

  /** Grows only when a batch exceeds capacity; steady state never allocates. */
  private instanceData = new Float32Array(
    DEFAULT_INSTANCE_CAPACITY * FLOATS_PER_INSTANCE,
  );

  private readonly projection = new Float32Array(16);
  private readonly view = new Float32Array(16);
  private readonly viewProjection = new Float32Array(16);
  private readonly frustumPlanes = new Float32Array(24);

  private cameraX = 0;
  private cameraY = 0;
  private cameraZ = 3;
  private targetX = 0;
  private targetY = 0;
  private targetZ = 0;

  private cssWidth = 1;
  private cssHeight = 1;
  private backingWidth = 1;
  private backingHeight = 1;
  private drawCallCount = 0;
  private culledCount = 0;
  private disposed = false;
  /** Stable object updated by `resize`; read the fields, never retain them. */
  private readonly surfaceSize: { width: number; height: number } = {
    width: 0,
    height: 0,
  };

  constructor(options: RendererOptions = {}) {
    this.maxRenderHeight = options.maxRenderHeight ?? 0;
  }

  /** Actual CSS size; zero before the host's first `resize` (HP-04). */
  get size(): RendererSize {
    return this.surfaceSize;
  }

  get drawCalls(): number {
    return this.drawCallCount;
  }

  get textureMemoryMB(): number {
    return 0;
  }

  /** Cubes rejected by the frustum test in the current frame (PR-9.7). */
  get culledCubes(): number {
    return this.culledCount;
  }

  async init(canvas: HTMLCanvasElement): Promise<RendererCapabilities> {
    if (this.disposed) {
      throw new Error("WebGL2Renderer cannot be reused after dispose().");
    }
    let gl: WebGL2RenderingContext | null;
    try {
      gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: true,
        depth: true,
        powerPreference: "high-performance",
      });
    } catch {
      gl = null;
    }
    if (gl === null) {
      throw new Error("WebGL2 context is unavailable.");
    }

    this.gl = gl;
    this.canvas = canvas;

    try {
      this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
      this.viewProjectionLocation = gl.getUniformLocation(
        this.program,
        "uViewProjection",
      );
      if (this.viewProjectionLocation === null) {
        throw new Error("WebGL2 uniform uViewProjection is missing.");
      }

      this.vertexBuffer = gl.createBuffer();
      this.instanceBuffer = gl.createBuffer();
      this.vertexArray = gl.createVertexArray();
      if (
        this.vertexBuffer === null ||
        this.instanceBuffer === null ||
        this.vertexArray === null
      ) {
        throw new Error("WebGL2 failed to allocate buffers.");
      }

      const vertices = buildCubeVertices();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);

      gl.bindVertexArray(this.vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      const vertexStride = FLOATS_PER_VERTEX * 4;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, vertexStride, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, vertexStride, 3 * 4);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      const instanceStride = FLOATS_PER_INSTANCE * 4;
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, instanceStride, 0);
      gl.vertexAttribDivisor(2, 1);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, instanceStride, 3 * 4);
      gl.vertexAttribDivisor(3, 1);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 1, gl.FLOAT, false, instanceStride, 4 * 4);
      gl.vertexAttribDivisor(4, 1);
      gl.enableVertexAttribArray(5);
      gl.vertexAttribPointer(5, 3, gl.FLOAT, false, instanceStride, 5 * 4);
      gl.vertexAttribDivisor(5, 1);

      gl.bindVertexArray(null);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);

      this.cssWidth = positiveOr(canvas.width, 1);
      this.cssHeight = positiveOr(canvas.height, 1);
      this.backingWidth = this.cssWidth;
      this.backingHeight = this.cssHeight;
      this.updateProjection();
      this.updateViewProjection();
      this.updateFrustum();
    } catch (error) {
      this.dispose();
      throw error instanceof Error
        ? error
        : new Error("WebGL2 renderer initialization failed.");
    }

    return {
      maxTextureSize: readMaxTextureSize(gl),
      compressedFormats: listCompressedFormats(readSupportedExtensions(gl)),
    };
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const gl = this.requireGl();
    const canvas = this.requireCanvas();
    const width = positiveOr(cssWidth, 1);
    const height = positiveOr(cssHeight, 1);
    const density = positiveOr(dpr, 1);

    let backingWidth = Math.max(1, Math.round(width * density));
    let backingHeight = Math.max(1, Math.round(height * density));
    if (this.maxRenderHeight > 0 && backingHeight > this.maxRenderHeight) {
      const ratio = this.maxRenderHeight / backingHeight;
      backingWidth = Math.max(1, Math.round(backingWidth * ratio));
      backingHeight = this.maxRenderHeight;
    }

    canvas.width = backingWidth;
    canvas.height = backingHeight;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    this.cssWidth = width;
    this.cssHeight = height;
    this.surfaceSize.width = width;
    this.surfaceSize.height = height;
    this.backingWidth = backingWidth;
    this.backingHeight = backingHeight;
    gl.viewport(0, 0, backingWidth, backingHeight);
    this.updateProjection();
    this.updateViewProjection();
    this.updateFrustum();
  }

  beginFrame(alpha: number): void {
    void alpha;
    const gl = this.requireGl();
    this.drawCallCount = 0;
    this.culledCount = 0;

    gl.viewport(0, 0, this.backingWidth, this.backingHeight);
    gl.clearColor(BACKGROUND_R, BACKGROUND_G, BACKGROUND_B, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(
      this.viewProjectionLocation,
      false,
      this.viewProjection,
    );
    gl.bindVertexArray(this.vertexArray);
  }

  endFrame(): void {
    // One pass, no offscreen targets: nothing to flush.
  }

  setCamera(
    position: { x: number; y: number; z: number },
    target: { x: number; y: number; z: number },
  ): void {
    this.cameraX = position.x;
    this.cameraY = position.y;
    this.cameraZ = position.z;
    this.targetX = target.x;
    this.targetY = target.y;
    this.targetZ = target.z;
    this.updateViewProjection();
    this.updateFrustum();
  }

  drawCube(
    position: { x: number; y: number; z: number },
    size: number,
    color: string,
    rotationY: number,
  ): void {
    const gl = this.requireGl();
    const safeSize = Math.max(0, size);
    if (
      !this.isSphereVisible(
        position.x,
        position.y,
        position.z,
        safeSize * CUBE_BOUNDING_RADIUS,
      )
    ) {
      this.culledCount += 1;
      return;
    }
    this.ensureInstanceCapacity(1);
    writeInstance(
      this.instanceData,
      0,
      position.x,
      position.y,
      position.z,
      safeSize,
      rotationY,
      color,
    );
    this.uploadInstances(1);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, VERTICES_PER_CUBE, 1);
    this.drawCallCount += 1;
  }

  /**
   * Draws a batch of cubes with one instanced draw call (PR-9.6), culling each
   * cube individually first (PR-9.7). `instances` is read, never retained.
   */
  drawCubes(instances: readonly CubeInstance[], count?: number): void {
    const gl = this.requireGl();
    const requested = count === undefined ? instances.length : count;
    const total = Math.min(Math.max(0, requested), instances.length);
    if (total === 0) {
      return;
    }
    this.ensureInstanceCapacity(total);

    let visible = 0;
    for (let index = 0; index < total; index += 1) {
      const cube = instances[index];
      if (cube === undefined) {
        continue;
      }
      const size = Math.max(0, cube.size);
      if (
        !this.isSphereVisible(
          cube.x,
          cube.y,
          cube.z,
          size * CUBE_BOUNDING_RADIUS,
        )
      ) {
        this.culledCount += 1;
        continue;
      }
      writeInstance(
        this.instanceData,
        visible,
        cube.x,
        cube.y,
        cube.z,
        size,
        cube.rotationY,
        cube.color,
      );
      visible += 1;
    }

    if (visible === 0) {
      return;
    }
    this.uploadInstances(visible);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, VERTICES_PER_CUBE, visible);
    this.drawCallCount += 1;
  }

  dispose(): void {
    const gl = this.gl;
    if (gl !== null) {
      if (this.vertexArray !== null) {
        gl.deleteVertexArray(this.vertexArray);
      }
      if (this.vertexBuffer !== null) {
        gl.deleteBuffer(this.vertexBuffer);
      }
      if (this.instanceBuffer !== null) {
        gl.deleteBuffer(this.instanceBuffer);
      }
      if (this.program !== null) {
        gl.deleteProgram(this.program);
      }
    }
    this.vertexArray = null;
    this.vertexBuffer = null;
    this.instanceBuffer = null;
    this.program = null;
    this.viewProjectionLocation = null;
    this.gl = null;
    this.canvas = null;
    this.disposed = true;
    this.drawCallCount = 0;
    this.culledCount = 0;
  }

  private requireGl(): WebGL2RenderingContext {
    if (this.gl === null) {
      throw new Error("WebGL2Renderer.init(canvas) must run before drawing.");
    }
    return this.gl;
  }

  private requireCanvas(): HTMLCanvasElement {
    if (this.canvas === null) {
      throw new Error("WebGL2Renderer.init(canvas) must run before resize.");
    }
    return this.canvas;
  }

  private ensureInstanceCapacity(instances: number): void {
    const required = instances * FLOATS_PER_INSTANCE;
    if (required <= this.instanceData.length) {
      return;
    }
    // Capacity is counted in floats here; the guard is in instances.
    const maxFloats = MAX_INSTANCE_CAPACITY * FLOATS_PER_INSTANCE;
    let capacity = this.instanceData.length;
    while (capacity < required && capacity < maxFloats) {
      capacity = Math.min(capacity * 2, maxFloats);
    }
    if (capacity < required) {
      throw new RangeError(
        `drawCubes supports at most ${MAX_INSTANCE_CAPACITY} instances.`,
      );
    }
    const next = new Float32Array(capacity);
    next.set(this.instanceData);
    this.instanceData = next;

    const gl = this.gl;
    if (gl !== null && this.instanceBuffer !== null) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, next.byteLength, gl.DYNAMIC_DRAW);
    }
  }

  private uploadInstances(count: number): void {
    const gl = this.requireGl();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.instanceData,
      0,
      count * FLOATS_PER_INSTANCE,
    );
  }

  private updateProjection(): void {
    const aspect = this.cssHeight > 0 ? this.cssWidth / this.cssHeight : 1;
    const f = 1 / Math.tan(FIELD_OF_VIEW_RADIANS / 2);
    const range = 1 / (NEAR_PLANE - FAR_PLANE);
    const m = this.projection;
    m[0] = f / (aspect > 0 ? aspect : 1);
    m[1] = 0;
    m[2] = 0;
    m[3] = 0;
    m[4] = 0;
    m[5] = f;
    m[6] = 0;
    m[7] = 0;
    m[8] = 0;
    m[9] = 0;
    m[10] = (NEAR_PLANE + FAR_PLANE) * range;
    m[11] = -1;
    m[12] = 0;
    m[13] = 0;
    m[14] = 2 * NEAR_PLANE * FAR_PLANE * range;
    m[15] = 0;
  }

  private updateViewProjection(): void {
    const fwdX = this.targetX - this.cameraX;
    const fwdY = this.targetY - this.cameraY;
    const fwdZ = this.targetZ - this.cameraZ;
    const fwdLength = Math.hypot(fwdX, fwdY, fwdZ);
    const fx = fwdLength > 0 ? fwdX / fwdLength : 0;
    const fy = fwdLength > 0 ? fwdY / fwdLength : 0;
    const fz = fwdLength > 0 ? fwdZ / fwdLength : -1;

    // side = normalize(cross(forward, up)), up = (0, 1, 0).
    let sx = -fz;
    let sy = 0;
    let sz = fx;
    const sideLength = Math.hypot(sx, sy, sz);
    if (sideLength > 0) {
      sx /= sideLength;
      sy /= sideLength;
      sz /= sideLength;
    } else {
      sx = 1;
      sy = 0;
      sz = 0;
    }

    const ux = sy * fz - sz * fy;
    const uy = sz * fx - sx * fz;
    const uz = sx * fy - sy * fx;

    const v = this.view;
    v[0] = sx;
    v[1] = ux;
    v[2] = -fx;
    v[3] = 0;
    v[4] = sy;
    v[5] = uy;
    v[6] = -fy;
    v[7] = 0;
    v[8] = sz;
    v[9] = uz;
    v[10] = -fz;
    v[11] = 0;
    v[12] = -(sx * this.cameraX + sy * this.cameraY + sz * this.cameraZ);
    v[13] = -(ux * this.cameraX + uy * this.cameraY + uz * this.cameraZ);
    v[14] = fx * this.cameraX + fy * this.cameraY + fz * this.cameraZ;
    v[15] = 1;

    multiplyMat4(this.viewProjection, this.projection, v);
  }

  private updateFrustum(): void {
    const m = this.viewProjection;
    // Gribb-Hartmann planes for a column-major clip matrix.
    this.setPlane(0, at(m, 3) + at(m, 0), at(m, 7) + at(m, 4), at(m, 11) + at(m, 8), at(m, 15) + at(m, 12));
    this.setPlane(1, at(m, 3) - at(m, 0), at(m, 7) - at(m, 4), at(m, 11) - at(m, 8), at(m, 15) - at(m, 12));
    this.setPlane(2, at(m, 3) + at(m, 1), at(m, 7) + at(m, 5), at(m, 11) + at(m, 9), at(m, 15) + at(m, 13));
    this.setPlane(3, at(m, 3) - at(m, 1), at(m, 7) - at(m, 5), at(m, 11) - at(m, 9), at(m, 15) - at(m, 13));
    this.setPlane(4, at(m, 3) + at(m, 2), at(m, 7) + at(m, 6), at(m, 11) + at(m, 10), at(m, 15) + at(m, 14));
    this.setPlane(5, at(m, 3) - at(m, 2), at(m, 7) - at(m, 6), at(m, 11) - at(m, 10), at(m, 15) - at(m, 14));
  }

  private setPlane(
    index: number,
    a: number,
    b: number,
    c: number,
    d: number,
  ): void {
    const length = Math.hypot(a, b, c);
    const base = index * 4;
    if (length > 0) {
      this.frustumPlanes[base] = a / length;
      this.frustumPlanes[base + 1] = b / length;
      this.frustumPlanes[base + 2] = c / length;
      this.frustumPlanes[base + 3] = d / length;
    } else {
      this.frustumPlanes[base] = 0;
      this.frustumPlanes[base + 1] = 0;
      this.frustumPlanes[base + 2] = 0;
      this.frustumPlanes[base + 3] = 0;
    }
  }

  private isSphereVisible(
    x: number,
    y: number,
    z: number,
    radius: number,
  ): boolean {
    const planes = this.frustumPlanes;
    for (let plane = 0; plane < 6; plane += 1) {
      const base = plane * 4;
      const distance =
        at(planes, base) * x +
        at(planes, base + 1) * y +
        at(planes, base + 2) * z +
        at(planes, base + 3);
      if (distance < -radius) {
        return false;
      }
    }
    return true;
  }
}

/** `out = a * b` for column-major 4x4 matrices. No allocation. */
function multiplyMat4(
  out: Float32Array,
  a: Float32Array,
  b: Float32Array,
): void {
  for (let column = 0; column < 4; column += 1) {
    const columnBase = column * 4;
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += at(a, k * 4 + row) * at(b, columnBase + k);
      }
      out[columnBase + row] = sum;
    }
  }
}
