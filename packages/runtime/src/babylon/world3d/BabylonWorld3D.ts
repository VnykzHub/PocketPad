/**
 * Babylon implementation of the frozen `GameWorld3D` contract (spec 22).
 *
 * Lives inside `packages/runtime/src/babylon/**`, so no Babylon type reaches
 * the SDK or a game. The renderer owns the scene/camera/lights; this adapter
 * shares them and never starts a render loop. The host frame boundary stays
 * `beginFrame()` / `endFrame()` on `BabylonGameRenderer`.
 *
 * Hot paths (`update`, setters, follow) reuse per-world scratch objects and
 * typed arrays. Cold paths (spawn, dispose, scene setup) may allocate.
 */
import "@babylonjs/core/Meshes/thinInstanceMesh";

import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import type { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import type { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { ColorCurves } from "@babylonjs/core/Materials/colorCurves";
import type { Material } from "@babylonjs/core/Materials/material";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, type Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { Scene } from "@babylonjs/core/scene";
import { WorldError } from "@lanpad/sdk";
import type {
  ClipPlayOptions,
  FollowOptions,
  GameWorld3D,
  PostOptions,
  PrimitiveKind,
  PrimitiveOptions,
  ShadowTier,
  SkyPreset,
  Vec3,
  World3DCapabilities,
  WorldActor,
  WorldInstances,
} from "@lanpad/sdk";

import { parseHexColor } from "../helpers.js";
import type {
  BabylonModelInstance,
  BabylonModelProvider,
  BabylonModelSource,
} from "./types.js";
import {
  DEFAULT_PRIMITIVE_HEIGHT,
  DEFAULT_PRIMITIVE_RADIUS,
  DEFAULT_PRIMITIVE_SIZE,
  SKY_PRESET_COLORS,
  clampClipSpeed,
  clampFollowOptionsTo,
  clampFov,
  clampLightIntensity,
  clampSegments,
  computeFollowTarget,
  createWorldCapabilities,
  effectiveShadowTier,
  fogRangeTo,
  horizontalForward,
  isFiniteQuaternion,
  isFiniteVec3,
  nonNegativeOr,
  positiveOr,
  shadowMapSize,
  smoothingAlpha,
  yawToQuaternion,
} from "./worldMath.js";
import type {
  CapabilityOverrides,
  FollowConfig,
  FollowTargetOut,
  FogRangeOut,
  Vec3Out,
  WorldBackend,
} from "./worldMath.js";

/** Everything the renderer hands to a world. Nulls keep optional fields explicit. */
export interface BabylonWorld3DConfig {
  readonly scene: Scene;
  readonly camera: FreeCamera;
  readonly sun: DirectionalLight;
  readonly ambient: HemisphericLight;
  readonly backend: WorldBackend;
  readonly label: string;
  readonly provider: BabylonModelProvider | null;
  readonly maxActors: number | null;
  readonly maxInstances: number | null;
  readonly onDispose: (() => void) | null;
}

interface ColorCapableMaterial {
  albedoColor?: Color3;
  diffuseColor?: Color3;
  emissiveColor?: Color3;
}

interface MaterialBinding {
  readonly material: Material;
  readonly color: Color3 | null;
  readonly baseColor: Color3 | null;
  readonly emissive: Color3 | null;
  readonly baseEmissive: Color3 | null;
}

interface ActorState {
  readonly id: number;
  readonly root: TransformNode;
  readonly quaternion: Quaternion;
  readonly meshes: readonly AbstractMesh[];
  readonly groups: readonly AnimationGroup[];
  readonly bindings: readonly MaterialBinding[];
  readonly ownedMaterials: readonly Material[];
  readonly instance: BabylonModelInstance | null;
  alive: boolean;
  visible: boolean;
  current: AnimationGroup | null;
  fadeOut: AnimationGroup | null;
  fadeIn: AnimationGroup | null;
  fadeDuration: number;
  fadeRemaining: number;
  clipSpeed: number;
}

interface PooledInstance {
  readonly root: TransformNode;
  readonly quaternion: Quaternion;
  readonly meshes: readonly AbstractMesh[];
  readonly instance: BabylonModelInstance | null;
}

interface InstanceBatchState {
  readonly count: number;
  readonly transforms: Float32Array;
  readonly visibleFlags: Uint8Array;
  readonly thin: boolean;
  readonly instance: BabylonModelInstance | null;
  readonly pooled: readonly PooledInstance[];
  readonly meshes: readonly AbstractMesh[];
  readonly matrix: Matrix;
  readonly quaternion: Quaternion;
  readonly position: Vector3;
  readonly scaling: Vector3;
  disposed: boolean;
}

const EMPTY_PRIMITIVE_OPTIONS: PrimitiveOptions = {};
const EMPTY_FOLLOW_OPTIONS: FollowOptions = {};
const IDENTITY_QUATERNION_COMPONENTS: readonly [number, number, number, number] = [
  0, 0, 0, 1,
];

function createMaterialBinding(material: Material): MaterialBinding | null {
  const candidate = material as unknown as ColorCapableMaterial;
  // StandardMaterial has diffuseColor; PBRMaterial has albedoColor.
  const color = candidate.albedoColor ?? candidate.diffuseColor ?? null;
  const emissive = candidate.emissiveColor ?? null;
  if (color === null && emissive === null) return null;
  return {
    material,
    color,
    baseColor: color === null ? null : color.clone(),
    emissive,
    baseEmissive: emissive === null ? null : emissive.clone(),
  };
}

function hasBinding(bindings: readonly MaterialBinding[], material: Material): boolean {
  for (const binding of bindings) {
    if (binding.material === material) return true;
  }
  return false;
}

/** A `WorldActor` handle. Constructed only by `BabylonWorld3D`. */
class BabylonActor implements WorldActor {
  readonly id: number;
  readonly state: ActorState;
  /** @internal Used by the world to reject handles from another world. */
  readonly worldOwner: BabylonWorld3D;

  constructor(world: BabylonWorld3D, state: ActorState) {
    this.id = state.id;
    this.state = state;
    this.worldOwner = world;
  }

  get alive(): boolean {
    return this.state.alive;
  }

  private liveState(): ActorState {
    this.worldOwner.requireAlive();
    if (!this.state.alive) {
      throw new WorldError(
        "E_WORLD_DISPOSED",
        `Actor ${this.state.id} is disposed.`,
      );
    }
    return this.state;
  }

  setPosition(x: number, y: number, z: number): void {
    const state = this.liveState();
    if (!isFiniteVec3(x, y, z)) return;
    state.root.position.set(x, y, z);
  }

  setYaw(radians: number): void {
    const state = this.liveState();
    if (!Number.isFinite(radians)) return;
    Quaternion.RotationYawPitchRollToRef(radians, 0, 0, state.quaternion);
  }

  setQuaternion(x: number, y: number, z: number, w: number): void {
    const state = this.liveState();
    if (!isFiniteQuaternion(x, y, z, w)) return;
    if (x * x + y * y + z * z + w * w <= 0) return;
    state.quaternion.set(x, y, z, w);
    state.quaternion.normalize();
  }

  setScale(uniform: number): void {
    const state = this.liveState();
    if (!Number.isFinite(uniform)) return;
    state.root.scaling.setAll(uniform);
  }

  setScale3(x: number, y: number, z: number): void {
    const state = this.liveState();
    if (!isFiniteVec3(x, y, z)) return;
    state.root.scaling.set(x, y, z);
  }

  setTint(color: string | null): void {
    const state = this.liveState();
    this.worldOwner.applyTint(
      state,
      color === null ? null : this.worldOwner.colorFor(color),
    );
  }

  setEmissive(color: string | null): void {
    const state = this.liveState();
    this.worldOwner.applyEmissive(
      state,
      color === null ? null : this.worldOwner.colorFor(color),
    );
  }

  setVisible(visible: boolean): void {
    const state = this.liveState();
    state.visible = visible;
    state.root.setEnabled(visible);
  }

  playClip(name: string, options?: ClipPlayOptions): void {
    const state = this.liveState();
    const group = this.worldOwner.findClip(state, name);
    this.worldOwner.startClip(
      state,
      group,
      options?.loop ?? true,
      clampClipSpeed(options?.speed),
      options?.restart ?? true,
    );
  }

  stopClip(fadeSeconds?: number): void {
    const state = this.liveState();
    this.worldOwner.stopClipFade(state, nonNegativeOr(fadeSeconds, 0));
  }

  crossfadeClip(
    name: string,
    fadeSeconds: number,
    options?: ClipPlayOptions,
  ): void {
    const state = this.liveState();
    const group = this.worldOwner.findClip(state, name);
    this.worldOwner.crossfadeTo(
      state,
      group,
      nonNegativeOr(fadeSeconds, 0),
      options?.loop ?? true,
      clampClipSpeed(options?.speed),
      options?.restart ?? true,
    );
  }

  setClipSpeed(speed: number): void {
    const state = this.liveState();
    this.worldOwner.setClipSpeed(state, clampClipSpeed(speed));
  }

  dispose(): void {
    // Idempotent even after the world disposed every actor.
    this.worldOwner.disposeActorState(this.state);
  }
}

/** A `WorldInstances` handle. The index range is fixed for its lifetime. */
class BabylonInstances implements WorldInstances {
  readonly count: number;
  private readonly worldOwner: BabylonWorld3D;
  private readonly state: InstanceBatchState;

  constructor(world: BabylonWorld3D, state: InstanceBatchState) {
    this.worldOwner = world;
    this.state = state;
    this.count = state.count;
  }

  private requireLive(): void {
    this.worldOwner.requireAlive();
    if (this.state.disposed) {
      throw new WorldError(
        "E_WORLD_DISPOSED",
        "This instance batch is disposed.",
      );
    }
  }

  private requireIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.state.count) {
      throw new WorldError(
        "E_WORLD_ARGUMENT",
        `Instance index ${index} is outside 0..${this.state.count - 1}.`,
      );
    }
  }

  setTransform(
    index: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    scale: number,
  ): void {
    this.requireLive();
    this.requireIndex(index);
    if (!isFiniteVec3(x, y, z) || !Number.isFinite(yaw) || !Number.isFinite(scale)) {
      return;
    }
    const offset = index * 5;
    this.state.transforms[offset] = x;
    this.state.transforms[offset + 1] = y;
    this.state.transforms[offset + 2] = z;
    this.state.transforms[offset + 3] = yaw;
    this.state.transforms[offset + 4] = scale;
    this.worldOwner.writeInstanceTransform(this.state, index);
  }

  setVisible(index: number, visible: boolean): void {
    this.requireLive();
    this.requireIndex(index);
    if (this.state.visibleFlags[index] === (visible ? 1 : 0)) return;
    this.state.visibleFlags[index] = visible ? 1 : 0;
    if (this.state.thin) {
      this.worldOwner.writeInstanceTransform(this.state, index);
      return;
    }
    const pooled = this.state.pooled[index];
    if (pooled !== undefined) pooled.root.setEnabled(visible);
  }

  setTintAt(index: number, color: string | null): void {
    this.requireLive();
    this.requireIndex(index);
    // `capabilities.instanceTint` is false: documented no-op (spec 22 risk).
    if (!this.worldOwner.capabilities.instanceTint) {
      void color;
      return;
    }
  }

  dispose(): void {
    this.worldOwner.disposeInstanceState(this.state);
  }
}

