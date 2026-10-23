import {
  Renderable,
  Transform,
  createScene,
  type EngineScene,
  type Entity,
  type MaterialHandle,
  type Mat4,
  type MeshHandle,
  type RenderFrame,
} from "@lanpad/engine-core";
import { describe, expect, test } from "vitest";
import {
  createSceneEncoder,
  type SceneAssetHandle,
  type SceneAssetLibrary,
  type SceneDrawableAsset,
} from "../../src/engine/sceneEncoder.js";

interface RenderableData {
  mesh: string;
  material: string;
  visible: boolean;
  layer: number;
}

interface DrawCall {
  mesh: MeshHandle;
  material: MaterialHandle;
  transform: Mat4;
}

function mesh(index: number): MeshHandle {
  return { index, generation: 1, __kind: "mesh" };
}

function material(index: number): MaterialHandle {
  return { index, generation: 1, __kind: "material" };
}

function identityMatrix(): Mat4 {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return { m };
}

class FakeFrame {
  readonly draws: DrawCall[] = [];

  draw(
    meshHandle: MeshHandle,
    materialHandle: MaterialHandle,
    transform: Mat4,
  ): void {
    this.draws.push({
      mesh: meshHandle,
      material: materialHandle,
      transform,
    });
  }
}

class FakeScene {
  readonly entities: Entity[] = [];
  readonly renderables = new Map<number, RenderableData>();
  readonly matrices = new Map<number, Mat4>();
  /** Every `out` array the encoder passed to `query`. */
  readonly queryOutputs: Entity[][] = [];

  query(out: Entity[]): Entity[] {
    this.queryOutputs.push(out);
    out.length = 0;
    for (const entity of this.entities) out.push(entity);
    return out;
  }

  get<T>(entity: Entity): T | undefined {
    return this.renderables.get(entity.id) as unknown as T | undefined;
  }

  worldMatrix(entity: Entity): Mat4 | undefined {
    return this.matrices.get(entity.id);
  }

  /** The encoder must never call this; tick step 7 owns it (RV-04). */
  updateWorldTransforms(): never {
    throw new Error("the scene encoder must not update world transforms");
  }
}

function addRenderable(
  scene: FakeScene,
  entity: Entity,
  renderable: RenderableData,
  transform: Mat4 = identityMatrix(),
): void {
  scene.entities.push(entity);
  scene.renderables.set(entity.id, renderable);
  scene.matrices.set(entity.id, transform);
}

type LibraryEntry = SceneDrawableAsset | "loading" | "failed";

function library(
  entries: Readonly<Record<string, LibraryEntry>>,
): SceneAssetLibrary {
  return {
    get<T>(id: string): SceneAssetHandle<T> | undefined {
      const entry = entries[id];
      if (entry === undefined) return undefined;
      if (typeof entry === "string") {
        return {
          state: entry,
          get value(): T {
            throw new Error(`asset ${id} was read before it was ready`);
          },
        };
      }
      return { state: "ready", value: entry as unknown as T };
    },
  };
}

function encode(
  encoder: ReturnType<typeof createSceneEncoder>,
  scene: FakeScene,
  assets: SceneAssetLibrary,
  frame: FakeFrame,
): number {
  return encoder.encode(
    scene as unknown as EngineScene,
    assets,
    frame as unknown as RenderFrame,
  );
}

