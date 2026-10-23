/**
 * Babylon engine factory (B1, spec 21 §3.3).
 *
 * WebGPU first, WebGL2 second. A canvas can only ever expose one context
 * type, so a failed WebGPU init gets a fresh canvas from the document; the
 * stage mounts the canvas this function returns. A failure of both backends
 * is data, not a thrown stack trace.
 *
 * Babylon imports are kept inside `src/babylon/`, and the stage imports this
 * module lazily so 2D games never download the engine chunk (ER-21-08).
 */
import {
  BabylonGameRenderer,
  type BabylonBackend,
  type BabylonEngine,
  type BabylonGameRendererOptions,
} from "./BabylonGameRenderer.js";

export const BABYLON_UNAVAILABLE_MESSAGE =
  "No supported 3D renderer could start in this browser.";

export interface BabylonEngineSeams {
  /** Resolves an initialized WebGPU engine or rejects. */
  readonly createWebGpu: (canvas: HTMLCanvasElement) => Promise<BabylonEngine>;
  /** Creates an initialized WebGL2 engine or throws. May be async. */
  readonly createWebGl2: (
    canvas: HTMLCanvasElement,
  ) => BabylonEngine | Promise<BabylonEngine>;
  /** A fresh canvas for a backend that may claim one; null without a DOM. */
  readonly createCanvas: () => HTMLCanvasElement | null;
}

export interface CreateBabylonRendererOptions
  extends BabylonGameRendererOptions {
  readonly canvas: HTMLCanvasElement;
  /** Test/benchmark override. Production leaves it undefined. */
  readonly forceBackend?: BabylonBackend;
  /** Injected for tests; production uses the real Babylon classes. */
  readonly seams?: Partial<BabylonEngineSeams>;
}

export type CreateBabylonRendererResult =
  | {
      readonly ok: true;
      readonly renderer: BabylonGameRenderer;
      readonly backend: BabylonBackend;
      /** May differ from `options.canvas` after a WebGPU claim failure. */
      readonly canvas: HTMLCanvasElement;
      /** True when WebGPU was attempted and WebGL2 carried the frame. */
      readonly usedFallback: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: "unavailable";
      readonly message: string;
    };

async function createWebGpuEngine(
  canvas: HTMLCanvasElement,
): Promise<BabylonEngine> {
  const engines = await import("./createBabylonEngines.js");
  return engines.createWebGpuEngine(canvas);
}

async function createWebGl2Engine(
  canvas: HTMLCanvasElement,
): Promise<BabylonEngine> {
  const engines = await import("./createBabylonEngines.js");
  return engines.createWebGl2Engine(canvas);
}

function defaultCreateCanvas(): HTMLCanvasElement | null {
  const documentValue = (globalThis as { readonly document?: Document })
    .document;
  return documentValue === undefined
    ? null
    : documentValue.createElement("canvas");
}

function canvasFrom(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
  const owner = canvas.ownerDocument;
  return owner === undefined || owner === null
    ? defaultCreateCanvas()
    : owner.createElement("canvas");
}

/**
 * Creates the best available Babylon renderer. Never throws for an
 * unavailable backend; init-time failures surface as `ok: false` with fixed,
 * sanitized copy.
 */
export async function createBabylonGameRenderer(
  options: CreateBabylonRendererOptions,
): Promise<CreateBabylonRendererResult> {
  const createWebGpu = options.seams?.createWebGpu ?? createWebGpuEngine;
  const createWebGl2 = options.seams?.createWebGl2 ?? createWebGl2Engine;
  const createCanvas =
    options.seams?.createCanvas ?? (() => canvasFrom(options.canvas));

  let canvas = options.canvas;
  let engine: BabylonEngine | null = null;
  let backend: BabylonBackend = "webgpu";
  let usedFallback = false;

  if (options.forceBackend !== "webgl2") {
    try {
      engine = await createWebGpu(canvas);
    } catch {
      // A failed WebGPU init may have claimed the canvas.
      engine = null;
      const replacement = createCanvas();
      if (replacement !== null) canvas = replacement;
      usedFallback = true;
    }
  } else {
    usedFallback = true;
  }

  if (engine === null) {
    try {
      engine = await createWebGl2(canvas);
      backend = "webgl2";
    } catch {
      return {
        ok: false,
        reason: "unavailable",
        message: BABYLON_UNAVAILABLE_MESSAGE,
      };
    }
  }

  return {
    ok: true,
    renderer: new BabylonGameRenderer(engine, canvas, backend, options),
    backend,
    canvas,
    usedFallback,
  };
}