/** Babylon-backed `GameWorld3D`, created by `BabylonGameRenderer.createWorld`. */
export class BabylonWorld3D implements GameWorld3D {
  private readonly scene: Scene;
  private readonly camera: FreeCamera;
  private readonly sun: DirectionalLight;
  private readonly ambient: HemisphericLight;
  private readonly backend: WorldBackend;
  private readonly label: string;
  private readonly provider: BabylonModelProvider | null;
  private readonly maxActors: number;
  private readonly maxInstances: number;
  private readonly onDispose: (() => void) | null;
  private readonly caps: World3DCapabilities;
  private readonly defaultClear: Color4;
  private readonly identityMatrix: Matrix;
  private readonly colorCache = new Map<string, Color3>();

  private readonly actors: ActorState[] = [];
  private readonly instanceStates: InstanceBatchState[] = [];
  private nextHandle = 1;
  private disposed = false;

  private postAvailable: boolean;
  private shadowsAvailable = true;
  private shadowTier: ShadowTier = "off";
  private shadowGenerator: ShadowGenerator | null = null;
  private pipeline: DefaultRenderingPipeline | null = null;
  private colorCurves: ColorCurves | null = null;

  private skyPreset: SkyPreset = "none";
  private skyTexture: Texture | null = null;
  private readonly skyMesh: AbstractMesh;
  private readonly skyMaterial: StandardMaterial;