describe("scene encoder", () => {
  test("[ER-00-15] sorts draws by layer, material and mesh and preserves submission order", () => {
    const scene = new FakeScene();
    const highLayer = { id: 1, generation: 0 };
    const materialTwo = { id: 2, generation: 0 };
    const meshThree = { id: 3, generation: 0 };
    const meshOneFirst = { id: 4, generation: 0 };
    const otherLayer = { id: 5, generation: 0 };
    const meshOneSecond = { id: 6, generation: 0 };

    addRenderable(scene, highLayer, {
      mesh: "z",
      material: "m2",
      visible: true,
      layer: 2,
    });
    addRenderable(scene, materialTwo, {
      mesh: "b",
      material: "m2",
      visible: true,
      layer: 0,
    });
    addRenderable(scene, meshThree, {
      mesh: "c",
      material: "m1",
      visible: true,
      layer: 0,
    });
    addRenderable(scene, meshOneFirst, {
      mesh: "a",
      material: "m1",
      visible: true,
      layer: 0,
    });
    addRenderable(scene, otherLayer, {
      mesh: "q",
      material: "m0",
      visible: true,
      layer: 1,
    });
    addRenderable(scene, meshOneSecond, {
      mesh: "a",
      material: "m1",
      visible: true,
      layer: 0,
    });

    const assets = library({
      a: { mesh: mesh(1) },
      b: { mesh: mesh(2) },
      c: { mesh: mesh(3) },
      q: { mesh: mesh(0) },
      z: { mesh: mesh(9) },
      m0: { material: material(0) },
      m1: { material: material(1) },
      m2: { material: material(2) },
    });
    const encoder = createSceneEncoder();
    const frame = new FakeFrame();

    const submitted = encode(encoder, scene, assets, frame);

    expect(submitted).toBe(6);
    expect(frame.draws.map((draw) => draw.mesh.index)).toEqual([
      1, 1, 3, 2, 0, 9,
    ]);
    expect(frame.draws.map((draw) => draw.material.index)).toEqual([
      1, 1, 1, 2, 0, 2,
    ]);
    // Equal layer/material/mesh keys keep submission order.
    expect(frame.draws[0]?.transform).toBe(
      scene.matrices.get(meshOneFirst.id),
    );
    expect(frame.draws[1]?.transform).toBe(
      scene.matrices.get(meshOneSecond.id),
    );
    expect(encoder.stats).toEqual({
      entities: 6,
      submitted: 6,
      skippedInvisible: 0,
      skippedUnresolved: 0,
      skippedNoTransform: 0,
    });
  });

  test("[ER-00-15] skips missing and not-ready assets without reading their values", () => {
    const scene = new FakeScene();
    const ready = { id: 1, generation: 0 };
    const missing = { id: 2, generation: 0 };
    const loading = { id: 3, generation: 0 };

    addRenderable(scene, ready, {
      mesh: "readyMesh",
      material: "readyMaterial",
      visible: true,
      layer: 0,
    });
    addRenderable(scene, missing, {
      mesh: "missingMesh",
      material: "readyMaterial",
      visible: true,
      layer: 0,
    });
    addRenderable(scene, loading, {
      mesh: "loadingMesh",
      material: "readyMaterial",
      visible: true,
      layer: 0,
    });

    const assets = library({
      readyMesh: { mesh: mesh(1) },
      loadingMesh: "loading",
      readyMaterial: { material: material(1) },
    });
    const encoder = createSceneEncoder();
    const frame = new FakeFrame();

    const submitted = encode(encoder, scene, assets, frame);

    expect(submitted).toBe(1);
    expect(frame.draws).toHaveLength(1);
    expect(frame.draws[0]?.mesh.index).toBe(1);
    expect(encoder.stats.skippedUnresolved).toBe(2);
    expect(encoder.stats.submitted).toBe(1);
  });

  test("[ER-00-15] submits nothing for an empty scene", () => {
    const scene = new FakeScene();
    const assets = library({});
    const encoder = createSceneEncoder();
    const frame = new FakeFrame();

    const submitted = encode(encoder, scene, assets, frame);

    expect(submitted).toBe(0);
    expect(frame.draws).toEqual([]);
    expect(encoder.stats).toEqual({
      entities: 0,
      submitted: 0,
      skippedInvisible: 0,
      skippedUnresolved: 0,
      skippedNoTransform: 0,
    });
  });

  test("[ER-00-15] excludes disabled entities through the query and skips invisible renderables", () => {
    const scene = createScene({ initialCapacity: 8 });
    const visible = scene.createEntity();
    const hidden = scene.createEntity();
    const disabled = scene.createEntity();
    scene.add(visible, Renderable, {
      mesh: "mesh",
      material: "material",
      visible: true,
      layer: 0,
    });
    scene.add(hidden, Renderable, {
      mesh: "mesh",
      material: "material",
      visible: false,
      layer: 0,
    });
    scene.add(disabled, Renderable, {
      mesh: "mesh",
      material: "material",
      visible: true,
      layer: 0,
    });
    scene.setEnabled(disabled, false);

    const transform = scene.get(visible, Transform);
    expect(transform).toBeDefined();
    if (transform === undefined) return;
    transform.position.x = 4;
    scene.markTransformDirty(visible);
    scene.updateWorldTransforms();

    const assets = library({
      mesh: { mesh: mesh(1) },
      material: { material: material(1) },
    });
    const encoder = createSceneEncoder();
    const frame = new FakeFrame();

    const submitted = encoder.encode(
      scene,
      assets,
      frame as unknown as RenderFrame,
    );

    expect(submitted).toBe(1);
    expect(encoder.stats.entities).toBe(2);
    expect(encoder.stats.skippedInvisible).toBe(1);
    expect(frame.draws).toHaveLength(1);
    expect(frame.draws[0]?.transform).toBe(scene.worldMatrix(visible));
  });

  test("[ER-00-15] reuses pooled query and order buffers on the steady path", () => {
    const scene = new FakeScene();
    const handles = [1, 2, 3].map((id) => ({ id, generation: 0 }));
    handles.forEach((handle, index) => {
      addRenderable(scene, handle, {
        mesh: "mesh",
        material: "material",
        visible: true,
        layer: index,
      });
    });

    const assets = library({
      mesh: { mesh: mesh(1) },
      material: { material: material(1) },
    });
    const encoder = createSceneEncoder();
    const stats = encoder.stats;
    const firstFrame = new FakeFrame();
    const secondFrame = new FakeFrame();

    encode(encoder, scene, assets, firstFrame);
    encode(encoder, scene, assets, secondFrame);

    expect(scene.queryOutputs).toHaveLength(2);
    expect(scene.queryOutputs[0]).toBe(scene.queryOutputs[1]);
    expect(encoder.stats).toBe(stats);
    expect(stats.submitted).toBe(3);
    expect(secondFrame.draws.map((draw) => draw.transform)).toEqual(
      firstFrame.draws.map((draw) => draw.transform),
    );
  });
});
