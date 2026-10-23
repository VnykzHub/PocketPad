/**
 * Host-side GLB/glTF AssetContainer loading, kept inside `src/babylon/`.
 *
 * The boundary rule (ER-21-08) allows Babylon imports only under this
 * directory. The loader and glTF plugin are dynamic imports so 2D and
 * asset-free Babylon games never download them.
 */
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import type { Scene } from "@babylonjs/core/scene";

export interface LoadAssetContainerOptions {
  /** Stable asset id used for diagnostics, never a URL. */
  readonly name: string;
  /** Default `.glb`. */
  readonly pluginExtension?: ".glb" | ".gltf";
}

export async function loadAssetContainerFromBytes(
  bytes: Uint8Array,
  scene: Scene,
  options: LoadAssetContainerOptions,
): Promise<AssetContainer> {
  await import("@babylonjs/loaders/glTF/index.js");
  const { LoadAssetContainerAsync } = await import(
    "@babylonjs/core/Loading/sceneLoader"
  );
  return LoadAssetContainerAsync(bytes, scene, {
    pluginExtension: options.pluginExtension ?? ".glb",
    name: options.name,
  });
}
