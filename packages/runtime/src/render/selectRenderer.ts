/**
 * Runtime renderer selection (00 §5.12, 04 §3.6, 05 §3.2).
 *
 * This module is the only runtime file that names the concrete backends. It
 * tries WebGPU, then WebGL2, then the Canvas2D fallback. It never UA-sniffs:
 * WebGPU is detected from `navigator.gpu` and WebGL2 is probed on a
 * disposable canvas. A failure is data, so the host can show a fixed notice
 * instead of a stack trace.
 *
 * Canvas2D is 2D-only. A caller that requires 3D (`require3D: true`) is
 * refused with `E_UNSUPPORTED_FEATURE` / `3d-on-canvas2d` before a Canvas2D
 * device is created; the selector never silently downgrades a 3D game.
 *
 * Canvas ownership: a canvas can only ever expose one context type. A failed
 * WebGPU init may already have called `getContext("webgpu")` on the host
 * canvas, so before WebGL2 (and again before Canvas2D) the selector asks the
 * injected `createScratchCanvas` seam for a replacement. The selected result
 * reports the canvas it actually used. When `result.canvas !== options.canvas`
 * the caller must put the returned canvas in place of the original.
 */

import type {
  RenderDevice,
  RenderDeviceOptions,
  RendererBackend,
  RendererCapabilities,
  Surface,
} from "@lanpad/engine-core";
import type {
  WebGpuDeviceInitResult,
  WebGpuDeviceOptions,
} from "@lanpad/engine-renderer-webgpu";
import type {
  WebGL2DeviceInitResult,
  WebGL2DeviceOptions,
  WebGL2Probe,
} from "@lanpad/engine-renderer-webgl2";
import type {
  Canvas2DDevice,
  Canvas2DDeviceOptions,
} from "@lanpad/engine-renderer-webgl2/canvas2d";

/** Why one backend did or did not supply the device. Fixed, sanitized tokens. */
export type RendererAttemptReason =
  | "selected"
  | "not-detected"
  | "unavailable"
  | "context-unavailable"
  | "context-threw"
  | "context-blocked"
  | "init-failed"
  | "requires-3d";

export interface RendererAttempt {
  readonly backend: RendererBackend;
  readonly ok: boolean;
  readonly reason: RendererAttemptReason;
}

/** The factories the selector calls. Tests inject fakes through this seam. */
export interface RendererSelectionFactories {
  /** True when `navigator.gpu` is present. Must not request an adapter. */
  readonly detectWebGpu: () => boolean;
  /** The WebGPU factory; it does not touch the canvas until `device.init`. */
  readonly createWebGpu: (
    options?: WebGpuDeviceOptions,
  ) => Promise<WebGpuDeviceInitResult>;
  /** Probes WebGL2 on a disposable canvas. A failure is data, never a throw. */
  readonly probeWebGl2: (
    canvas: HTMLCanvasElement | null,
  ) => WebGL2Probe | Promise<WebGL2Probe>;
  readonly createWebGl2: (
    options: WebGL2DeviceOptions,
  ) => Promise<WebGL2DeviceInitResult>;
  readonly createCanvas2D: (
    options: Canvas2DDeviceOptions,
  ) => Promise<Canvas2DDevice>;
  /** A fresh, unattached canvas; null when the environment has no DOM. */
  readonly createScratchCanvas: () => HTMLCanvasElement | null;
}

export interface RendererSelectionOptions {
  /** The host canvas the caller intends to render into. */
  readonly canvas: HTMLCanvasElement;
  /** Refuse instead of selecting Canvas2D. Default false (2D game). */
  readonly require3D?: boolean;
  /** Backend-neutral quality/limit options forwarded to a 3D backend. */
  readonly deviceOptions?: RenderDeviceOptions;
  /** Overrides `deviceOptions.maxRenderHeight`; the TV profile passes 1080. */
  readonly maxRenderHeight?: number;
  /** WebGL2-only TV profile flag; forwarded only when defined. */
  readonly tvProfile?: boolean;
  readonly factories?: Partial<RendererSelectionFactories>;
}

