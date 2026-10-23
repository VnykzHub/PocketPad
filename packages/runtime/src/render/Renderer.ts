/**
 * Renderer contracts, WebGL2 capability gate and factory (D3-RT-02).
 *
 * The contract is frozen in `docs/todos/phase-1-dev/D3-runtime-v0.md`:
 * games depend on `Renderer2D`/`Renderer3D`, never on a concrete backend, so
 * the backend can be swapped without touching `CubeDemo` (FR-9.3, NR-6.2).
 * This module owns the two decisions the host must make before it draws
 * anything:
 *
 * 1. Is WebGL2 actually available? Feature detection only, no UA sniffing
 *    (FR-12.1). A probe creates (or reuses) the target canvas context.
 * 2. If not, fall back to the real Canvas2D path and describe a friendly
 *    screen that names the browser and suggests updating it or using PC+HDMI
 *    (FR-9.3). Nothing here throws just because WebGL2 is missing.
 *
 * `initRenderer` initialises the chosen backend and only rejects when *both*
 * backends fail; the rejection carries the same friendly notice, so the host
 * can render a static failure screen instead of a stack trace.
 *
 * Backend decision: this WebGL2 renderer is the fallback. The target engine
 * is a custom WebGPU-first renderer (`docs/engine/04-renderer-webgpu.md`);
 * Three.js is rejected (ADR-0002). The interfaces stay backend-agnostic, so
 * the WebGPU backend is a new class behind them.
 */
import {
  detectWebgl2,
  unavailableCapability,
  type Webgl2Capability,
} from "./capability.js";
import { Canvas2DRenderer } from "./Canvas2DRenderer.js";
import { WebGL2Renderer } from "./WebGL2Renderer.js";

export {
  COMPRESSED_TEXTURE_EXTENSIONS,
  detectWebgl2,
  listCompressedFormats,
} from "./capability.js";
export type { Webgl2Capability } from "./capability.js";

/**
 * Legacy renderer backends. `"webgpu"` is additive: the engine 3D adapter
 * reports its real device backend so the overlay never claims WebGL2 while
 * WebGPU is drawing.
 */
export type RendererBackend = "webgl2" | "webgpu" | "canvas2d";

/** What `Renderer.init` reports for budget and texture decisions. */
export interface RendererCapabilities {
  /** `gl.MAX_TEXTURE_SIZE`; 0 for Canvas2D. */
  maxTextureSize: number;
  /** Compressed texture extensions present, empty for Canvas2D (E1, PR-9.2). */
  compressedFormats: string[];
}

/**
 * Actual CSS-pixel size of the drawing surface. Games draw in a fixed
 * 1280x720 design space (HP-04) and use this to scale and letterbox; the
 * backing store and DPR stay the renderer's business.
 */
export interface RendererSize {
  readonly width: number;
  readonly height: number;
}

export interface Renderer {
  readonly backend: RendererBackend;
  init(canvas: HTMLCanvasElement): Promise<RendererCapabilities>;
  /** Sizes the backing store; CSS size is the upscaled presentation (FR-9.4). */
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  /**
   * CSS size last passed to `resize`, or a zero size before the first resize.
   * Optional so test doubles and third-party backends keep implementing the
   * frozen interface: games feature-detect it and draw 1:1 when it is absent.
   */
  readonly size?: RendererSize;
  beginFrame(alpha: number): void;
  endFrame(): void;
  dispose(): void;
  /** Draw calls issued in the current frame (PR-9.1). */
  readonly drawCalls: number;
  /** Estimated uploaded texture memory in MB (PR-9.2). */
  readonly textureMemoryMB: number;
}

export interface Renderer2D extends Renderer {
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

export interface Renderer3D extends Renderer {
  setCamera(
    position: { x: number; y: number; z: number },
    target: { x: number; y: number; z: number },
  ): void;
  drawCube(
    position: { x: number; y: number; z: number },
    size: number,
    color: string,
    rotationY: number,
  ): void;
}

/** Construction-time options shared by both backends. */
export interface RendererOptions {
  /**
   * Caps the backing-store height while the CSS size stays untouched, so the
   * browser upscales (FR-9.4). `undefined`/0 means no cap. The TV profile
   * passes 1080 (D3-RT-07).
   */
  readonly maxRenderHeight?: number;
}

export type FallbackReason =
  | "webgl2-unavailable"
  | "webgl2-init-failed"
  | "canvas2d-unavailable";

/** Friendly, renderable failure content; contains no tokens or internals. */
export interface RendererFallbackNotice {
  readonly reason: FallbackReason;
  readonly title: string;
  readonly message: string;
  readonly hints: string[];
}

/**
 * Display-only browser name for the failure screen. Capability decisions use
 * feature detection; the UA string is read here only so the message can say
 * "Chrome" instead of "your browser" (FR-12.1).
 */
export function displayBrowserName(
  navigatorLike: { userAgent?: string } | undefined = typeof navigator ===
  "undefined"
    ? undefined
    : navigator,
): string {
  const ua = navigatorLike?.userAgent ?? "";
  if (ua.includes("Edg/")) {
    return "Microsoft Edge";
  }
  if (ua.includes("OPR/")) {
    return "Opera";
  }
  if (ua.includes("Firefox/")) {
    return "Firefox";
  }
  if (ua.includes("Chrome/")) {
    return "Chrome";
  }
  if (ua.includes("Safari/")) {
    return "Safari";
  }
  return "this browser";
}

/**
 * Builds the friendly failure screen content (FR-9.3). The host may show the
 * notice even when Canvas2D saved the day, so the user knows why the picture
 * is flat; when both backends fail it is the whole screen.
 */
export function createFallbackNotice(
  reason: FallbackReason,
  browserName: string = "this browser",
): RendererFallbackNotice {
  const hints = [
    `Update ${browserName} to the latest version, then reload the page.`,
    "Connect a PC by HDMI to the TV and open the game there.",
    "If another browser is installed on this device, try it instead.",
  ];

  if (reason === "webgl2-unavailable") {
    return {
      reason,
      title: "WebGL2 is not available",
      message:
        `${browserName} cannot create a WebGL2 context, so 3D games cannot ` +
        "run on this device. The runtime continues in 2D compatibility mode.",
      hints,
    };
  }
  if (reason === "webgl2-init-failed") {
    return {
      reason,
      title: "WebGL2 could not start",
      message:
        `WebGL2 exists in ${browserName}, but the graphics context failed to ` +
        "initialize. The runtime continues in 2D compatibility mode.",
      hints,
    };
  }
  return {
    reason,
    title: "Cannot draw on this device",
    message:
      `${browserName} could not create a Canvas2D context either, so the ` +
      "game cannot be displayed here.",
    hints,
  };
}

/** Thrown only when both the preferred and fallback backends fail. */
export class RendererUnavailableError extends Error {
  readonly notice: RendererFallbackNotice;