  private followState: ActorState | null = null;
  private readonly followConfig: FollowConfig = {
    distance: 8,
    height: 4,
    lookAhead: 2,
    smoothing: 6,
  };
  private readonly followForward: Vec3Out = { x: 0, y: 0, z: -1 };
  private readonly followTarget: FollowTargetOut = {
    px: 0,
    py: 0,
    pz: 0,
    tx: 0,
    ty: 0,
    tz: 0,
  };
  private readonly fogValues: FogRangeOut = { near: 10, far: 100 };

  constructor(config: BabylonWorld3DConfig) {
    this.scene = config.scene;
    this.camera = config.camera;
    this.sun = config.sun;
    this.ambient = config.ambient;
    this.backend = config.backend;
    this.label = config.label;
    this.provider = config.provider;
    this.onDispose = config.onDispose;
    this.defaultClear = config.scene.clearColor.clone();
    this.identityMatrix = Matrix.Identity();
    this.postAvailable = config.backend === "webgpu";
    this.camera.rotationQuaternion = null;

    const overrides: CapabilityOverrides = {
      post: config.backend === "webgpu",
      ...(config.maxActors !== null ? { maxActors: config.maxActors } : {}),
      ...(config.maxInstances !== null ? { maxInstances: config.maxInstances } : {}),
    };
    const caps = createWorldCapabilities(config.backend, overrides);
    Object.defineProperties(caps, {
      post: { enumerable: true, get: () => this.postAvailable },
      shadows: { enumerable: true, get: () => this.shadowsAvailable },
    });
    this.caps = caps;
    this.maxActors = caps.maxActors;
    this.maxInstances = caps.maxInstances;

    this.skyMaterial = new StandardMaterial(`${config.label}-sky-material`, config.scene);
    this.skyMaterial.disableLighting = true;
    this.skyMaterial.backFaceCulling = false;
    this.skyMaterial.diffuseColor.set(0, 0, 0);
    this.skyMaterial.specularColor.set(0, 0, 0);
    this.skyMaterial.emissiveColor.set(0, 0, 0);
    this.skyMaterial.fogEnabled = false;
    this.skyMaterial.disableDepthWrite = true;
    // A camera-centered sphere just inside the far plane: a bigger box would
    // be clipped, and a smaller one would cut the sky at the scene edges.
    const skyDiameter = Math.max(10, this.camera.maxZ) * 1.8;
    this.skyMesh = MeshBuilder.CreateSphere(
      `${config.label}-sky`,
      { diameter: skyDiameter, segments: 16 },
      config.scene,
    );
    this.skyMesh.material = this.skyMaterial;
    this.skyMesh.infiniteDistance = true;
    this.skyMesh.isPickable = false;
    this.skyMesh.alwaysSelectAsActiveMesh = true;
    this.skyMesh.setEnabled(false);
  }

  get capabilities(): World3DCapabilities {
    return this.caps;
  }

  /** @internal Throws the contract error for any use after world disposal. */
  requireAlive(): void {
    if (this.disposed) {
      throw new WorldError("E_WORLD_DISPOSED", "The world is disposed.");
    }
  }

  /** @internal Colour cache shared by scene and actor setters. */
  colorFor(hex: string): Color3 {
    const cached = this.colorCache.get(hex);
    if (cached !== undefined) return cached;
    const [r, g, b] = parseHexColor(hex);
    const color = new Color3(r, g, b);
    this.colorCache.set(hex, color);
    return color;
  }

  hasModel(assetId: string): boolean {
    if (this.disposed) return false;
    const provider = this.provider;
    if (provider === null) return false;
    try {
      return provider.hasModel(assetId) === true;
    } catch {
      return false;
    }
  }

  spawnModel(assetId: string): WorldActor {
    const source = this.requireModel(assetId);
    this.requireActorSlot();
    const handle = this.nextHandle;
    this.nextHandle += 1;
    const name = `${this.label}-actor-${handle}`;
    const instance = this.instantiate(source, name);
    if (instance === null || instance.meshes.length === 0) {
      if (instance !== null) instance.dispose();
      throw new WorldError(
        "E_WORLD_ASSET",
        `Asset "${assetId}" has no renderable geometry.`,
      );
    }

    const root = new TransformNode(name, this.scene);
    const quaternion = new Quaternion(...IDENTITY_QUATERNION_COMPONENTS);
    root.rotationQuaternion = quaternion;
    for (const node of instance.roots) node.parent = root;

    const { bindings, ownedMaterials } = this.cloneActorMaterials(name, instance.meshes);
    for (const mesh of instance.meshes) {
      mesh.isPickable = false;
      mesh.receiveShadows = true;
      if (this.shadowGenerator !== null) {
        this.shadowGenerator.addShadowCaster(mesh, false);
      }
    }
    for (const group of instance.animationGroups) {
      group.stop();
      group.reset();
      group.weight = 1;
    }

    const state: ActorState = {
      id: handle,
      root,
      quaternion,
      meshes: instance.meshes,
      groups: instance.animationGroups,
      bindings,
      ownedMaterials,
      instance,
      alive: true,
      visible: true,
      current: null,
      fadeOut: null,
      fadeIn: null,
      fadeDuration: 0,
      fadeRemaining: 0,
      clipSpeed: 1,
    };
    this.actors.push(state);
    return new BabylonActor(this, state);
  }