export interface RendererSelected {
  readonly ok: true;
  readonly backend: RendererBackend;
  readonly device: RenderDevice;
  readonly capabilities: RendererCapabilities;
  /** Display-only backend text; never a URL or a token. */
  readonly adapterInfo: string;
  /** The canvas the device is bound to; may differ from `options.canvas`. */
  readonly canvas: HTMLCanvasElement;
  /** True when at least one higher-priority backend was tried and failed. */
  readonly usedFallback: boolean;
  readonly attempts: readonly RendererAttempt[];
}

export interface RendererSelectionFailure {
  readonly ok: false;
  readonly code: "E_UNSUPPORTED_FEATURE" | "E_DEVICE_UNAVAILABLE";
  readonly detail: "3d-on-canvas2d" | "no-backend";
  /** Fixed copy: no raw exception text, URL or token. */
  readonly message: string;
  readonly attempts: readonly RendererAttempt[];
}

export type RendererSelection = RendererSelected | RendererSelectionFailure;

const THREE_D_MESSAGE =
  "This game needs a 3D renderer. This browser only offers the 2D canvas fallback.";
const NO_BACKEND_MESSAGE = "No supported renderer could start in this browser.";
const CANVAS2D_ADAPTER_INFO = "Canvas2D";

function defaultDetectWebGpu(): boolean {
  const navigatorValue = (
    globalThis as { readonly navigator?: { readonly gpu?: unknown } }
  ).navigator;
  return (
    typeof navigatorValue?.gpu === "object" && navigatorValue.gpu !== null
  );
}

function defaultCreateScratchCanvas(): HTMLCanvasElement | null {
  const documentValue = (globalThis as { readonly document?: Document })
    .document;
  return documentValue === undefined
    ? null
    : documentValue.createElement("canvas");
}

/** Default factories load backend code lazily so a 2D path stays light. */
const DEFAULT_FACTORIES: RendererSelectionFactories = {
  detectWebGpu: defaultDetectWebGpu,
  async createWebGpu(options) {
    const backend = await import("@lanpad/engine-renderer-webgpu");
    return backend.createWebGpuDevice(options);
  },
  async probeWebGl2(canvas) {
    if (canvas === null) return { available: false, reason: "no-context" };
    const backend = await import("@lanpad/engine-renderer-webgl2");
    return backend.probeWebGL2(canvas);
  },
  async createWebGl2(options) {
    const backend = await import("@lanpad/engine-renderer-webgl2");
    return backend.createWebGL2Device(options);
  },
  async createCanvas2D(options) {
    const backend = await import("@lanpad/engine-renderer-webgl2/canvas2d");
    return backend.createCanvas2DDevice(options);
  },
  createScratchCanvas: defaultCreateScratchCanvas,
};

function surfaceFor(canvas: HTMLCanvasElement): Surface {
  const cssWidth =
    typeof canvas.clientWidth === "number" && canvas.clientWidth > 0
      ? canvas.clientWidth
      : 0;
  const cssHeight =
    typeof canvas.clientHeight === "number" && canvas.clientHeight > 0
      ? canvas.clientHeight
      : 0;
  const ownerWindow = canvas.ownerDocument?.defaultView ?? null;
  const dprValue = ownerWindow?.devicePixelRatio;
  const dpr = typeof dprValue === "number" && dprValue > 0 ? dprValue : 1;
  return {
    kind: "canvas",
    native: canvas,
    cssWidth,
    cssHeight,
    dpr,
  };
}

function probeReason(reason: WebGL2Probe["reason"]): RendererAttemptReason {
  if (reason === "context-threw") return "context-threw";
  if (reason === "blocked") return "context-blocked";
  return "context-unavailable";
}

