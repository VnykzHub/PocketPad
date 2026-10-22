/**
 * @lanpad/runtime — host runtime contracts (D0-RT-01, D3).
 *
 * D0 exported the host network client and the debug input table. D3 adds the
 * fixed loop, input mapper, renderer interfaces/backends, asset loader,
 * audio bus, start screen, TV profile / dynamic resolution and the game API
 * (`Game`, `GameHost`, `loadGame`). Games import the SDK game API, never the
 * host client, so they never see sockets (FR-7.17).
 *
 * `debug/Overlay.ts` is intentionally not exported: it imports a stylesheet
 * that only the Vite host build can resolve.
 */
export * from "./net/hostClient.js";
export * from "./net/hostReconnect.js";
export * from "./debug/inputTable.js";
export * from "./loop/FixedLoop.js";
export type * from "./loop/types.js";
export { InputMapper } from "./input/InputMapper.js";
export type {
  ControllerState,
  InputMapperOptions,
  InputSnapshot,
  SlotStats as InputSlotStats,
} from "./input/types.js";
export * from "./input/TiltIntegrator.js";
export * from "./render/Renderer.js";
export { Canvas2DRenderer } from "./render/Canvas2DRenderer.js";
export { WebGL2Renderer } from "./render/WebGL2Renderer.js";
export * from "./render/CubeDemo.js";
export {
  AssetLoader,
  AssetLoadError,
  ASSET_TYPES,
  INITIAL_DOWNLOAD_LIMIT_BYTES,
  validateAssetEntries,
  type AssetEntry,
  type AssetErrorCode,
  type AssetLoaderDeps,
  type AssetProgress,
  type AssetType,
  type LoadedAsset,
  type LoadResult,
} from "./assets/AssetLoader.js";
export * from "./assets/ProgressBar.js";
export * from "./audio/AudioBus.js";
export * from "./ui/StartScreen.js";
export * from "./profile/index.js";
export * from "./game/Game.js";
export * from "./game/GameContext.js";
export * from "./game/GameHost.js";
export * from "./game/InputReader.js";
export * from "./game/LayoutApi.js";
export * from "./game/PanelApi.js";
export * from "./game/EventRouter.js";
export * from "./game/HapticApi.js";
export * from "./game/loadGame.js";
export * from "./game/manifestLayouts.js";
export * from "./game/registry.js";
export * from "./game/RoundManager.js";
export * from "./ui/HostStatus.js";