  spawnInstances(assetId: string, count: number): WorldInstances {
    const source = this.requireModel(assetId);
    if (!Number.isInteger(count) || count < 0) {
      throw new WorldError(
        "E_WORLD_ARGUMENT",
        `Instance count must be a non-negative integer, received ${count}.`,
      );
    }
    if (count > this.maxInstances) {
      throw new WorldError(
        "E_WORLD_LIMIT",
        `Instance count ${count} exceeds the limit ${this.maxInstances}.`,
      );
    }

    const handle = this.nextHandle;
    this.nextHandle += 1;
    const name = `${this.label}-instances-${handle}`;
    const transforms = new Float32Array(count * 5);
    const visibleFlags = new Uint8Array(count);
    for (let index = 0; index < count; index += 1) {
      transforms[index * 5 + 4] = 1;
      visibleFlags[index] = 1;
    }

    let thin = false;
    let instance: BabylonModelInstance | null = null;
    const pooled: PooledInstance[] = [];
    const meshes: AbstractMesh[] = [];

    if (count > 0) {
      instance = this.instantiate(source, name);
      if (instance === null || instance.meshes.length === 0) {
        if (instance !== null) instance.dispose();
        throw new WorldError(
          "E_WORLD_ASSET",
          `Asset "${assetId}" has no renderable geometry for instances.`,
        );
      }
      thin = this.tryThinInstances(instance, count);
      if (thin) {
        for (const mesh of instance.meshes) meshes.push(mesh);
      } else {
        // NullEngine / WebGL caps may reject thin instances. Fall back to one
        // ordinary mesh per index; the handle semantics stay identical.
        instance.dispose();
        instance = null;
        for (let index = 0; index < count; index += 1) {
          const copy = this.instantiate(source, `${name}-${index}`);
          if (copy === null || copy.meshes.length === 0) {
            if (copy !== null) copy.dispose();
            for (const created of pooled) {
              if (created.instance !== null) created.instance.dispose();
              created.root.dispose();
            }
            throw new WorldError(
              "E_WORLD_ASSET",
              `Asset "${assetId}" failed to instantiate instance ${index}.`,
            );
          }
          const root = new TransformNode(`${name}-root-${index}`, this.scene);
          const quaternion = new Quaternion(...IDENTITY_QUATERNION_COMPONENTS);
          root.rotationQuaternion = quaternion;
          for (const node of copy.roots) node.parent = root;
          for (const mesh of copy.meshes) {
            mesh.isPickable = false;
            mesh.receiveShadows = true;
            if (this.shadowGenerator !== null) {
              this.shadowGenerator.addShadowCaster(mesh, false);
            }
            meshes.push(mesh);
          }
          for (const group of copy.animationGroups) {
            group.stop();
            group.reset();
            group.weight = 1;
          }
          pooled.push({ root, quaternion, meshes: copy.meshes, instance: copy });
        }
      }
      if (thin && this.shadowGenerator !== null) {
        for (const mesh of meshes) this.shadowGenerator.addShadowCaster(mesh, false);
      }
    }

    const state: InstanceBatchState = {
      count,
      transforms,
      visibleFlags,
      thin,
      instance,
      pooled,
      meshes,
      matrix: Matrix.Identity(),
      quaternion: new Quaternion(...IDENTITY_QUATERNION_COMPONENTS),
      position: Vector3.Zero(),
      scaling: new Vector3(1, 1, 1),
      disposed: false,
    };
    this.instanceStates.push(state);
    return new BabylonInstances(this, state);
  }

  createPrimitive(kind: PrimitiveKind, options?: PrimitiveOptions): WorldActor {
    this.requireAlive();
    this.requireActorSlot();
    const opts = options ?? EMPTY_PRIMITIVE_OPTIONS;
    const handle = this.nextHandle;
    this.nextHandle += 1;
    const name = `${this.label}-primitive-${handle}`;
    const color = this.colorFor(opts.color ?? "#ffffff");
    const size = positiveOr(opts.size, DEFAULT_PRIMITIVE_SIZE);
    const radius = positiveOr(opts.radius, DEFAULT_PRIMITIVE_RADIUS);
    const height = positiveOr(opts.height, DEFAULT_PRIMITIVE_HEIGHT);
    const segments = clampSegments(opts.segments);

    let mesh: AbstractMesh;
    switch (kind) {
      case "box":
        mesh = MeshBuilder.CreateBox(name, { size }, this.scene);
        break;
      case "sphere":
        mesh = MeshBuilder.CreateSphere(
          name,
          { diameter: radius * 2, segments },
          this.scene,
        );
        break;
      case "cylinder":
        mesh = MeshBuilder.CreateCylinder(
          name,
          { diameter: radius * 2, height, tessellation: segments },
          this.scene,
        );
        break;
      case "plane":
        mesh = MeshBuilder.CreatePlane(name, { size }, this.scene);
        break;
      case "ground":
        mesh = MeshBuilder.CreateGround(
          name,
          { width: size, height: size },
          this.scene,
        );
        break;
      default:
        throw new WorldError(
          "E_WORLD_UNSUPPORTED",
          `Primitive kind "${String(kind)}" is not supported.`,
        );
    }

    const material = new StandardMaterial(`${name}-material`, this.scene);
    material.diffuseColor.copyFrom(color);
    material.specularColor.set(0.04, 0.04, 0.04);
    material.ambientColor.set(0.25, 0.25, 0.25);
    if (opts.emissive === undefined || opts.emissive === null) {
      material.emissiveColor.set(0, 0, 0);
    } else {
      material.emissiveColor.copyFrom(this.colorFor(opts.emissive));
    }
    if (kind === "plane") material.backFaceCulling = false;
    mesh.material = material;
    mesh.isPickable = false;
    mesh.receiveShadows = true;

    const visible = opts.visible ?? true;
    mesh.setEnabled(visible);
    if (this.shadowGenerator !== null) {
      this.shadowGenerator.addShadowCaster(mesh, false);
    }

    const quaternion = new Quaternion(...IDENTITY_QUATERNION_COMPONENTS);
    mesh.rotationQuaternion = quaternion;
    const binding = createMaterialBinding(material);
    const state: ActorState = {
      id: handle,
      root: mesh,
      quaternion,
      meshes: [mesh],
      groups: [],
      bindings: binding === null ? [] : [binding],
      ownedMaterials: [material],
      instance: null,
      alive: true,
      visible,
      current: null,
      fadeOut: null,
      fadeIn: null,
      fadeDuration: 0,
      fadeRemaining: 0,
      clipSpeed: 1,
    };
    this.actors.push(state);
    return new BabylonActor(this, state);
  }

