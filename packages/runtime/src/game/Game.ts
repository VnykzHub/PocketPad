/**
 * Runtime re-export of the SDK game API (D3-SDK-01).
 *
 * The contract lives in `@lanpad/sdk` (`sdk/src/game-api.ts`) so third-party
 * games depend on the SDK only. The assignment below makes the compiler prove
 * that the runtime's concrete types satisfy the SDK's structural interfaces;
 * if a renderer, audio bus or snapshot drifts, this file stops compiling.
 */
import type {
  GameAudio,
  GameControllerState,
  GameInputSnapshot,
  GameRenderer3D,
} from "@lanpad/sdk";
import type { AudioBus } from "../audio/AudioBus.js";
import type { ControllerState, InputSnapshot } from "../input/types.js";
import type { Renderer3D } from "../render/Renderer.js";

export type {
  Game,
  GameAudio,
  GameContext,
  GameControllerState,
  GameDebug,
  GameEvent,
  GameHaptics,
  GameInputReader,
  GameInputSnapshot,
  GameLayouts,
  GameManifest,
  GameModule,
  GamePanels,
  GameRenderer3D,
  GameRendererBase,
  GameRng,
  JsonValue,
  Vec3,
} from "@lanpad/sdk";

/** Compile-time conformance checks; each member is `never` on drift. */
export type RuntimeConformsToSdk = [
  Renderer3D extends GameRenderer3D ? true : never,
  AudioBus extends GameAudio ? true : never,
  InputSnapshot extends GameInputSnapshot ? true : never,
  ControllerState extends GameControllerState ? true : never,
];
const conformance: RuntimeConformsToSdk = [true, true, true, true];
void conformance;
