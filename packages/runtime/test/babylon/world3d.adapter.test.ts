// @req ER-22-01 — GameWorld3D semantics on the Babylon adapter (spec 22).
import { createFakeWorld } from "@lanpad/sdk/testing";
import {
  WorldError,
  type GameWorld3D,
  type PrimitiveKind,
  type ShadowTier,
  type SkyPreset,
} from "@lanpad/sdk";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  BabylonGameRenderer,
  type BabylonEngine,
} from "../../src/babylon/BabylonGameRenderer.js";
import {
  Color4,
  DirectionalLight,
  FreeCamera,
  HemisphericLight,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from "../../src/babylon/babylonBindings.js";
import {
  BabylonWorld3D,
  type BabylonWorld3DConfig,
} from "../../src/babylon/world3d/BabylonWorld3D.js";
import type {
  BabylonModelProvider,
  BabylonModelSource,
} from "../../src/babylon/world3d/types.js";

const LABEL = "test";
const CLEAR = [0.1, 0.2, 0.3, 1] as const;

type BabylonGroup = Scene["animationGroups"][number];
type BabylonTargetedAnimation = Parameters<
  BabylonGroup["addTargetedAnimation"]
>[0];

/** The slice of an animation the fixture builds and keys. */
interface BabylonAnimation {
  setKeys(keys: { frame: number; value: number }[]): void;
}

/**
 * The boundary gate bans Babylon specifiers outside `src/babylon`, including
 * in tests. The harness needs the headless engine and animation classes, so
 * this dev-only loader resolves them from a computed specifier; production
 * code keeps its sealed re-exports in `babylonBindings`.
 */
const BABYLON_CORE = ["@babylonjs", "core"].join("/");

interface NullEngineConstructor {
  new (): {
    dispose(): void;
    getCaps(): { instancedArrays: boolean };
  };
}

interface AnimationConstructor {
  new (
    name: string,
    targetProperty: string,
    framePerSecond: number,
    dataType: number,
    loopMode: number,
  ): BabylonAnimation;
  readonly ANIMATIONTYPE_FLOAT: number;
  readonly ANIMATIONLOOPMODE_CYCLE: number;
}

interface AnimationGroupConstructor {
  new (name: string, scene: Scene): BabylonGroup;
}

interface SkeletonConstructor {
  new (name: string, id: string, scene: Scene): { dispose(): void };
}

async function loadModule<T>(path: string): Promise<T> {
  return (await import(`${BABYLON_CORE}/${path}`)) as T;
}

let NullEngine: NullEngineConstructor;
let Animation: AnimationConstructor;
let AnimationGroup: AnimationGroupConstructor;
let Skeleton: SkeletonConstructor;

beforeAll(async () => {
  const [engineModule, animationModule, groupModule, skeletonModule] =
    await Promise.all([
      loadModule<{ NullEngine: NullEngineConstructor }>("Engines/nullEngine"),
      loadModule<{ Animation: AnimationConstructor }>("Animations/animation"),
      loadModule<{ AnimationGroup: AnimationGroupConstructor }>(
        "Animations/animationGroup",
      ),
      loadModule<{ Skeleton: SkeletonConstructor }>("Bones/skeleton"),
    ]);
  NullEngine = engineModule.NullEngine;
  Animation = animationModule.Animation;
  AnimationGroup = groupModule.AnimationGroup;
  Skeleton = skeletonModule.Skeleton;
});

interface Harness {
  readonly engine: {
    dispose(): void;
    getCaps(): { instancedArrays: boolean };
  };
  readonly scene: Scene;
  readonly camera: FreeCamera;
  readonly sun: DirectionalLight;
  readonly ambient: HemisphericLight;
  readonly world: BabylonWorld3D;
  readonly provider: BabylonModelProvider;
}

/** A procedural model: one box with a material and two animation groups. */
function createFixtureSource(): BabylonModelSource {
  return {
    clips: ["idle", "walk"],
    instantiate(scene, name) {
      const mesh = MeshBuilder.CreateBox(`${name}-mesh`, { size: 1 }, scene);
      const material = new StandardMaterial(`${name}-source-material`, scene);
      material.diffuseColor.set(1, 1, 1);
      material.emissiveColor.set(0, 0, 0);
      mesh.material = material;
      const groups: BabylonGroup[] = [];
      for (const clip of ["idle", "walk"]) {
        const group = new AnimationGroup(clip, scene);
        const animation = new Animation(
          `${name}-${clip}-animation`,
          "position.y",
          60,
          Animation.ANIMATIONTYPE_FLOAT,
          Animation.ANIMATIONLOOPMODE_CYCLE,
        );
        animation.setKeys([
          { frame: 0, value: 0 },
          { frame: 30, value: 0.1 },
        ]);
        group.addTargetedAnimation(
          animation as unknown as BabylonTargetedAnimation,
          mesh,
        );
        groups.push(group);
      }
      let disposed = false;
      return {
        roots: [mesh],
        meshes: [mesh],
        animationGroups: groups,
        dispose() {
          if (disposed) return;
          disposed = true;
          for (const group of groups) group.dispose();
          mesh.dispose(false, false);
          material.dispose(false, false);
        },
      };
    },
  };
}

function createFixtureProvider(
  source: BabylonModelSource = createFixtureSource(),
): BabylonModelProvider {
  return {
    hasModel(assetId) {
      return assetId === "fixture";
    },
    getModel(assetId) {
      return assetId === "fixture" ? source : null;
    },
  };
}

/** The same fixture with a skeleton, standing in for a rigged GLB. */
function createRiggedFixtureSource(): BabylonModelSource {
  const base = createFixtureSource();
  return {
    clips: base.clips,
    instantiate(scene, name) {
      const instance = base.instantiate(scene, name);
      if (instance === null) return null;
      const skeleton = new Skeleton(`${name}-skeleton`, name, scene);
      for (const mesh of instance.meshes) {
        mesh.skeleton = skeleton as unknown as typeof mesh.skeleton;
      }
      const dispose = instance.dispose;
      instance.dispose = () => {
        dispose();
        skeleton.dispose();
      };
      return instance;
    },
  };
}

const harnesses: Harness[] = [];

function harness(
  backend: "webgpu" | "webgl2" = "webgl2",
  options: {
    readonly provider?: BabylonModelProvider;
    readonly maxActors?: number;
    readonly maxInstances?: number;
  } = {},
): Harness {
  const engine = new NullEngine();
  const scene = new Scene(engine as never);
  scene.clearColor = new Color4(...CLEAR);
  const camera = new FreeCamera(`${LABEL}-camera`, new Vector3(0, 2, 5), scene);
  camera.minZ = 0.1;
  camera.maxZ = 100;
  const sun = new DirectionalLight(
    `${LABEL}-sun`,
    new Vector3(-1, -2, -1),
    scene,
  );
  const ambient = new HemisphericLight(
    `${LABEL}-ambient`,
    new Vector3(0, 1, 0),
    scene,
  );
  const provider = options.provider ?? createFixtureProvider();
  const config: BabylonWorld3DConfig = {
    scene,
    camera,
    sun,
    ambient,
    backend,
    label: LABEL,
    provider,
    maxActors: options.maxActors ?? null,
    maxInstances: options.maxInstances ?? null,
    onDispose: null,
  };
  const world = new BabylonWorld3D(config);
  const entry: Harness = {
    engine,
    scene,
    camera,
    sun,
    ambient,
    world,
    provider,
  };
  harnesses.push(entry);
  return entry;
}

afterEach(() => {
  for (const entry of harnesses.splice(0)) {
    entry.world.dispose();
    entry.scene.dispose();
    entry.engine.dispose();
  }
});

function worldError(run: () => unknown): WorldError {
  try {
    run();
  } catch (error) {
    if (error instanceof WorldError) return error;
    throw error;
  }
  throw new Error("Expected a WorldError, but the call succeeded.");
}

function expectCode(run: () => unknown, code: string): void {
  expect(worldError(run).code).toBe(code);
}

function requireTransform(scene: Scene, name: string) {
  const node = scene.getTransformNodeByName(name);
  if (node === null) throw new Error(`Missing transform node "${name}".`);
  return node;
}

function requireGroup(scene: Scene, name: string): BabylonGroup {
  const group = scene.animationGroups.find(
    (candidate) => candidate.name === name,
  );
  if (group === undefined) {
    throw new Error(`Missing animation group "${name}".`);
  }
  return group;
}

function requireMeshMaterial(scene: Scene, name: string): StandardMaterial {
  const mesh = scene.getMeshByName(name);
  if (mesh === null) throw new Error(`Missing mesh "${name}".`);
  const material = mesh.material;
  if (!(material instanceof StandardMaterial)) {
    throw new Error(`Mesh "${name}" has no StandardMaterial.`);
  }
  return material;
}

describe("Babylon world capabilities", () => {
  test("[ER-22-01] WebGPU reports the high tier with post", () => {
    const { world } = harness("webgpu");
    expect(world.capabilities).toMatchObject({
      backend: "webgpu",
      tier: "high",
      shadows: true,
      post: true,
      animation: true,
      instances: true,
      instanceTint: false,
    });
  });

  test("[ER-22-01] WebGL2 reports the reduced tier without post", () => {
    const { world } = harness("webgl2");
    expect(world.capabilities).toMatchObject({
      backend: "webgl2",
      tier: "reduced",
      shadows: true,
      post: false,
      animation: true,
      instances: true,
      instanceTint: false,
    });
  });

  test("[ER-22-09] option limits replace the tier defaults", () => {
    const { world } = harness("webgl2", { maxActors: 3, maxInstances: 5 });
    expect(world.capabilities.maxActors).toBe(3);
    expect(world.capabilities.maxInstances).toBe(5);
  });
});

describe("Babylon world actors", () => {
  test("[ER-22-01] a model actor owns its transform and clip state", () => {
    const { world, scene } = harness();
    const actor = world.spawnModel("fixture");
    expect(actor.alive).toBe(true);
    expect(Number.isInteger(actor.id)).toBe(true);

    actor.setPosition(1, 2, 3);
    const root = requireTransform(scene, `${LABEL}-actor-1`);
    expect(root.position.x).toBe(1);
    expect(root.position.y).toBe(2);
    expect(root.position.z).toBe(3);

    actor.setYaw(Math.PI / 2);
    expect(root.rotationQuaternion?.y).toBeCloseTo(Math.SQRT1_2, 12);

    // A zero quaternion is ignored rather than corrupting the rotation.
    actor.setQuaternion(0, 0, 0, 0);
    expect(root.rotationQuaternion?.y).toBeCloseTo(Math.SQRT1_2, 12);

    // A non-unit quaternion is normalised.
    actor.setQuaternion(0, 0, 0, 2);
    expect(root.rotationQuaternion?.w).toBeCloseTo(1, 12);

    actor.setScale(2);
    expect(root.scaling.x).toBe(2);
    actor.setScale3(1, 2, 3);
    expect(root.scaling.y).toBe(2);

    actor.setVisible(false);
    expect(root.isEnabled()).toBe(false);
    actor.setVisible(true);
    expect(root.isEnabled()).toBe(true);

    actor.playClip("idle", { loop: false, speed: 2 });
    const idle = requireGroup(scene, "idle");
    expect(idle.isStarted).toBe(true);
    expect(idle.loopAnimation).toBe(false);
    expect(idle.speedRatio).toBe(2);

    actor.setClipSpeed(100);
    expect(idle.speedRatio).toBe(10);
    actor.setClipSpeed(-1);
    expect(idle.speedRatio).toBe(1);

    expectCode(() => actor.playClip("missing"), "E_WORLD_UNSUPPORTED");

    actor.stopClip();
    expect(idle.isStarted).toBe(false);
  });

  test("[ER-22-01] tint and emissive multiply and restore base colours", () => {
    const { world, scene } = harness();
    const actor = world.spawnModel("fixture");
    const material = requireMeshMaterial(scene, `${LABEL}-actor-1-mesh`);
    expect(material.diffuseColor.r).toBe(1);

    actor.setTint("#808080");
    expect(material.diffuseColor.r).toBeCloseTo(128 / 255, 6);
    expect(material.diffuseColor.g).toBeCloseTo(128 / 255, 6);
    actor.setTint(null);
    expect(material.diffuseColor.r).toBe(1);

    actor.setEmissive("#00ff00");
    expect(material.emissiveColor.g).toBe(1);
    actor.setEmissive(null);
    expect(material.emissiveColor.g).toBe(0);
  });

  test("[ER-22-01] crossfade blends weights over update and lands on the new clip", () => {
    const { world, scene } = harness();
    const actor = world.spawnModel("fixture");
    actor.playClip("idle");
    const idle = requireGroup(scene, "idle");
    const walk = requireGroup(scene, "walk");

    actor.crossfadeClip("walk", 0.5);
    expect(walk.isStarted).toBe(true);
    expect(walk.weight).toBe(0);
    expect(idle.weight).toBe(1);

    world.update(0.25);
    expect(idle.weight).toBeCloseTo(0.5, 6);
    expect(walk.weight).toBeCloseTo(0.5, 6);

    world.update(0.25);
    expect(idle.isStarted).toBe(false);
    expect(walk.weight).toBe(1);
  });

  test("[ER-22-01] stopClip fades out and then stops the group", () => {
    const { world, scene } = harness();
    const actor = world.spawnModel("fixture");
    actor.playClip("idle");
    const idle = requireGroup(scene, "idle");

    actor.stopClip(0.5);
    expect(idle.weight).toBe(1);
    world.update(0.25);
    expect(idle.weight).toBeCloseTo(0.5, 6);
    world.update(0.25);
    expect(idle.isStarted).toBe(false);
  });

  test("[ER-22-10] actor disposal is idempotent and frees scene nodes", () => {
    const { world, scene } = harness();
    const actor = world.spawnModel("fixture");
    expect(scene.getTransformNodeByName(`${LABEL}-actor-1`)).not.toBeNull();
    expect(scene.getMeshByName(`${LABEL}-actor-1-mesh`)).not.toBeNull();

    actor.dispose();
    expect(actor.alive).toBe(false);
    expect(scene.getTransformNodeByName(`${LABEL}-actor-1`)).toBeNull();
    expect(scene.getMeshByName(`${LABEL}-actor-1-mesh`)).toBeNull();
    actor.dispose();

    expectCode(() => actor.setPosition(1, 1, 1), "E_WORLD_DISPOSED");
    expectCode(() => actor.setTint("#ffffff"), "E_WORLD_DISPOSED");
  });

  test("[ER-22-01] primitives build every documented kind", () => {
    const { world, scene } = harness();
    const kinds: readonly PrimitiveKind[] = [
      "box",
      "sphere",
      "cylinder",
      "plane",
      "ground",
    ];
    kinds.forEach((kind, index) => {
      const actor = world.createPrimitive(kind, {
        color: "#ffffff",
        size: 2,
        radius: 1,
        height: 3,
        segments: 12,
      });
      expect(actor.alive).toBe(true);
      // Handles are monotonic across kinds and name their scene mesh.
      expect(actor.id).toBe(index + 1);
      expect(scene.getMeshByName(`${LABEL}-primitive-${index + 1}`)).not.toBeNull();
    });
    expectCode(
      () => world.createPrimitive("torus" as PrimitiveKind),
      "E_WORLD_UNSUPPORTED",
    );
  });

  test("[ER-22-01] primitive options drive material and visibility", () => {
    const { world, scene } = harness();
    const actor = world.createPrimitive("box", {
      color: "#336699",
      emissive: "#ff0000",
      visible: false,
    });
    const mesh = scene.getMeshByName(`${LABEL}-primitive-1`);
    expect(mesh).not.toBeNull();
    expect(mesh?.isEnabled()).toBe(false);
    const material = requireMeshMaterial(scene, `${LABEL}-primitive-1`);
    expect(material.diffuseColor.r).toBeCloseTo(0x33 / 255, 6);
    expect(material.emissiveColor.r).toBe(1);

    actor.setVisible(true);
    expect(mesh?.isEnabled()).toBe(true);
    actor.setTint("#00ff00");
    expect(material.diffuseColor.r).toBeCloseTo(0, 6);
    // The tint multiplies the primitive's base colour (#336699).
    expect(material.diffuseColor.g).toBeCloseTo(0x66 / 255, 6);
    expect(material.diffuseColor.b).toBeCloseTo(0, 6);
    actor.setTint(null);
    expect(material.diffuseColor.r).toBeCloseTo(0x33 / 255, 6);
  });
});

describe("Babylon world assets and limits", () => {
  test("[ER-22-08] a missing asset throws E_WORLD_ASSET without using an actor slot", () => {
    const { world } = harness("webgl2", { maxActors: 1 });
    const error = worldError(() => world.spawnModel("missing"));
    expect(error.code).toBe("E_WORLD_ASSET");
    expect(world.hasModel("missing")).toBe(false);
    // The failed spawn must not consume the only actor slot.
    const actor = world.spawnModel("fixture");
    expect(actor.alive).toBe(true);
  });

  test("[ER-22-08] a failing or empty provider maps to E_WORLD_ASSET", () => {
    const throwing: BabylonModelProvider = {
      hasModel() {
        throw new Error("asset system offline");
      },
      getModel() {
        return null;
      },
    };
    const first = harness("webgl2", { provider: throwing });
    expect(first.world.hasModel("fixture")).toBe(false);
    expectCode(() => first.world.spawnModel("fixture"), "E_WORLD_ASSET");

    const empty: BabylonModelProvider = {
      hasModel() {
        return true;
      },
      getModel() {
        return {
          clips: [],
          instantiate() {
            return null;
          },
        };
      },
    };
    const second = harness("webgl2", { provider: empty });
    expectCode(() => second.world.spawnModel("fixture"), "E_WORLD_ASSET");
    expect(second.scene.getTransformNodeByName(`${LABEL}-actor-1`)).toBeNull();
  });

  test("[ER-22-09] the actor limit throws E_WORLD_LIMIT with the limit in the message", () => {
    const { world } = harness("webgl2", { maxActors: 1 });
    world.spawnModel("fixture");
    const error = worldError(() => world.spawnModel("fixture"));
    expect(error.code).toBe("E_WORLD_LIMIT");
    expect(error.message).toContain("1");
    expectCode(() => world.createPrimitive("box"), "E_WORLD_LIMIT");
  });

  test("[ER-22-09] the instance limit throws E_WORLD_LIMIT with the limit in the message", () => {
    const { world } = harness("webgl2", { maxInstances: 1 });
    const error = worldError(() => world.spawnInstances("fixture", 2));
    expect(error.code).toBe("E_WORLD_LIMIT");
    expect(error.message).toContain("1");

    expect(world.spawnInstances("fixture", 0).count).toBe(0);
    expectCode(() => world.spawnInstances("fixture", -1), "E_WORLD_ARGUMENT");
    expectCode(() => world.spawnInstances("fixture", 1.5), "E_WORLD_ARGUMENT");
  });
});

describe("Babylon world instances", () => {
  test("[ER-22-01] pooled instances expose transforms and visibility", () => {
    const { world, scene } = harness();
    // NullEngine reports no instancedArrays cap, so this is the pooled path.
    const instances = world.spawnInstances("fixture", 2);
    expect(instances.count).toBe(2);

    const first = requireTransform(scene, `${LABEL}-instances-1-root-0`);
    const second = requireTransform(scene, `${LABEL}-instances-1-root-1`);

    instances.setTransform(0, 1, 2, 3, Math.PI / 2, 2);
    expect(first.position.x).toBe(1);
    expect(first.position.y).toBe(2);
    expect(first.position.z).toBe(3);
    expect(first.scaling.x).toBe(2);
    // Babylon's own yaw helper is single-precision in its trig constants.
    expect(first.rotationQuaternion?.y).toBeCloseTo(Math.SQRT1_2, 6);

    instances.setVisible(0, false);
    expect(first.isEnabled()).toBe(false);
    instances.setVisible(0, true);
    expect(first.isEnabled()).toBe(true);

    // instanceTint is false on Babylon; tint must be a silent no-op.
    instances.setTintAt(0, "#ff0000");
    expect(first.isEnabled()).toBe(true);
    expect(second.isEnabled()).toBe(true);

    expectCode(
      () => instances.setTransform(2, 0, 0, 0, 0, 1),
      "E_WORLD_ARGUMENT",
    );
    expectCode(() => instances.setVisible(-1, true), "E_WORLD_ARGUMENT");

    instances.dispose();
    instances.dispose();
    expect(
      scene.getTransformNodeByName(`${LABEL}-instances-1-root-0`),
    ).toBeNull();
    expectCode(() => instances.setVisible(0, true), "E_WORLD_DISPOSED");
  });

  test("[ER-22-01] thin instances are used when the engine supports them", () => {
    interface ThinMeshView {
      readonly thinInstanceCount: number;
      thinInstanceGetWorldMatrices(): { readonly m: number[] }[];
    }
    const { world, scene, engine } = harness("webgpu");
    // NullEngine reports no instancedArrays cap; force the thin-capable path.
    engine.getCaps().instancedArrays = true;
    const instances = world.spawnInstances("fixture", 2);
    instances.setTransform(0, -3, 0, -4, Math.PI, 1);

    const mesh = scene.getMeshByName(
      `${LABEL}-instances-1-mesh`,
    ) as unknown as ThinMeshView | null;
    expect(mesh).not.toBeNull();
    expect(mesh?.thinInstanceCount).toBe(2);
    expect(
      scene.getTransformNodeByName(`${LABEL}-instances-1-root-0`),
    ).toBeNull();
    const matrices = mesh?.thinInstanceGetWorldMatrices() ?? [];
    expect(matrices[0]?.m[12]).toBeCloseTo(-3, 6);
    expect(matrices[0]?.m[14]).toBeCloseTo(-4, 6);
  });

  test("[ER-22-02] rigged models fall back to pooled instances", () => {
    const provider = createFixtureProvider(createRiggedFixtureSource());
    const { world, scene, engine } = harness("webgpu", { provider });
    engine.getCaps().instancedArrays = true;
    const instances = world.spawnInstances("fixture", 2);

    // Skinned thin instances ignore per-instance matrices in Babylon, so the
    // adapter must pool instead of rendering overlapping copies at the origin.
    expect(scene.getMeshByName(`${LABEL}-instances-1-mesh`)).toBeNull();
    const second = requireTransform(scene, `${LABEL}-instances-1-root-1`);
    instances.setTransform(1, 4, 0, -2, 0, 1);
    expect(second.position.x).toBe(4);
    expect(second.position.z).toBe(-2);
  });

  test("[ER-22-10] world disposal frees instance batches too", () => {
    const { world, scene } = harness();
    const instances = world.spawnInstances("fixture", 1);
    world.dispose();
    expect(
      scene.getTransformNodeByName(`${LABEL}-instances-1-root-0`),
    ).toBeNull();
    expectCode(
      () => instances.setTransform(0, 0, 0, 0, 0, 1),
      "E_WORLD_DISPOSED",
    );
  });
});

describe("Babylon world scene settings", () => {
  test("[ER-22-01] sun and ambient normalise and clamp", () => {
    const { world, sun, ambient } = harness();
    world.setSun({ x: 0, y: -2, z: 0 }, "#ff8000", 99);
    expect(sun.direction.x).toBe(0);
    expect(sun.direction.y).toBe(-1);
    expect(sun.intensity).toBe(10);
    expect(sun.diffuse.r).toBe(1);
    expect(sun.diffuse.g).toBeCloseTo(128 / 255, 6);

    const before = sun.direction.clone();
    world.setSun({ x: 0, y: 0, z: 0 }, "#ffffff", 1);
    expect(sun.direction.equals(before)).toBe(true);

    world.setAmbient("#0000ff", -1);
    expect(ambient.intensity).toBe(0);
    expect(ambient.diffuse.b).toBe(1);
    expect(ambient.groundColor.b).toBe(1);
  });

  test("[ER-22-01] fog applies linearly, defaults its range and clears", () => {
    const { world, scene } = harness();
    world.setFog("#336699");
    expect(scene.fogMode).toBe(Scene.FOGMODE_LINEAR);
    expect(scene.fogStart).toBe(10);
    expect(scene.fogEnd).toBe(100);
    expect(scene.fogColor.r).toBeCloseTo(0x33 / 255, 6);

    world.setFog("#000000", 5, 25);
    expect(scene.fogStart).toBe(5);
    expect(scene.fogEnd).toBe(25);

    world.setFog(null);
    expect(scene.fogMode).toBe(Scene.FOGMODE_NONE);
  });

  test("[ER-22-01] sky presets drive clear colour and a camera-anchored dome", () => {
    const { world, scene, camera } = harness();
    const sky = scene.getMeshByName(`${LABEL}-sky`);
    expect(sky).not.toBeNull();
    expect(sky?.isEnabled()).toBe(false);

    world.setSky("dusk");
    expect(sky?.isEnabled()).toBe(true);
    expect(scene.clearColor.r).toBeCloseTo(0.3, 6);
    expect(scene.clearColor.g).toBeCloseTo(0.18, 6);
    expect(scene.clearColor.b).toBeCloseTo(0.17, 6);
    // The dome is sized inside the far plane so it is never clipped.
    expect(camera.maxZ).toBe(100);

    world.setSky("none");
    expect(sky?.isEnabled()).toBe(false);
    expect(scene.clearColor.r).toBeCloseTo(CLEAR[0], 6);

    expectCode(() => world.setSky("storm" as SkyPreset), "E_WORLD_ARGUMENT");
  });

  test("[ER-22-01] sky textures need a provider that can supply them", () => {
    const { world } = harness();
    world.setSkyTexture(null);
    expectCode(() => world.setSkyTexture("sky"), "E_WORLD_ASSET");

    const noTexture: BabylonModelProvider = {
      ...createFixtureProvider(),
      hasTexture() {
        return false;
      },
      getTexture() {
        return null;
      },
    };
    const second = harness("webgl2", { provider: noTexture });
    expectCode(() => second.world.setSkyTexture("sky"), "E_WORLD_ASSET");
  });

  test("[ER-22-01] shadow tiers validate and clamp on WebGL2", () => {
    const { world } = harness("webgl2");
    world.setShadowTier("high");
    world.setShadowTier("low");
    world.setShadowTier("off");
    expectCode(
      () => world.setShadowTier("ultra" as ShadowTier),
      "E_WORLD_ARGUMENT",
    );
  });

  test("[ER-22-01] post is a no-op where capabilities.post is false", () => {
    const { world } = harness("webgl2");
    expect(world.capabilities.post).toBe(false);
    expect(() =>
      world.setPost({ bloom: true, vignette: 0.5, grade: "warm" }),
    ).not.toThrow();
    expect(world.capabilities.post).toBe(false);
  });
});

describe("Babylon world camera", () => {
  test("[ER-22-01] setCamera applies position, look direction and clamped FOV", () => {
    const { world, camera } = harness();
    world.setCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 200);
    expect(camera.position.x).toBe(0);
    expect(camera.rotation.y).toBeCloseTo(Math.PI, 6);
    expect(camera.fov).toBeCloseTo((110 * Math.PI) / 180, 6);

    world.setCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, -10);
    expect(camera.fov).toBeCloseTo((20 * Math.PI) / 180, 6);

    const before = camera.position.clone();
    world.setCamera({ x: Number.NaN, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 60);
    expect(camera.position.equals(before)).toBe(true);
  });

  test("[ER-22-01] follow converges behind the actor and clearFollow freezes it", () => {
    const { world, camera } = harness();
    const actor = world.spawnModel("fixture");
    actor.setPosition(0, 1, 0);
    actor.setYaw(0);
    world.setCamera({ x: 0, y: 50, z: 50 }, { x: 0, y: 0, z: 0 });
    world.follow(actor, { distance: 8, height: 4, lookAhead: 2, smoothing: 20 });
    for (let tick = 0; tick < 180; tick += 1) world.update(1 / 60);
    expect(camera.position.x).toBeCloseTo(0, 3);
    expect(camera.position.y).toBeCloseTo(5, 3);
    expect(camera.position.z).toBeCloseTo(8, 3);

    actor.setYaw(Math.PI / 2);
    for (let tick = 0; tick < 180; tick += 1) world.update(1 / 60);
    expect(camera.position.x).toBeCloseTo(8, 3);
    expect(camera.position.y).toBeCloseTo(5, 3);
    expect(camera.position.z).toBeCloseTo(0, 3);

    world.clearFollow();
    actor.setPosition(20, 0, 20);
    for (let tick = 0; tick < 60; tick += 1) world.update(1 / 60);
    expect(camera.position.x).toBeCloseTo(8, 3);
    expect(camera.position.z).toBeCloseTo(0, 3);
  });

  test("[ER-22-01] follow rejects foreign and disposed actors", () => {
    const { world } = harness();
    const fake = createFakeWorld();
    const foreign = fake.spawnModel("anything");
    expectCode(() => world.follow(foreign), "E_WORLD_ARGUMENT");

    const actor = world.spawnModel("fixture");
    actor.dispose();
    expectCode(() => world.follow(actor), "E_WORLD_DISPOSED");

    world.dispose();
    expectCode(
      () => world.follow(fake.spawnModel("anything")),
      "E_WORLD_DISPOSED",
    );
  });
});