  setSun(direction: Vec3, color: string, intensity: number): void {
    this.requireAlive();
    if (!isFiniteVec3(direction.x, direction.y, direction.z)) return;
    const lengthSquared =
      direction.x * direction.x +
      direction.y * direction.y +
      direction.z * direction.z;
    if (lengthSquared <= 0) return;
    const length = Math.sqrt(lengthSquared);
    this.sun.direction.set(
      direction.x / length,
      direction.y / length,
      direction.z / length,
    );
    this.sun.diffuse.copyFrom(this.colorFor(color));
    this.sun.intensity = clampLightIntensity(intensity);
  }

  setAmbient(color: string, intensity: number): void {
    this.requireAlive();
    this.ambient.diffuse.copyFrom(this.colorFor(color));
    this.ambient.groundColor.copyFrom(this.colorFor(color));
    this.ambient.intensity = clampLightIntensity(intensity);
  }

  setFog(color: string | null, near?: number, far?: number): void {
    this.requireAlive();
    if (color === null) {
      this.scene.fogMode = Scene.FOGMODE_NONE;
      return;
    }
    fogRangeTo(near, far, this.fogValues);
    this.scene.fogMode = Scene.FOGMODE_LINEAR;
    this.scene.fogColor.copyFrom(this.colorFor(color));
    this.scene.fogStart = this.fogValues.near;
    this.scene.fogEnd = this.fogValues.far;
  }

  setSky(preset: SkyPreset): void {
    this.requireAlive();
    if (
      preset !== "none" &&
      preset !== "day" &&
      preset !== "dusk" &&
      preset !== "night" &&
      preset !== "overcast"
    ) {
      throw new WorldError(
        "E_WORLD_ARGUMENT",
        `Sky preset "${String(preset)}" is not supported.`,
      );
    }
    this.skyPreset = preset;
    this.applySky();
  }

  setSkyTexture(assetId: string | null): void {
    this.requireAlive();
    if (assetId === null) {
      this.skyTexture = null;
      this.applySky();
      return;
    }
    const provider = this.provider;
    if (provider === null || provider.getTexture === undefined) {
      throw new WorldError(
        "E_WORLD_ASSET",
        `Sky texture "${assetId}" is unavailable: no texture provider.`,
      );
    }
    let hasTexture = true;
    if (provider.hasTexture !== undefined) {
      try {
        hasTexture = provider.hasTexture(assetId);
      } catch {
        hasTexture = false;
      }
    }
    let texture: Texture | null = null;
    if (hasTexture) {
      try {
        texture = provider.getTexture(assetId, this.scene);
      } catch {
        texture = null;
      }
    }
    if (texture === null) {
      throw new WorldError(
        "E_WORLD_ASSET",
        `Sky texture "${assetId}" is not available.`,
      );
    }
    this.skyTexture = texture;
    this.applySky();
  }

  setShadowTier(tier: ShadowTier): void {
    this.requireAlive();
    if (tier !== "off" && tier !== "low" && tier !== "high") {
      throw new WorldError(
        "E_WORLD_ARGUMENT",
        `Shadow tier "${String(tier)}" is not supported.`,
      );
    }
    const effective = effectiveShadowTier(tier, this.backend);
    if (
      effective === this.shadowTier &&
      (effective === "off" || this.shadowGenerator !== null)
    ) {
      return;
    }
    this.shadowTier = effective;
    this.rebuildShadowGenerator(effective);
  }

  setPost(options: PostOptions): void {
    this.requireAlive();
    if (this.backend !== "webgpu" || !this.postAvailable) return;
    const pipeline = this.ensurePipeline();
    if (pipeline === null) return;

    const bloom = options.bloom === true;
    pipeline.bloomEnabled = bloom;
    if (bloom) {
      pipeline.bloomWeight = 0.4;
      pipeline.bloomThreshold = 0.65;
      pipeline.bloomKernel = 64;
      pipeline.bloomScale = 0.5;
    }

    const imageProcessing = pipeline.imageProcessing;
    let vignette = options.vignette ?? 0;
    if (!Number.isFinite(vignette) || vignette < 0) vignette = 0;
    if (vignette > 1) vignette = 1;
    imageProcessing.vignetteEnabled = vignette > 0;
    imageProcessing.vignetteWeight = vignette * 4;
    imageProcessing.vignetteColor.copyFromFloats(0, 0, 0, 1);

    const grade = options.grade ?? "none";
    if (grade === "warm" || grade === "cool") {
      if (this.colorCurves === null) {
        this.colorCurves = new ColorCurves();
        imageProcessing.colorCurves = this.colorCurves;
      }
      imageProcessing.colorCurvesEnabled = true;
      this.colorCurves.globalHue = grade === "warm" ? -18 : 18;
      this.colorCurves.globalSaturation = grade === "warm" ? 18 : 10;
      this.colorCurves.globalExposure = grade === "warm" ? 0.08 : -0.04;
    } else {
      imageProcessing.colorCurvesEnabled = false;
    }
  }

  setCamera(position: Vec3, target: Vec3, fovDegrees?: number): void {
    this.requireAlive();
    if (
      !isFiniteVec3(position.x, position.y, position.z) ||
      !isFiniteVec3(target.x, target.y, target.z)
    ) {
      return;
    }
    this.camera.position.set(position.x, position.y, position.z);
    this.applyLookAt(position.x, position.y, position.z, target.x, target.y, target.z);
    this.camera.fov = (clampFov(fovDegrees) * Math.PI) / 180;
  }

  follow(actor: WorldActor, options?: FollowOptions): void {
    this.requireAlive();
    if (!(actor instanceof BabylonActor) || actor.worldOwner !== this) {
      throw new WorldError(
        "E_WORLD_ARGUMENT",
        "follow() needs an actor created by this world.",
      );
    }
    if (!actor.state.alive) {
      throw new WorldError(
        "E_WORLD_DISPOSED",
        `Actor ${actor.state.id} is disposed.`,
      );
    }
    this.followState = actor.state;
    // Writes into a preallocated config; no allocation in the follow path.
    clampFollowOptionsTo(options ?? EMPTY_FOLLOW_OPTIONS, this.followConfig);
  }

  clearFollow(): void {
    this.requireAlive();
    this.followState = null;
  }