  constructor(notice: RendererFallbackNotice, cause?: unknown) {
    super(notice.message);
    this.name = "RendererUnavailableError";
    this.notice = notice;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** Injectable factory seams; tests use them to simulate every outcome. */
export interface RendererFactoryOptions extends RendererOptions {
  /**
   * Capability probe. Receives the real host canvas so probing and `init`
   * share one WebGL2 context instead of creating two.
   */
  readonly detectWebgl2?: (canvas: HTMLCanvasElement) => Webgl2Capability;
  readonly createWebgl2?: (options: RendererOptions) => Renderer3D;
  readonly createCanvas2D?: (options: RendererOptions) => Renderer3D;
  /** Display-only; defaults to a UA-derived name (never a capability check). */
  readonly browserName?: string;
}

export interface RendererSelection {
  readonly renderer: Renderer3D;
  readonly backend: RendererBackend;
  /** True when the selected backend is WebGL2. */
  readonly webgl2: boolean;
  readonly capabilities: RendererCapabilities;
  /**
   * Non-null when the runtime is not on the requested backend. The host shows
   * this as the friendly fallback (FR-9.3).
   */
  readonly fallbackNotice: RendererFallbackNotice | null;
}

function toRendererOptions(
  factory: RendererFactoryOptions,
): RendererOptions {
  return factory.maxRenderHeight === undefined
    ? {}
    : { maxRenderHeight: factory.maxRenderHeight };
}

function disposeQuietly(renderer: Renderer3D): void {
  try {
    renderer.dispose();
  } catch {
    // A failed init may leave a half-built context; disposal is best effort.
  }
}

async function initCanvas2D(
  canvas: HTMLCanvasElement,
  options: RendererOptions,
  factory: RendererFactoryOptions,
  notice: RendererFallbackNotice | null,
): Promise<RendererSelection> {
  const create =
    factory.createCanvas2D ??
    ((rendererOptions: RendererOptions) =>
      new Canvas2DRenderer(rendererOptions));
  const renderer = create(options);
  try {
    const capabilities = await renderer.init(canvas);
    return {
      renderer,
      backend: "canvas2d",
      webgl2: false,
      capabilities,
      fallbackNotice: notice,
    };
  } catch (error) {
    disposeQuietly(renderer);
    throw new RendererUnavailableError(
      notice ?? createFallbackNotice("canvas2d-unavailable", factory.browserName),
      error,
    );
  }
}

/**
 * Creates and initialises the renderer. On a WebGL2-less browser this returns
 * a working Canvas2D renderer plus a notice; it does not throw. If even
 * Canvas2D fails, the rejection is a `RendererUnavailableError` carrying the
 * friendly notice for a static failure screen.
 */
export async function initRenderer(
  canvas: HTMLCanvasElement,
  preferred: RendererBackend = "webgl2",
  factory: RendererFactoryOptions = {},
): Promise<RendererSelection> {
  const options = toRendererOptions(factory);
  const browserName = factory.browserName ?? displayBrowserName();

  if (preferred === "webgl2") {
    const detect = factory.detectWebgl2 ?? ((target) => detectWebgl2(() => target));
    let capability: Webgl2Capability;
    try {
      capability = detect(canvas);
    } catch {
      capability = unavailableCapability();
    }

    if (capability.available) {
      const create =
        factory.createWebgl2 ??
        ((rendererOptions: RendererOptions) =>
          new WebGL2Renderer(rendererOptions));
      const renderer = create(options);
      try {
        const capabilities = await renderer.init(canvas);
        return {
          renderer,
          backend: "webgl2",
          webgl2: true,
          capabilities,
          fallbackNotice: null,
        };
      } catch {
        disposeQuietly(renderer);
        return initCanvas2D(
          canvas,
          options,
          factory,
          createFallbackNotice("webgl2-init-failed", browserName),
        );
      }
    }

    return initCanvas2D(
      canvas,
      options,
      factory,
      createFallbackNotice("webgl2-unavailable", browserName),
    );
  }

  return initCanvas2D(canvas, options, factory, null);
}