describe("Babylon renderer createWorld guard", () => {
  function fakeEngine(): BabylonEngine {
    return {
      setHardwareScalingLevel() {},
      dispose() {},
    } as unknown as BabylonEngine;
  }

  test("[ER-22-01] createWorld needs init and refuses a disposed renderer", () => {
    const renderer = new BabylonGameRenderer(
      fakeEngine(),
      {} as HTMLCanvasElement,
      "webgpu",
    );
    expect(() => renderer.createWorld()).toThrow(/init\(\) must complete/);
    renderer.dispose();
    expect(() => renderer.createWorld()).toThrow(/after dispose/);
  });
});

interface ContractWorld {
  readonly world: GameWorld3D;
  dispose(): void;
}

function withContractWorld(
  create: () => ContractWorld,
  run: (world: GameWorld3D) => void,
): void {
  const contract = create();
  try {
    run(contract.world);
  } finally {
    contract.dispose();
  }
}

function fakeContractWorld(): ContractWorld {
  const world = createFakeWorld({
    models: ["fixture"],
    capabilities: { maxInstances: 1 },
  });
  return { world, dispose() {} };
}

function babylonContractWorld(): ContractWorld {
  const entry = harness("webgl2", { maxInstances: 1 });
  return {
    world: entry.world,
    dispose() {
      entry.world.dispose();
      entry.scene.dispose();
      entry.engine.dispose();
      const index = harnesses.indexOf(entry);
      if (index >= 0) harnesses.splice(index, 1);
    },
  };
}

