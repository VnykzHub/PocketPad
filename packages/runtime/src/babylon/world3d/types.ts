/**
 * Babylon-side seam between the world adapter and the asset resolver
 * (stream B). Babylon types are deliberately confined to
 * `packages/runtime/src/babylon/**`; `sdk/src/world3d.ts` stays opaque.
 *
 * The adapter never loads a URL itself. Stream B (or the bake-off experiment)
 * supplies a provider, which keeps asset policy, loaders and caching in one
 * place and lets Node tests use a procedural fixture.
 */
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Node } from "@babylonjs/core/node";
import type { Scene } from "@babylonjs/core/scene";

/** One instantiated copy of a model, owned by the actor that spawned it. */
export interface BabylonModelInstance {
  /** Roots parented under the actor's transform node. */
  readonly roots: readonly Node[];
  /** Renderable meshes, used for shadows and tint/emissive. */
  readonly meshes: readonly AbstractMesh[];
  /** Clips as instantiated for this copy; names match `BabylonModelSource.clips`. */
  readonly animationGroups: readonly AnimationGroup[];
  /** Must be idempotent; disposes nodes and groups, never shared GPU caches. */
  dispose(): void;
}

/** A loaded model that can be instantiated any number of times. */
export interface BabylonModelSource {
  /** Stable clip names exposed to `playClip`/`crossfadeClip`. */
  readonly clips: readonly string[];
  /**
   * Creates an independent copy. Returns null when the source has no
   * renderable roots; the adapter maps that to `E_WORLD_ASSET` without a
   * partial actor.
   */
  instantiate(scene: Scene, name: string): BabylonModelInstance | null;
}

/**
 * Asset resolver seam. `hasModel` is the non-throwing probe behind
 * `GameWorld3D.hasModel`; `getModel` returns the prepared source or null.
 * Texture support is optional so a provider can stay model-only.
 */
export interface BabylonModelProvider {
  hasModel(assetId: string): boolean;
  getModel(assetId: string): BabylonModelSource | null;
  hasTexture?(assetId: string): boolean;
  getTexture?(assetId: string, scene: Scene): Texture | null;
}

/** Public options for `BabylonGameRenderer.createWorld()`. */
export interface BabylonWorldOptions {
  /** Required for `spawnModel`/`spawnInstances`/`setSkyTexture`; primitives work without it. */
  readonly provider?: BabylonModelProvider;
  /** Overrides the tier default; must be a positive integer. */
  readonly maxActors?: number;
  readonly maxInstances?: number;
}
