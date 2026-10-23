/**
 * Babylon `Renderer3D` adapter (B1, spec 21 §3.2).
 *
 * The host's frozen game-facing renderer shape is small: camera, cubes, frame
 * boundaries. This class maps it onto a Babylon scene without exposing a
 * Babylon type to any game. The host owns the clock; the adapter never starts
 * `runRenderLoop`.
 *
 * Frame model (`endFrame` is where WebGPU work is submitted):
 *
 *   beginFrame -> engine.beginFrame(), hide last frame's cubes
 *   drawCube   -> enable/reuse a pooled box, set transform and material
 *   endFrame   -> scene.render(), engine.endFrame()
 *
 * Cold path only allocates meshes and materials (first use of a slot/colour).
 * The per-frame path mutates pooled objects and allocates nothing.
 */
import type { Engine } from "@babylonjs/core/Engines/engine";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import type { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import type { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import type { GameWorld3D } from "@lanpad/sdk";
import type {
  Renderer3D,
  RendererCapabilities,
  RendererSize,
} from "../render/Renderer.js";
import type { BabylonWorld3D } from "./world3d/BabylonWorld3D.js";
import type { BabylonWorldOptions } from "./world3d/types.js";
import {
  computeBackingSize,
  isFinitePosition,
  parseHexColor,
} from "./helpers.js";

/** Babylon classes are loaded on `init` so unit tests stay engine-free. */
type BabylonBindings = typeof import("./babylonBindings.js");

/** Either Babylon backend; both expose the frame and sizing API used here. */
export type BabylonEngine = Engine | WebGPUEngine;

export type BabylonBackend = "webgpu" | "webgl2";

export interface BabylonGameRendererOptions {
  /** Pooled cube meshes; further cubes are an error. Default 256. */
  readonly maxCubes?: number;
  /** Vertical field of view in radians. Default 60°. */
  readonly fovY?: number;
  /** Default 0.1. */
  readonly near?: number;
  /** Default 100. */
  readonly far?: number;
  /** Stable label prefix for Babylon resources. Default "babylon-game". */
  readonly label?: string;
}

const FIELD_OF_VIEW_RADIANS = Math.PI / 3;
const NEAR_PLANE = 0.1;
const FAR_PLANE = 100;
const DEFAULT_MAX_CUBES = 256;

const DEFAULT_CAMERA_X = 0;
const DEFAULT_CAMERA_Y = 1.2;
const DEFAULT_CAMERA_Z = 3.2;

/** Matches the custom engine's clear colour so screenshots stay comparable. */
const BACKGROUND_R = 0.043;
const BACKGROUND_G = 0.059;
const BACKGROUND_B = 0.078;

/** Engine caps are read once; texture memory is 0 until textures exist. */
const TEXTURE_MEMORY_MB = 0;

export class BabylonCubeLimitError extends Error {
  readonly code = "E_UNSUPPORTED_FEATURE" as const;

  constructor(limit: number) {
    super(
      `Babylon renderer pool holds at most ${limit} cubes; raise maxCubes or use a Babylon native scene`,
    );
    this.name = "BabylonCubeLimitError";
  }
}

interface CubeSlot {
  mesh: Mesh;
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

/**
 * Wraps an already-created Babylon engine. The factory owns engine creation
 * and disposal ordering; `init` only builds the scene contents.
 */
export class BabylonGameRenderer implements Renderer3D {
  readonly backend: BabylonBackend;

  private readonly engine: BabylonEngine;
  private readonly canvas: HTMLCanvasElement;
  private readonly label: string;
  private readonly maxCubes: number;
  private readonly fovY: number;
  private readonly near: number;
  private readonly far: number;
  private readonly surfaceSize = { width: 0, height: 0 };

  private scene: Scene | null = null;
  private camera: FreeCamera | null = null;
  private cameraTarget: Vector3 | null = null;
  private sun: DirectionalLight | null = null;
  private hemisphere: HemisphericLight | null = null;
  private world: BabylonWorld3D | null = null;
  private bindings: BabylonBindings | null = null;
  private readonly slots: CubeSlot[] = [];
  private readonly materials = new Map<string, StandardMaterial>();
  private activeCount = 0;
  private lastActiveCount = 0;
  private frameDrawCalls = 0;
  private capabilities: RendererCapabilities | null = null;
  private initialized = false;
  private disposed = false;

  constructor(
    engine: BabylonEngine,
    canvas: HTMLCanvasElement,
    backend: BabylonBackend,
    options: BabylonGameRendererOptions = {},
  ) {
    this.engine = engine;
    this.canvas = canvas;
    this.backend = backend;
    this.label = options.label ?? "babylon-game";
    this.maxCubes = positiveIntegerOr(options.maxCubes, DEFAULT_MAX_CUBES);
    this.fovY = positiveOr(options.fovY, FIELD_OF_VIEW_RADIANS);
    this.near = positiveOr(options.near, NEAR_PLANE);
    const far = positiveOr(options.far, FAR_PLANE);
    this.far = far > this.near ? far : FAR_PLANE;
    // The host computes backing-store pixels itself (renderer.resize).
    engine.setHardwareScalingLevel(1);
  }

  /** CSS size since the last `resize`; zero before the host's first call. */
  get size(): RendererSize {
    return this.surfaceSize;
  }

  get drawCalls(): number {
    return this.frameDrawCalls;
  }

  get textureMemoryMB(): number {
    return TEXTURE_MEMORY_MB;
  }

  async init(target: HTMLCanvasElement): Promise<RendererCapabilities> {
    if (this.disposed) {
      throw new Error("BabylonGameRenderer cannot be reused after dispose().");
    }
    if (target !== this.canvas) {
      throw new Error("The Babylon engine was created for a different canvas.");
    }
    if (this.initialized && this.capabilities !== null) {
      return this.capabilities;
    }

    const bindings = await import("./babylonBindings.js");
    const {
      Scene,
      FreeCamera,
      HemisphericLight,
      DirectionalLight,
      Color4,
      Vector3,
    } = bindings;
    const scene = new Scene(this.engine);
    scene.clearColor = new Color4(
      BACKGROUND_R,
      BACKGROUND_G,
      BACKGROUND_B,
      1,
    );
    scene.autoClear = true;
    // The host draws a game canvas, not an editor viewport.
    scene.skipPointerMovePicking = true;

    const cameraTarget = new Vector3(0, 0, 0);
    const camera = new FreeCamera(
      `${this.label}-camera`,
      new Vector3(DEFAULT_CAMERA_X, DEFAULT_CAMERA_Y, DEFAULT_CAMERA_Z),
      scene,
    );
    camera.minZ = this.near;
    camera.maxZ = this.far;
    camera.fov = this.fovY;
    camera.setTarget(cameraTarget);
    scene.activeCamera = camera;

    const hemisphere = new HemisphericLight(
      `${this.label}-hemisphere`,
      new Vector3(0, 1, 0),
      scene,
    );
    hemisphere.intensity = 0.75;

    const sun = new DirectionalLight(
      `${this.label}-sun`,
      new Vector3(-0.4, -1, -0.3),
      scene,
    );
    sun.intensity = 0.9;

    this.bindings = bindings;
    this.scene = scene;
    this.camera = camera;
    this.cameraTarget = cameraTarget;
    this.sun = sun;
    this.hemisphere = hemisphere;
    this.initialized = true;
    this.capabilities = {
      maxTextureSize: this.engine.getCaps().maxTextureSize,
      // Babylon reports extension names, not the engine vocabulary's format
      // tokens; mapping them is deferred until assets land (B2).
      compressedFormats: [],
    };
    return this.capabilities;
  }

  /**
   * Creates the renderer's single `GameWorld3D`, sharing this scene, camera
   * and lights. The host must call `init()` first and install the result as
   * `ctx.world`. Dispose the world (or this renderer) before creating another.
   */
  createWorld(options: BabylonWorldOptions = {}): GameWorld3D {
    if (this.disposed) {
      throw new Error("BabylonGameRenderer cannot be used after dispose().");
    }
    const scene = this.scene;
    const camera = this.camera;
    const sun = this.sun;
    const ambient = this.hemisphere;
    if (scene === null || camera === null || sun === null || ambient === null) {
      throw new Error(
        "BabylonGameRenderer.init() must complete before createWorld().",
      );
    }
    if (this.world !== null) {
      throw new Error(
        "A world already exists; dispose it before creating another.",
      );
    }
    // Resolve the class from the already-loaded dynamic chunk so importing
    // the renderer in Node still does not load Babylon.
    const { BabylonWorld3D: BabylonWorld } = this.requireBindings();
    let world: BabylonWorld3D | null = null;
    world = new BabylonWorld({
      scene,
      camera,
      sun,
      ambient,
      backend: this.backend,
      label: `${this.label}-world`,
      provider: options.provider ?? null,
      maxActors: options.maxActors ?? null,
      maxInstances: options.maxInstances ?? null,
      onDispose: () => {
        if (this.world === world) this.world = null;
      },
    });
    this.world = world;
    return world;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    if (this.disposed) return;
    const width = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : 1;
    const height = Number.isFinite(cssHeight) && cssHeight > 0 ? cssHeight : 1;
    this.surfaceSize.width = width;
    this.surfaceSize.height = height;
    const backing = computeBackingSize(width, height, dpr);
    this.engine.setSize(backing.width, backing.height);
  }

  beginFrame(alpha: number): void {
    void alpha;
    if (this.disposed) {
      throw new Error("BabylonGameRenderer cannot be used after dispose().");
    }
    this.frameDrawCalls = 0;
    for (let index = 0; index < this.lastActiveCount; index += 1) {
      const slot = this.slots[index];
      if (slot !== undefined) slot.mesh.setEnabled(false);
    }
    this.activeCount = 0;
    this.engine.beginFrame();
  }

  setCamera(
    position: { x: number; y: number; z: number },
    target: { x: number; y: number; z: number },
  ): void {
    const camera = this.camera;
    const cameraTarget = this.cameraTarget;
    if (this.disposed || camera === null || cameraTarget === null) return;
    if (!isFinitePosition(position) || !isFinitePosition(target)) return;
    camera.position.set(position.x, position.y, position.z);
    cameraTarget.set(target.x, target.y, target.z);
    camera.setTarget(cameraTarget);
  }

  drawCube(
    position: { x: number; y: number; z: number },
    size: number,
    color: string,
    rotationY: number,
  ): void {
    if (this.disposed) return;
    if (this.scene === null) {
      throw new Error("BabylonGameRenderer.init() must complete before drawCube().");
    }
    if (!isFinitePosition(position)) return;
    if (!Number.isFinite(rotationY)) return;
    const safeSize = Number.isFinite(size) && size > 0 ? size : 0;
    if (safeSize === 0) return;

    if (this.activeCount >= this.maxCubes) {
      throw new BabylonCubeLimitError(this.maxCubes);
    }
    const slot = this.slotAt(this.activeCount);
    const mesh = slot.mesh;
    mesh.position.set(position.x, position.y, position.z);
    mesh.scaling.setAll(safeSize);
    mesh.rotation.y = rotationY;
    mesh.material = this.materialFor(color);
    mesh.setEnabled(true);
    this.activeCount += 1;
  }

  endFrame(): void {
    const scene = this.scene;
    if (this.disposed || scene === null) {
      this.frameDrawCalls = 0;
      return;
    }
    this.lastActiveCount = this.activeCount;
    this.frameDrawCalls = this.activeCount;
    scene.render();
    this.engine.endFrame();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeCount = 0;
    this.lastActiveCount = 0;
    this.frameDrawCalls = 0;
    // The world shares the scene and lights, so it must go first.
    const world = this.world;
    this.world = null;
    world?.dispose();
    this.materials.clear();
    this.slots.length = 0;
    this.camera = null;
    this.cameraTarget = null;
    this.sun = null;
    this.hemisphere = null;
    this.bindings = null;
    const scene = this.scene;
    this.scene = null;
    scene?.dispose();
    this.engine.dispose();
  }

  private slotAt(index: number): CubeSlot {
    const existing = this.slots[index];
    if (existing !== undefined) return existing;
    const scene = this.scene;
    if (scene === null) {
      throw new Error("BabylonGameRenderer.init() must complete before drawCube().");
    }
    const { MeshBuilder } = this.requireBindings();
    const mesh = MeshBuilder.CreateBox(
      `${this.label}-cube-${index}`,
      { size: 1 },
      scene,
    );
    mesh.isPickable = false;
    mesh.setEnabled(false);
    const slot: CubeSlot = { mesh };
    this.slots[index] = slot;
    return slot;
  }

  private materialFor(color: string): StandardMaterial {
    const cached = this.materials.get(color);
    if (cached !== undefined) return cached;
    const scene = this.scene;
    if (scene === null) {
      throw new Error("BabylonGameRenderer.init() must complete before drawCube().");
    }
    const { StandardMaterial, Color3 } = this.requireBindings();
    const [r, g, b] = parseHexColor(color);
    const diffuse = new Color3(r, g, b);
    const material = new StandardMaterial(
      `${this.label}-material-${this.materials.size}`,
      scene,
    );
    material.diffuseColor = diffuse;
    material.specularColor = new Color3(0.04, 0.04, 0.04);
    material.ambientColor = diffuse.scale(0.25);
    this.materials.set(color, material);
    return material;
  }

  private requireBindings(): BabylonBindings {
    const bindings = this.bindings;
    if (bindings === null) {
      throw new Error("BabylonGameRenderer.init() must complete before drawCube().");
    }
    return bindings;
  }
}