  update(dtSeconds: number): void {
    this.requireAlive();
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;

    // Indexed loops: `for...of` creates an iterator per tick.
    const actors = this.actors;
    for (let actorIndex = 0; actorIndex < actors.length; actorIndex += 1) {
      const state = actors[actorIndex];
      if (state === undefined || state.fadeRemaining <= 0) continue;
      state.fadeRemaining -= dtSeconds;
      if (state.fadeRemaining < 0) state.fadeRemaining = 0;
      const progress =
        state.fadeDuration > 0
          ? 1 - state.fadeRemaining / state.fadeDuration
          : 1;
      if (state.fadeOut !== null) state.fadeOut.weight = 1 - progress;
      if (state.fadeIn !== null) state.fadeIn.weight = progress;
      if (state.fadeRemaining === 0) {
        if (state.fadeOut !== null) {
          state.fadeOut.stop(true);
          state.fadeOut.reset();
          state.fadeOut.weight = 1;
          state.fadeOut = null;
        }
        if (state.fadeIn !== null) {
          state.fadeIn.weight = 1;
          state.fadeIn = null;
        }
        state.fadeDuration = 0;
      }
    }

    const followed = this.followState;
    if (followed === null) return;
    if (!followed.alive) {
      this.followState = null;
      return;
    }
    const q = followed.quaternion;
    horizontalForward(q.x, q.y, q.z, q.w, this.followForward);
    const position = followed.root.position;
    computeFollowTarget(
      position.x,
      position.y,
      position.z,
      this.followForward.x,
      this.followForward.z,
      this.followConfig.distance,
      this.followConfig.height,
      this.followConfig.lookAhead,
      this.followTarget,
    );
    const alpha = smoothingAlpha(this.followConfig.smoothing, dtSeconds);
    const cameraPosition = this.camera.position;
    cameraPosition.x += (this.followTarget.px - cameraPosition.x) * alpha;
    cameraPosition.y += (this.followTarget.py - cameraPosition.y) * alpha;
    cameraPosition.z += (this.followTarget.pz - cameraPosition.z) * alpha;
    this.applyLookAt(
      cameraPosition.x,
      cameraPosition.y,
      cameraPosition.z,
      this.followTarget.tx,
      this.followTarget.ty,
      this.followTarget.tz,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.followState = null;

    for (const state of this.instanceStates.slice()) {
      this.disposeInstanceState(state);
    }
    this.instanceStates.length = 0;
    for (const state of this.actors.slice()) {
      this.disposeActorState(state);
    }
    this.actors.length = 0;

    if (this.shadowGenerator !== null) {
      this.shadowGenerator.dispose();
      this.shadowGenerator = null;
    }
    if (this.pipeline !== null) {
      this.pipeline.dispose();
      this.pipeline = null;
    }
    this.colorCurves = null;
    this.skyTexture = null;
    this.skyMesh.dispose();
    this.skyMaterial.dispose(false, false);
    this.colorCache.clear();
    this.onDispose?.();
  }

  /** @internal Actor disposal shared by the handle and world teardown. */
  disposeActorState(state: ActorState): void {
    if (!state.alive) return;
    state.alive = false;
    const index = this.actors.indexOf(state);
    if (index >= 0) this.actors.splice(index, 1);
    this.stopAllClips(state);
    if (this.shadowGenerator !== null) {
      for (const mesh of state.meshes) {
        this.shadowGenerator.removeShadowCaster(mesh, false);
      }
    }
    if (state.instance !== null) state.instance.dispose();
    state.root.dispose();
    for (const material of state.ownedMaterials) material.dispose(false, false);
    if (this.followState === state) this.followState = null;
  }

  /** @internal Instance-batch disposal shared by the handle and world teardown. */
  disposeInstanceState(state: InstanceBatchState): void {
    if (state.disposed) return;
    state.disposed = true;
    const index = this.instanceStates.indexOf(state);
    if (index >= 0) this.instanceStates.splice(index, 1);
    if (this.shadowGenerator !== null) {
      for (const mesh of state.meshes) {
        this.shadowGenerator.removeShadowCaster(mesh, false);
      }
    }
    if (state.instance !== null) state.instance.dispose();
    for (const pooled of state.pooled) {
      if (pooled.instance !== null) pooled.instance.dispose();
      pooled.root.dispose();
    }
  }

  /** @internal Writes one thin/pooled transform without allocating. */
  writeInstanceTransform(state: InstanceBatchState, index: number): void {
    if (state.disposed) return;
    const offset = index * 5;
    const x = state.transforms[offset] ?? 0;
    const y = state.transforms[offset + 1] ?? 0;
    const z = state.transforms[offset + 2] ?? 0;
    const yaw = state.transforms[offset + 3] ?? 0;
    const scale = state.transforms[offset + 4] ?? 1;
    const visible = state.visibleFlags[index] === 1;
    if (!state.thin) {
      const pooled = state.pooled[index];
      if (pooled === undefined) return;
      pooled.root.position.set(x, y, z);
      Quaternion.RotationYawPitchRollToRef(yaw, 0, 0, pooled.quaternion);
      pooled.root.scaling.setAll(scale);
      return;
    }
    const effectiveScale = visible ? scale : 0;
    state.scaling.set(effectiveScale, effectiveScale, effectiveScale);
    state.position.set(x, y, z);
    yawToQuaternion(yaw, state.quaternion);
    Matrix.ComposeToRef(state.scaling, state.quaternion, state.position, state.matrix);
    for (let meshIndex = 0; meshIndex < state.meshes.length; meshIndex += 1) {
      const mesh = state.meshes[meshIndex];
      // Thin-mode meshes are always `Mesh`; the guard only satisfies the
      // seam's wider `AbstractMesh` type.
      if (mesh instanceof Mesh) {
        mesh.thinInstanceSetMatrixAt(index, state.matrix, false);
      }
    }
  }

  /** @internal Clip lookup; throws E_WORLD_UNSUPPORTED for unknown names. */
  findClip(state: ActorState, name: string): AnimationGroup {
    for (const group of state.groups) {
      if (group.name === name) return group;
    }
    throw new WorldError(
      "E_WORLD_UNSUPPORTED",
      `Actor ${state.id} has no clip named "${name}".`,
    );
  }

  /** @internal Starts a clip, replacing any current or fading group. */
  startClip(
    state: ActorState,
    group: AnimationGroup,
    loop: boolean,
    speed: number,
    restart: boolean,
  ): void {
    if (state.current === group) {
      this.setClipSpeed(state, speed);
      group.loopAnimation = loop;
      if (restart) {
        group.stop(true);
        group.reset();
        group.weight = 1;
        group.start(loop, speed);
      } else if (!group.isStarted) {
        group.start(loop, speed);
      }
      return;
    }
    this.stopTransientClips(state);
    if (state.current !== null) {
      state.current.stop(true);
      state.current.reset();
      state.current.weight = 1;
    }
    state.current = null;
    group.stop(true);
    group.reset();
    group.weight = 1;
    group.loopAnimation = loop;
    group.speedRatio = speed;
    group.start(loop, speed);
    state.current = group;
    state.clipSpeed = speed;
  }

  /** @internal `stopClip`; fade 0 stops immediately. */
  stopClipFade(state: ActorState, fadeSeconds: number): void {
    if (state.current === null) {
      this.stopTransientClips(state);
      return;
    }
    if (fadeSeconds <= 0) {
      this.stopAllClips(state);
      return;
    }
    // A crossfade in progress: drop the outgoing group, fade the live one.
    if (state.fadeOut !== null) {
      state.fadeOut.stop(true);
      state.fadeOut.reset();
      state.fadeOut.weight = 1;
      state.fadeOut = null;
    }
    if (state.fadeIn !== null && state.fadeIn !== state.current) {
      state.fadeIn.stop(true);
      state.fadeIn.reset();
      state.fadeIn.weight = 1;
      state.fadeIn = null;
    }
    state.fadeOut = state.current;
    state.fadeIn = null;
    state.fadeDuration = fadeSeconds;
    state.fadeRemaining = fadeSeconds;
    state.current = null;
    state.fadeOut.weight = 1;
  }

  /** @internal Crossfade; unknown clips are rejected before any state change. */
  crossfadeTo(
    state: ActorState,
    group: AnimationGroup,
    fadeSeconds: number,
    loop: boolean,
    speed: number,
    restart: boolean,
  ): void {
    if (fadeSeconds <= 0 || state.current === null) {
      this.startClip(state, group, loop, speed, restart);
      return;
    }
    if (state.current === group) {
      this.startClip(state, group, loop, speed, restart);
      return;
    }
    if (state.fadeOut !== null) {
      state.fadeOut.stop(true);
      state.fadeOut.reset();
      state.fadeOut.weight = 1;
      state.fadeOut = null;
    }
    const outgoing = state.current;
    group.stop(true);
    group.reset();
    group.weight = 0;
    group.loopAnimation = loop;
    group.speedRatio = speed;
    group.start(loop, speed);
    group.weight = 0;
    state.fadeOut = outgoing;
    state.fadeIn = group;
    state.fadeDuration = fadeSeconds;
    state.fadeRemaining = fadeSeconds;
    state.current = group;
    state.clipSpeed = speed;
    outgoing.weight = 1;
  }

  /** @internal Applies `setClipSpeed` to the live and fading groups. */
  setClipSpeed(state: ActorState, speed: number): void {
    state.clipSpeed = speed;
    if (state.current !== null) state.current.speedRatio = speed;
    if (state.fadeOut !== null && state.fadeOut !== state.current) {
      state.fadeOut.speedRatio = speed;
    }
    if (state.fadeIn !== null && state.fadeIn !== state.current) {
      state.fadeIn.speedRatio = speed;
    }
  }

  /** @internal Multiplies or restores base colours on owned materials. */
  applyTint(state: ActorState, tint: Color3 | null): void {
    for (let index = 0; index < state.bindings.length; index += 1) {
      const binding = state.bindings[index];
      if (binding === undefined) continue;
      const color = binding.color;
      const base = binding.baseColor;
      if (color === null || base === null) continue;
      if (tint === null) {
        color.copyFrom(base);
      } else {
        color.set(base.r * tint.r, base.g * tint.g, base.b * tint.b);
      }
    }
  }

  /** @internal Adds or clears unlit colour on owned materials. */
  applyEmissive(state: ActorState, emissive: Color3 | null): void {
    for (let index = 0; index < state.bindings.length; index += 1) {
      const binding = state.bindings[index];
      if (binding === undefined) continue;
      const target = binding.emissive;
      const base = binding.baseEmissive;
      if (target === null || base === null) continue;
      if (emissive === null) {
        target.copyFrom(base);
      } else {
        target.copyFrom(emissive);
      }
    }
  }

  private requireModel(assetId: string): BabylonModelSource {
    this.requireAlive();
    const provider = this.provider;
    if (provider === null) {
      throw new WorldError(
        "E_WORLD_ASSET",
        `Asset "${assetId}" is unavailable: no model provider.`,
      );
    }
    let present = false;
    try {
      present = provider.hasModel(assetId) === true;
    } catch {
      present = false;
    }
    if (!present) {
      throw new WorldError(
        "E_WORLD_ASSET",
        `Asset "${assetId}" is not available.`,
      );
    }
    let source: BabylonModelSource | null = null;
    try {
      source = provider.getModel(assetId);
    } catch {
      source = null;
    }
    if (source === null) {
      throw new WorldError(
        "E_WORLD_ASSET",
        `Asset "${assetId}" could not be prepared.`,
      );
    }
    return source;
  }

  private requireActorSlot(): void {
    if (this.actors.length >= this.maxActors) {
      throw new WorldError(
        "E_WORLD_LIMIT",
        `Actor limit ${this.maxActors} reached.`,
      );
    }
  }

  private instantiate(
    source: BabylonModelSource,
    name: string,
  ): BabylonModelInstance | null {
    try {
      return source.instantiate(this.scene, name);
    } catch {
      return null;
    }
  }

  private cloneActorMaterials(
    name: string,
    meshes: readonly AbstractMesh[],
  ): { bindings: MaterialBinding[]; ownedMaterials: Material[] } {
    const bindings: MaterialBinding[] = [];
    const ownedMaterials: Material[] = [];
    const clones = new Map<Material, Material | null>();
    for (const mesh of meshes) {
      const source = mesh.material;
      if (source === null) continue;
      let clone = clones.get(source);
      if (clone === undefined) {
        clone = source.clone(`${name}-material`) ?? null;
        clones.set(source, clone);
        if (clone !== null) ownedMaterials.push(clone);
      }
      const material = clone ?? source;
      if (clone !== null) mesh.material = clone;
      if (hasBinding(bindings, material)) continue;
      const binding = createMaterialBinding(material);
      if (binding !== null) bindings.push(binding);
    }
    return { bindings, ownedMaterials };
  }

  private tryThinInstances(
    instance: BabylonModelInstance,
    count: number,
  ): boolean {
    if (!this.scene.getEngine().getCaps().instancedArrays) return false;
    for (const mesh of instance.meshes) {
      if (!(mesh instanceof Mesh)) return false;
      // Babylon applies skinning after the instance matrix, so per-instance
      // transforms of a rigged mesh collapse onto the source mesh. Pooled
      // clones keep transforms real.
      if (mesh.skeleton !== null) return false;
      mesh.isPickable = false;
      mesh.receiveShadows = true;
      mesh.alwaysSelectAsActiveMesh = true;
      for (let index = 0; index < count; index += 1) {
        if (mesh.thinInstanceAdd(this.identityMatrix, false) === -1) {
          return false;
        }
      }
    }
    return true;
  }

  private applySky(): void {
    const hasTexture = this.skyTexture !== null;
    const hasPreset = this.skyPreset !== "none";
    const enabled = hasTexture || hasPreset;
    this.skyMesh.setEnabled(enabled);
    if (!enabled) {
      this.scene.clearColor.copyFrom(this.defaultClear);
      this.skyMaterial.emissiveTexture = null;
      this.skyMaterial.emissiveColor.set(0, 0, 0);
      return;
    }
    if (hasPreset) {
      const presetColors =
        SKY_PRESET_COLORS[this.skyPreset as Exclude<SkyPreset, "none">];
      this.scene.clearColor.copyFromFloats(
        presetColors.clear[0],
        presetColors.clear[1],
        presetColors.clear[2],
        presetColors.clear[3],
      );
      if (!hasTexture) {
        this.skyMaterial.emissiveTexture = null;
        this.skyMaterial.emissiveColor.set(
          presetColors.emissive[0],
          presetColors.emissive[1],
          presetColors.emissive[2],
        );
      }
    } else {
      this.scene.clearColor.copyFrom(this.defaultClear);
    }
    if (hasTexture) this.skyMaterial.emissiveColor.set(1, 1, 1);
    this.skyMaterial.emissiveTexture = this.skyTexture;
  }

  private ensurePipeline(): DefaultRenderingPipeline | null {
    if (this.pipeline !== null) return this.pipeline;
    let pipeline: DefaultRenderingPipeline | null = null;
    try {
      pipeline = new DefaultRenderingPipeline(
        `${this.label}-post`,
        true,
        this.scene,
        [this.camera],
      );
    } catch {
      try {
        pipeline = new DefaultRenderingPipeline(
          `${this.label}-post`,
          false,
          this.scene,
          [this.camera],
        );
      } catch {
        pipeline = null;
      }
    }
    if (pipeline === null) {
      this.postAvailable = false;
      return null;
    }
    pipeline.samples = 4;
    pipeline.imageProcessingEnabled = true;
    pipeline.bloomEnabled = false;
    pipeline.imageProcessing.vignetteEnabled = false;
    pipeline.imageProcessing.colorCurvesEnabled = false;
    this.pipeline = pipeline;
    return pipeline;
  }

  private rebuildShadowGenerator(tier: ShadowTier): void {
    if (this.shadowGenerator !== null) {
      this.shadowGenerator.dispose();
      this.shadowGenerator = null;
    }
    const mapSize = shadowMapSize(tier);
    if (mapSize === 0) return;
    try {
      const generator = new ShadowGenerator(mapSize, this.sun);
      generator.usePercentageCloserFiltering = true;
      generator.filteringQuality =
        tier === "high" ? ShadowGenerator.QUALITY_HIGH : ShadowGenerator.QUALITY_LOW;
      generator.bias = 0.008;
      generator.darkness = 0.35;
      generator.transparencyShadow = false;
      this.shadowGenerator = generator;
      this.shadowsAvailable = true;
      for (const state of this.actors) {
        for (const mesh of state.meshes) generator.addShadowCaster(mesh, false);
      }
      for (const state of this.instanceStates) {
        for (const mesh of state.meshes) generator.addShadowCaster(mesh, false);
      }
    } catch {
      this.shadowGenerator = null;
      this.shadowsAvailable = false;
    }
  }

  private applyLookAt(
    eyeX: number,
    eyeY: number,
    eyeZ: number,
    targetX: number,
    targetY: number,
    targetZ: number,
  ): void {
    const dx = targetX - eyeX;
    const dy = targetY - eyeY;
    const dz = targetZ - eyeZ;
    const horizontal = Math.sqrt(dx * dx + dz * dz);
    this.camera.rotationQuaternion = null;
    this.camera.rotation.z = 0;
    this.camera.rotation.y = Math.atan2(dx, dz);
    this.camera.rotation.x =
      horizontal > 1e-6 ? -Math.atan2(dy, horizontal) : 0;
  }

  private stopTransientClips(state: ActorState): void {
    if (state.fadeOut !== null) {
      state.fadeOut.stop(true);
      state.fadeOut.reset();
      state.fadeOut.weight = 1;
      state.fadeOut = null;
    }
    if (state.fadeIn !== null) {
      if (state.fadeIn !== state.current) {
        state.fadeIn.stop(true);
        state.fadeIn.reset();
        state.fadeIn.weight = 1;
      }
      state.fadeIn = null;
    }
    state.fadeDuration = 0;
    state.fadeRemaining = 0;
  }

  private stopAllClips(state: ActorState): void {
    const current = state.current;
    const fadeOut = state.fadeOut;
    const fadeIn = state.fadeIn;
    if (current !== null) {
      current.stop(true);
      current.reset();
      current.weight = 1;
    }
    if (fadeOut !== null && fadeOut !== current) {
      fadeOut.stop(true);
      fadeOut.reset();
      fadeOut.weight = 1;
    }
    if (fadeIn !== null && fadeIn !== current && fadeIn !== fadeOut) {
      fadeIn.stop(true);
      fadeIn.reset();
      fadeIn.weight = 1;
    }
    state.current = null;
    state.fadeOut = null;
    state.fadeIn = null;
    state.fadeDuration = 0;
    state.fadeRemaining = 0;
  }
}