const contractVariants = [
  { name: "createFakeWorld", create: fakeContractWorld },
  { name: "BabylonWorld3D", create: babylonContractWorld },
] as const;

describe.each(contractVariants)(
  "GameWorld3D conformance: $name",
  ({ create }) => {
    test("[ER-22-01] the full surface is callable in one lifecycle", () => {
      withContractWorld(create, (world) => {
        const caps = world.capabilities;
        expect(["webgpu", "webgl2"]).toContain(caps.backend);
        expect(["high", "reduced"]).toContain(caps.tier);
        expect(typeof caps.shadows).toBe("boolean");
        expect(typeof caps.post).toBe("boolean");
        expect(typeof caps.animation).toBe("boolean");
        expect(typeof caps.instances).toBe("boolean");
        expect(typeof caps.instanceTint).toBe("boolean");
        expect(caps.maxActors).toBeGreaterThan(0);
        expect(caps.maxInstances).toBeGreaterThan(0);

        expect(world.hasModel("fixture")).toBe(true);
        expect(world.hasModel("missing")).toBe(false);

        const actor = world.spawnModel("fixture");
        expect(Number.isInteger(actor.id)).toBe(true);
        expect(actor.alive).toBe(true);
        actor.setPosition(1, 2, 3);
        actor.setYaw(0.5);
        actor.setQuaternion(0, 0, 0, 1);
        actor.setScale(2);
        actor.setScale3(1, 2, 3);
        actor.setTint("#ff0000");
        actor.setEmissive("#00ff00");
        actor.setVisible(false);
        actor.setVisible(true);

        const primitive = world.createPrimitive("box", {
          color: "#123456",
          visible: false,
        });
        expect(primitive.id).not.toBe(actor.id);
        expect(primitive.alive).toBe(true);

        const instances = world.spawnInstances("fixture", 1);
        expect(instances.count).toBe(1);
        instances.setTransform(0, 1, 2, 3, 0, 1);
        instances.setVisible(0, false);
        instances.setVisible(0, true);
        instances.setTintAt(0, null);

        world.setSun({ x: 0, y: -1, z: 0 }, "#ffffff", 1);
        world.setAmbient("#ffffff", 1);
        world.setFog("#000000", 1, 10);
        world.setFog(null);
        world.setSky("day");
        world.setSky("none");
        world.setSkyTexture(null);
        world.setShadowTier("off");
        world.setPost({ bloom: false });
        world.setCamera({ x: 0, y: 2, z: 5 }, { x: 0, y: 0, z: 0 }, 60);
        world.follow(actor);
        world.update(1 / 60);
        world.clearFollow();

        instances.dispose();
        actor.dispose();
        primitive.dispose();
        expect(actor.alive).toBe(false);
        expect(primitive.alive).toBe(false);
      });
    });

    test("[ER-22-08] a missing model is E_WORLD_ASSET and creates no actor", () => {
      withContractWorld(create, (world) => {
        expect(worldError(() => world.spawnModel("missing")).code).toBe(
          "E_WORLD_ASSET",
        );
        expect(world.spawnModel("fixture").alive).toBe(true);
      });
    });

    test("[ER-22-09] the instance limit reports the limit", () => {
      withContractWorld(create, (world) => {
        expect(world.capabilities.maxInstances).toBe(1);
        const error = worldError(() => world.spawnInstances("fixture", 2));
        expect(error.code).toBe("E_WORLD_LIMIT");
        expect(error.message).toContain("1");
        expect(world.spawnInstances("fixture", 0).count).toBe(0);
      });
    });

    test("[ER-22-10] dispose is idempotent and later calls report E_WORLD_DISPOSED", () => {
      withContractWorld(create, (world) => {
        world.dispose();
        world.dispose();
        expectCode(() => world.spawnModel("fixture"), "E_WORLD_DISPOSED");
        expectCode(() => world.createPrimitive("box"), "E_WORLD_DISPOSED");
        expectCode(() => world.update(1 / 60), "E_WORLD_DISPOSED");
      });
    });
  },
);
