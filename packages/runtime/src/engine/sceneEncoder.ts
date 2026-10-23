/**
 * Scene encoder (runtime composition root; 04 §5.4 step 2, 03 §5.11).
 *
 * The runtime owns the encoder because the renderers must not import the
 * asset package. Each frame it:
 *
 * 1. queries enabled entities that have the `Renderable` component;
 * 2. reads the component and resolves the mesh/material asset ids through an
 *    injected `AssetLibrary`-shaped resolver;
 * 3. reads the world matrix the tick's transform pass produced;
 * 4. stable-sorts by layer, material and mesh, preserving submission order;
 * 5. submits `RenderFrame.draw` calls in that order. The renderer never sorts.
 *
 * The encoder never calls `scene.updateWorldTransforms()`: that is tick step
 * 7 (RV-04). Reading a matrix before the tick updated it would render stale
 * transforms; the runtime wires the update behind `ctx.scene`.
 *
 * No per-frame allocation: the query output, the four parallel draw arrays
 * and the order index are pooled on the encoder. `encode` only writes into
 * them. The comparator is a stable arrow property, not a closure per frame.
 *
 * GPU-ready values: the injected library maps an asset id to a drawable
 * record holding the opaque `MeshHandle`/`MaterialHandle`. Turning decoded
 * bytes into those handles is the asset-to-GPU bridge's job, not this file's.
 */

import {
  Renderable,
  type EngineScene,
  type Entity,
  type Mat4,
  type MaterialHandle,
  type MeshHandle,
  type RenderFrame,
} from "@lanpad/engine-core";
import type { AssetState } from "@lanpad/engine-assets";

/** What a GPU-ready asset id resolves to. Either member may be absent. */
export interface SceneDrawableAsset {
  readonly mesh?: MeshHandle;
  readonly material?: MaterialHandle;
}

/**
 * The subset of `AssetHandle` the encoder reads. A real
 * `@lanpad/engine-assets` `AssetHandle` satisfies it structurally.
 */
export interface SceneAssetHandle<T = unknown> {
  readonly state: AssetState;
  /** Valid only when `state === "ready"`; never read before that check. */
  readonly value: T;
}

/**
 * The subset of `AssetLibrary` the encoder calls. An `AssetLibrary` is
 * assignable to this type without an adapter.
 */
export interface SceneAssetLibrary {
  get<T = unknown>(id: string): SceneAssetHandle<T> | undefined;
}

/**
 * Stable object mutated once per `encode`. Callers copy fields; they must not
 * retain the encoder's internal pools.
 */
export interface SceneEncoderStats {
  /** Enabled entities returned by the query. */
  entities: number;
  /** Draws submitted to the frame. */
  submitted: number;
  /** Renderables skipped because `visible === false`. */
  skippedInvisible: number;
  /** Draws skipped because a mesh/material asset was absent or not ready. */
  skippedUnresolved: number;
  /** Draws skipped because the scene had no world matrix yet. */
  skippedNoTransform: number;
}

export interface SceneEncoder {
  /** Returns the number of draws submitted. */
  encode(
    scene: EngineScene,
    assets: SceneAssetLibrary,
    frame: RenderFrame,
  ): number;
  readonly stats: SceneEncoderStats;
}

/** Reads a ready asset value; returns undefined for missing or unready ids. */
function readyValue<T>(
  assets: SceneAssetLibrary,
  id: string,
): T | undefined {
  if (id.length === 0) return undefined;
  const handle = assets.get<T>(id);
  if (handle === undefined || handle.state !== "ready") return undefined;
  return handle.value;
}

class SceneEncoderImpl implements SceneEncoder {
  readonly stats: SceneEncoderStats = {
    entities: 0,
    submitted: 0,
    skippedInvisible: 0,
    skippedUnresolved: 0,
    skippedNoTransform: 0,
  };

  /** Query output, reused every frame (query clears it first). */
  private readonly entities: Entity[] = [];
  private readonly meshes: (MeshHandle | undefined)[] = [];
  private readonly materials: (MaterialHandle | undefined)[] = [];
  private readonly matrices: (Mat4 | undefined)[] = [];
  private readonly layers: number[] = [];
  /** Sort indices; one shared array, never reallocated after warm-up. */
  private readonly order: number[] = [];

  /**
   * Total order: layer, material, mesh, then the original submission index.
   * The final tie-breaker keeps equal keys in submission order regardless of
   * the JavaScript engine's sort stability.
   */
  private readonly compare = (a: number, b: number): number => {
    const layerDifference = this.layers[a]! - this.layers[b]!;
    if (layerDifference !== 0) return layerDifference;

    const materialA = this.materials[a]!;
    const materialB = this.materials[b]!;
    if (materialA.index !== materialB.index) {
      return materialA.index - materialB.index;
    }
    if (materialA.generation !== materialB.generation) {
      return materialA.generation - materialB.generation;
    }

    const meshA = this.meshes[a]!;
    const meshB = this.meshes[b]!;
    if (meshA.index !== meshB.index) return meshA.index - meshB.index;
    if (meshA.generation !== meshB.generation) {
      return meshA.generation - meshB.generation;
    }

    return a - b;
  };

  encode(
    scene: EngineScene,
    assets: SceneAssetLibrary,
    frame: RenderFrame,
  ): number {
    const stats = this.stats;
    stats.entities = 0;
    stats.submitted = 0;
    stats.skippedInvisible = 0;
    stats.skippedUnresolved = 0;
    stats.skippedNoTransform = 0;

    const queried = scene.query(this.entities, Renderable);
    const queryCount = queried.length;
    stats.entities = queryCount;

    let drawable = 0;
    for (let index = 0; index < queryCount; index += 1) {
      const entity = queried[index]!;
      const renderable = scene.get(entity, Renderable);
      if (renderable === undefined) continue;

      if (!renderable.visible) {
        stats.skippedInvisible += 1;
        continue;
      }

      const meshAsset = readyValue<SceneDrawableAsset>(
        assets,
        renderable.mesh,
      );
      const materialAsset = readyValue<SceneDrawableAsset>(
        assets,
        renderable.material,
      );
      const mesh = meshAsset?.mesh;
      const material = materialAsset?.material;
      if (mesh === undefined || material === undefined) {
        stats.skippedUnresolved += 1;
        continue;
      }

      const matrix = scene.worldMatrix(entity);
      if (matrix === undefined) {
        stats.skippedNoTransform += 1;
        continue;
      }

      this.meshes[drawable] = mesh;
      this.materials[drawable] = material;
      this.matrices[drawable] = matrix;
      this.layers[drawable] = renderable.layer;
      drawable += 1;
    }

    const order = this.order;
    order.length = drawable;
    for (let index = 0; index < drawable; index += 1) {
      order[index] = index;
    }
    order.sort(this.compare);

    for (let index = 0; index < drawable; index += 1) {
      const slot = order[index]!;
      frame.draw(
        this.meshes[slot]!,
        this.materials[slot]!,
        this.matrices[slot]!,
      );
    }

    stats.submitted = drawable;
    return drawable;
  }
}

export function createSceneEncoder(): SceneEncoder {
  return new SceneEncoderImpl();
}
