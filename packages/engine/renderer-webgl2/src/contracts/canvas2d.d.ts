/**
 * Canvas2D 2D entry contract (spec 05 §5.10), importable as
 * `@lanpad/engine-renderer-webgl2/canvas2d` so a 2D-only build never pulls the
 * 3D WebGL2 shader set (05 §3.1).
 *
 * The device satisfies the frozen core `RenderDevice` structurally so the
 * runtime can hold one device type, but only the lifecycle and the five 2D
 * calls below work. Every 3D resource creation or draw call throws/rejects an
 * `EngineError` with code `E_UNSUPPORTED_FEATURE` (detail "3d-on-canvas2d"),
 * never a silent stub. A 3D game is refused before `game.init`; it never
 * receives this device (05 §3.5, ER-05-07).
 */

import type { RenderDevice } from "@lanpad/engine-core";

/** Construction options (05 §5.10). */
export interface Canvas2DDeviceOptions {
  readonly canvas: HTMLCanvasElement;
  /** Caps the backing-store height only; CSS size is untouched. 0 = no cap. */
  readonly maxRenderHeight?: number;
  /** TV profile: DPR 1 and a 1080 backing-store cap by default. */
  readonly tvProfile?: boolean;
}

/**
 * Canvas2D device (05 §5.10). `backend` is `"canvas2d"`, `features` is an empty
 * set, and `limits` reports `maxTextureSize: 0`, `maxSamples: 0`,
 * `maxAnisotropy: 0`.
 *
 * The 2D calls keep the exact current semantics of
 * `packages/runtime/src/render/Canvas2DRenderer.ts`: CSS-pixel coordinates via
 * `setTransform`, a 1280x720 design space owned by the game, backing-store DPR
 * scaling and the `maxRenderHeight` cap.
 */
export interface Canvas2DDevice extends RenderDevice {
  readonly backend: "canvas2d";
  clear(color: string): void;
  circle(x: number, y: number, r: number, color: string): void;
  rect(x: number, y: number, w: number, h: number, color: string): void;
  text(
    text: string,
    x: number,
    y: number,
    size: number,
    color: string,
    align?: "left" | "center" | "right",
  ): void;
  polyline(
    points: ReadonlyArray<{ x: number; y: number }>,
    width: number,
    color: string,
  ): void;
}

/**
 * Creates the Canvas2D device. Rejects when `getContext("2d")` returns null;
 * the host then shows the `E_DEVICE_UNAVAILABLE` failure screen (05 §5.10).
 */
export function createCanvas2DDevice(
  options: Canvas2DDeviceOptions,
): Promise<Canvas2DDevice>;

type ContractAssert<T extends true> = T;

/**
 * Compile-time assignability check: the Canvas2D contract satisfies the frozen
 * core `RenderDevice`. Fails typecheck if either contract drifts.
 */
export type Canvas2DDeviceIsRenderDevice = ContractAssert<
  Canvas2DDevice extends RenderDevice ? true : false
>;