function webgl2Options(
  canvas: HTMLCanvasElement,
  deviceOptions: RenderDeviceOptions,
  maxRenderHeight: number | undefined,
  tvProfile: boolean | undefined,
): WebGL2DeviceOptions {
  return {
    ...deviceOptions,
    canvas,
    ...(maxRenderHeight !== undefined ? { maxRenderHeight } : {}),
    ...(tvProfile !== undefined ? { tvProfile } : {}),
  };
}

function canvas2dOptions(
  canvas: HTMLCanvasElement,
  maxRenderHeight: number | undefined,
  tvProfile: boolean | undefined,
): Canvas2DDeviceOptions {
  return {
    canvas,
    ...(maxRenderHeight !== undefined ? { maxRenderHeight } : {}),
    ...(tvProfile !== undefined ? { tvProfile } : {}),
  };
}

function selectedResult(
  backend: RendererBackend,
  device: RenderDevice,
  capabilities: RendererCapabilities,
  adapterInfo: string,
  canvas: HTMLCanvasElement,
  attempts: RendererAttempt[],
): RendererSelected {
  return {
    ok: true,
    backend,
    device,
    capabilities,
    adapterInfo,
    canvas,
    usedFallback: attempts.length > 1,
    attempts,
  };
}

function noBackendResult(
  attempts: RendererAttempt[],
): RendererSelectionFailure {
  return {
    ok: false,
    code: "E_DEVICE_UNAVAILABLE",
    detail: "no-backend",
    message: NO_BACKEND_MESSAGE,
    attempts,
  };
}

/**
 * Selects and initializes the best available backend.
 *
 * Order: WebGPU (when detected) -> WebGL2 (probe first) -> Canvas2D. Every
 * factory and probe is injectable; production uses the lazy imports above.
 * The function never throws for an unavailable backend.
 */
