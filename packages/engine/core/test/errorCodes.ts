/**
 * Single runtime list of the frozen `EngineErrorCode` union (00 §5.9 plus the
 * additive codes recorded in `contracts/engine.d.ts`).
 *
 * The list is compile-time checked in both directions: every entry must be a
 * member of the union (`satisfies`), and every union member must be listed
 * (`UnlistedCode`). Contract tests share this list so the taxonomy and the
 * streaming coverage check cannot drift apart.
 */

import type { EngineErrorCode } from "../src/index";

export const ERROR_CODES = [
  // Devices, renderer, assets (00 §5.9).
  "E_DEVICE_UNAVAILABLE",
  "E_DEVICE_LOST",
  "E_BACKEND_INIT",
  "E_PIPELINE_COMPILE",
  "E_UNSUPPORTED_FEATURE",
  "E_ASSET_LOAD",
  "E_ASSET_FORMAT",
  "E_ASSET_BUDGET",
  "E_ASSET_HASH",
  "E_ASSET_NOT_READY",
  "E_ASSET_UNKNOWN",
  "E_ASSET_ABORTED",
  "E_ASSET_UNSUPPORTED",
  "E_ASSET_EVICTED",
  // Input and audio.
  "E_INPUT_FORMAT",
  "E_INPUT_CONFLICT",
  "E_INPUT_RESERVED",
  "E_INPUT_CAPTURE",
  "E_INPUT_TICK",
  "E_INPUT_DEVICE",
  "E_AUDIO_DEVICE",
  "E_AUDIO_DECODE",
  "E_AUDIO_FORMAT",
  "E_AUDIO_BUDGET",
  // Scene, save, worker, contract.
  "E_SCENE_INVALID",
  "E_SCENE_FORMAT",
  "E_STALE_HANDLE",
  "E_SAVE_FORMAT",
  "E_SAVE_VERSION",
  "E_SAVE_HASH",
  "E_SAVE_GAME",
  "E_SAVE_QUOTA",
  "E_SAVE_IO",
  "E_SAVE_MIGRATION",
  "E_SAVE_SLOT",
  "E_SAVE_UNSUPPORTED",
  // World streaming (12 §3.4, §4.1, §4.2, §5.5, §5.7, §9).
  "E_WORLD_FORMAT",
  "E_WORLD_ID",
  "E_WORLD_SEED",
  "E_WORLD_CELL_SIZE",
  "E_WORLD_GRID",
  "E_WORLD_KEY",
  "E_WORLD_DUPLICATE",
  "E_WORLD_HOLE",
  "E_WORLD_URL",
  "E_WORLD_LOD3",
  "E_WORLD_LOD_BANDS",
  "E_WORLD_BUDGET",
  "E_WORLD_ENTRY",
  "E_CELL_FORMAT",
  "E_CELL_HASH",
  "E_CELL_SECTION",
  "E_CELL_KIND",
  "E_CELL_SIZE",
  "E_CELL_APPLY",
  "E_STREAM_FETCH",
  "E_STREAM_DECOMPRESS",
  "E_STREAM_BUDGET",
  "E_STREAM_SIM_BUDGET",
  "E_STREAM_PIN_BUDGET",
  "E_STREAM_ABORT",
  "E_STREAM_STATE",
  "E_STREAM_DISPOSED",
  "E_STATE_FORMAT",
  "E_STATE_WORLD",
  "E_STATE_BOUNDS",
  "E_STATE_ORDER",
  "E_STATE_HASH",
  // Worker, frame, contract.
  "E_WORKER_FAILED",
  "E_FRAME_CLOSED",
  "E_CONTRACT",
] as const satisfies readonly EngineErrorCode[];

type UnlistedCode = Exclude<EngineErrorCode, (typeof ERROR_CODES)[number]>;
const coversEveryUnionMember: UnlistedCode extends never ? true : false = true;

/** Compile-time checked: true iff `ERROR_CODES` names every union member. */
export const ERROR_CODES_ARE_COMPLETE: boolean = coversEveryUnionMember;
