/**
 * Adapter from a Babylon `AssetContainer` (what `loadAssetContainerAsync`
 * returns for a GLB) to the world's model-source seam.
 *
 * This file does not import `@babylonjs/loaders`; loading stays with stream B
 * so `packages/runtime` does not grow a loader dependency it does not use yet.
 */
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";
import type { BabylonModelInstance, BabylonModelSource } from "./types.js";

/**
 * Wraps a loaded container. Each `instantiate` call clones nodes, skeletons and
 * animation groups through Babylon's own graph conversion, so two actors never
 * share a skeleton or a playing clip.
 */
export function createAssetContainerModelSource(
  container: AssetContainer,
): BabylonModelSource {
  const clips = container.animationGroups.map((group) => group.name);
  return {
    clips,
    instantiate(scene: Scene, name: string): BabylonModelInstance | null {
      // `scene` is part of the seam contract; the container already owns the
      // scene it was loaded into.
      void scene;
      const entries = container.instantiateModelsToScene(
        (sourceName) => `${name}-${sourceName}`,
        false,
      );
      if (entries.rootNodes.length === 0) {
        entries.dispose();
        return null;
      }

      // The name function also renamed cloned animation groups; restore the
      // source clip names so game-facing names stay stable across actors.
      for (let index = 0; index < entries.animationGroups.length; index += 1) {
        const sourceGroup = container.animationGroups[index];
        const clonedGroup = entries.animationGroups[index];
        if (sourceGroup !== undefined && clonedGroup !== undefined) {
          clonedGroup.name = sourceGroup.name;
        }
      }

      const meshes: AbstractMesh[] = [];
      for (const root of entries.rootNodes) {
        for (const mesh of root.getChildMeshes(false)) {
          meshes.push(mesh);
        }
      }

      for (const group of entries.animationGroups) {
        group.stop();
        group.reset();
      }

      let disposed = false;
      return {
        roots: entries.rootNodes.slice(),
        meshes,
        animationGroups: entries.animationGroups.slice(),
        dispose() {
          if (disposed) return;
          disposed = true;
          entries.dispose();
        },
      };
    },
  };
}