export async function selectRenderer(
  options: RendererSelectionOptions,
): Promise<RendererSelection> {
  const detectWebGpu =
    options.factories?.detectWebGpu ?? DEFAULT_FACTORIES.detectWebGpu;
  const createWebGpu =
    options.factories?.createWebGpu ?? DEFAULT_FACTORIES.createWebGpu;
  const probeWebGl2 =
    options.factories?.probeWebGl2 ?? DEFAULT_FACTORIES.probeWebGl2;
  const createWebGl2 =
    options.factories?.createWebGl2 ?? DEFAULT_FACTORIES.createWebGl2;
  const createCanvas2D =
    options.factories?.createCanvas2D ?? DEFAULT_FACTORIES.createCanvas2D;
  const createScratchCanvas =
    options.factories?.createScratchCanvas ??
    DEFAULT_FACTORIES.createScratchCanvas;

  const require3D = options.require3D === true;
  const maxRenderHeight =
    options.maxRenderHeight ?? options.deviceOptions?.maxRenderHeight;
  const deviceOptions: RenderDeviceOptions = {
    ...(options.deviceOptions ?? {}),
    ...(maxRenderHeight !== undefined ? { maxRenderHeight } : {}),
  };

  const attempts: RendererAttempt[] = [];
  let canvas = options.canvas;
  /**
   * True once a backend has been handed `canvas`. Even a failed attempt may
   * have created a context, and a canvas can never expose a second type.
   */
  let canvasClaimed = false;

  /** A replacement canvas, or null when none can be made or it is not fresh. */
  function scratchCanvas(): HTMLCanvasElement | null {
    const replacement = createScratchCanvas();
    return replacement === null || replacement === canvas
      ? null
      : replacement;
  }

  // ---------------------------------------------------------------- WebGPU
  if (detectWebGpu()) {
    let webgpu: WebGpuDeviceInitResult | null = null;
    try {
      webgpu = await createWebGpu(deviceOptions);
    } catch {
      // The factory does not touch the canvas, so the host canvas stays free.
      attempts.push({
        backend: "webgpu",
        ok: false,
        reason: "unavailable",
      });
    }

    if (webgpu !== null) {
      try {
        await webgpu.device.init(surfaceFor(canvas), deviceOptions);
        attempts.push({ backend: "webgpu", ok: true, reason: "selected" });
        return selectedResult(
          "webgpu",
          webgpu.device,
          webgpu.capabilities,
          webgpu.adapterInfo,
          canvas,
          attempts,
        );
      } catch {
        // init may fail after the swapchain called getContext("webgpu").
        canvasClaimed = true;
        try {
          webgpu.device.dispose();
        } catch {
          // Dispose failure must not replace the init failure.
        }
        attempts.push({
          backend: "webgpu",
          ok: false,
          reason: "init-failed",
        });
      }
    }
  } else {
    attempts.push({
      backend: "webgpu",
      ok: false,
      reason: "not-detected",
    });
  }

  // ---------------------------------------------------------------- WebGL2
  const probeCanvas = scratchCanvas();
  let probe: WebGL2Probe;
  if (probeCanvas === null) {
    probe = { available: false, reason: "no-context" };
  } else {
    try {
      probe = await probeWebGl2(probeCanvas);
    } catch {
      probe = { available: false, reason: "context-threw" };
    }
  }

  if (!probe.available) {
    attempts.push({
      backend: "webgl2",
      ok: false,
      reason: probeReason(probe.reason),
    });
  } else {
    let webgl2Canvas: HTMLCanvasElement | null = canvas;
    if (canvasClaimed) {
      const replacement = scratchCanvas();
      if (replacement === null) {
        webgl2Canvas = null;
        attempts.push({
          backend: "webgl2",
          ok: false,
          reason: "context-unavailable",
        });
      } else {
        canvas = replacement;
        webgl2Canvas = replacement;
        canvasClaimed = false;
      }
    }

    if (webgl2Canvas !== null) {
      try {
        const webgl2 = await createWebGl2(
          webgl2Options(
            webgl2Canvas,
            deviceOptions,
            maxRenderHeight,
            options.tvProfile,
          ),
        );
        attempts.push({ backend: "webgl2", ok: true, reason: "selected" });
        return selectedResult(
          "webgl2",
          webgl2.device,
          webgl2.capabilities,
          webgl2.adapterInfo,
          canvas,
          attempts,
        );
      } catch {
        // createWebGL2Device calls getContext before init; treat it as claimed.
        canvasClaimed = true;
        attempts.push({
          backend: "webgl2",
          ok: false,
          reason: "init-failed",
        });
      }
    }
  }

  // --------------------------------------------------------------- Canvas2D
  if (require3D) {
    attempts.push({
      backend: "canvas2d",
      ok: false,
      reason: "requires-3d",
    });
    return {
      ok: false,
      code: "E_UNSUPPORTED_FEATURE",
      detail: "3d-on-canvas2d",
      message: THREE_D_MESSAGE,
      attempts,
    };
  }

  let canvas2dCanvas: HTMLCanvasElement | null = canvas;
  if (canvasClaimed) {
    const replacement = scratchCanvas();
    if (replacement === null) {
      canvas2dCanvas = null;
      attempts.push({
        backend: "canvas2d",
        ok: false,
        reason: "context-unavailable",
      });
    } else {
      canvas = replacement;
      canvas2dCanvas = replacement;
      canvasClaimed = false;
    }
  }

  if (canvas2dCanvas === null) {
    return noBackendResult(attempts);
  }

  try {
    const canvas2d = await createCanvas2D(
      canvas2dOptions(canvas2dCanvas, maxRenderHeight, options.tvProfile),
    );
    attempts.push({ backend: "canvas2d", ok: true, reason: "selected" });
    return selectedResult(
      "canvas2d",
      canvas2d,
      canvas2d.capabilities,
      CANVAS2D_ADAPTER_INFO,
      canvas,
      attempts,
    );
  } catch {
    attempts.push({
      backend: "canvas2d",
      ok: false,
      reason: "init-failed",
    });
    return noBackendResult(attempts);
  }
}
