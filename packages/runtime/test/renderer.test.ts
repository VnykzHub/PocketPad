import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { InputSnapshot } from "../src/input/types.js";
import { Canvas2DRenderer } from "../src/render/Canvas2DRenderer.js";
import {
  CUBE_DEMO_COLORS,
  CUBE_DEMO_TURN_RATE,
  CubeDemo,
  createCubeDemo,
} from "../src/render/CubeDemo.js";
import {
  RendererUnavailableError,
  createFallbackNotice,
  detectWebgl2,
  displayBrowserName,
  initRenderer,
  type Renderer3D,
} from "../src/render/Renderer.js";
import {
  INSTANCING_THRESHOLD,
  WebGL2Renderer,
  type CubeInstance,
} from "../src/render/WebGL2Renderer.js";

const DT = 1 / 60;
/** 0.0..1.0 with no float drift, unlike Math.PI * 2. */
const EDGE_A = 1;

// ---------------------------------------------------------------------------
// Fakes: the runtime test project runs in Node, so canvas/context objects are
// hand-rolled. Every fake is cast at the boundary; the code under test only
// uses the documented WebGL2 / Canvas2D surface.
// ---------------------------------------------------------------------------

// Fakes mirror the browser API surface, so most parameters are declared only
// to keep the call signatures type-checked and are intentionally unused.
/* eslint-disable @typescript-eslint/no-unused-vars */

class FakeStyle {
  width = "";
  height = "";
}

class FakeCanvas {
  width = 300;
  height = 150;
  readonly style = new FakeStyle();
  private readonly contexts: Record<string, unknown>;

  constructor(contexts: Record<string, unknown>) {
    this.contexts = contexts;
  }

  getContext(kind: string): unknown {
    return this.contexts[kind] ?? null;
  }
}

class Fake2DContext {
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 0;
  font = "";
  textAlign = "left";
  readonly calls: string[] = [];

  setTransform(...args: number[]): void {
    this.calls.push(`setTransform:${args.join(",")}`);
  }

  fillRect(...args: number[]): void {
    this.calls.push(`fillRect:${args.join(",")}`);
  }

  beginPath(): void {
    this.calls.push("beginPath");
  }

  arc(...args: number[]): void {
    this.calls.push(`arc:${args.join(",")}`);
  }

  fill(): void {
    this.calls.push("fill");
  }

  moveTo(...args: number[]): void {
    this.calls.push(`moveTo:${args.join(",")}`);
  }

  lineTo(...args: number[]): void {
    this.calls.push(`lineTo:${args.join(",")}`);
  }

  stroke(): void {
    this.calls.push("stroke");
  }

  fillText(text: string): void {
    this.calls.push(`fillText:${text}`);
  }

  save(): void {
    this.calls.push("save");
  }

  restore(): void {
    this.calls.push("restore");
  }

  translate(...args: number[]): void {
    this.calls.push(`translate:${args.join(",")}`);
  }

  rotate(angle: number): void {
    this.calls.push(`rotate:${angle}`);
  }
}

class FakeWebGL2 {
  readonly VERTEX_SHADER = 35633;
  readonly FRAGMENT_SHADER = 35632;
  readonly COMPILE_STATUS = 35713;
  readonly LINK_STATUS = 35714;
  readonly ARRAY_BUFFER = 34962;
  readonly STATIC_DRAW = 35044;
  readonly DYNAMIC_DRAW = 35048;
  readonly FLOAT = 5126;
  readonly TRIANGLES = 4;
  readonly DEPTH_TEST = 2929;
  readonly LEQUAL = 515;
  readonly COLOR_BUFFER_BIT = 16384;
  readonly DEPTH_BUFFER_BIT = 256;

  readonly maxTextureSize: number;
  readonly supportedExtensions: string[];
  readonly drawInstanceCounts: number[] = [];
  readonly uploadLengths: number[] = [];
  readonly shaderSources: string[] = [];
  readonly viewports: Array<readonly [number, number, number, number]> = [];
  failCompile: boolean;

  constructor(options: { failCompile?: boolean } = {}) {
    this.failCompile = options.failCompile ?? false;
    this.maxTextureSize = 16384;
    this.supportedExtensions = [
      "WEBGL_compressed_texture_s3tc",
      "EXT_texture_compression_bptc",
    ];
  }

  createShader(_type: number): object {
    return {};
  }

  shaderSource(_shader: object, source: string): void {
    this.shaderSources.push(source);
  }

  compileShader(_shader: object): void {}

  getShaderParameter(_shader: object, _pname: number): boolean {
    return !this.failCompile;
  }

  getShaderInfoLog(): string {
    return this.failCompile ? "simulated compile failure" : "";
  }

  createProgram(): object {
    return {};
  }

  attachShader(_program: object, _shader: object): void {}

  linkProgram(_program: object): void {}

  deleteShader(_shader: object): void {}

  getProgramParameter(_program: object, _pname: number): boolean {
    return true;
  }

  getProgramInfoLog(): string {
    return "";
  }

  deleteProgram(_program: object): void {}

  getUniformLocation(_program: object, _name: string): object {
    return {};
  }

  createBuffer(): object {
    return {};
  }

  createVertexArray(): object {
    return {};
  }

  bindBuffer(_target: number, _buffer: object): void {}

  bufferData(..._args: unknown[]): void {}

  bufferSubData(
    _target: number,
    _dst: number,
    _src: Float32Array,
    _srcOffset: number,
    length: number,
  ): void {
    this.uploadLengths.push(length);
  }

  bindVertexArray(_array: object | null): void {}

  enableVertexAttribArray(_index: number): void {}

  vertexAttribPointer(..._args: unknown[]): void {}

  vertexAttribDivisor(_index: number, _divisor: number): void {}

  enable(_cap: number): void {}

  depthFunc(_func: number): void {}

  viewport(x: number, y: number, width: number, height: number): void {
    this.viewports.push([x, y, width, height]);
  }

  clearColor(..._args: number[]): void {}

  clear(_mask: number): void {}

  useProgram(_program: object): void {}

  uniformMatrix4fv(
    _location: object,
    _transpose: boolean,
    _value: Float32Array,
  ): void {}

  deleteVertexArray(_array: object): void {}

  deleteBuffer(_buffer: object): void {}

  drawArraysInstanced(
    _mode: number,
    _first: number,
    _count: number,
    instances: number,
  ): void {
    this.drawInstanceCounts.push(instances);
  }

  getParameter(pname: number): number {
    return pname === 0x0d33 ? this.maxTextureSize : 0;
  }

  getSupportedExtensions(): string[] {
    return this.supportedExtensions;
  }
}

function canvasWith(contexts: Record<string, unknown>): HTMLCanvasElement {
  return new FakeCanvas(contexts) as unknown as HTMLCanvasElement;
}

function snapshotWith(lx: number, ly: number, edges = 0): InputSnapshot {
  return {
    tick: 1,
    players: [
      {
        slot: 1,
        buttons: edges,
        edges,
        lx,
        ly,
        rx: 0,
        ry: 0,
        gyro: { x: 0, y: 0, z: 0 },
        gyroActive: false,
        gyroRecentered: false,
        triggers: { lt: 0, rt: 0 },
        tick: 1,
      },
    ],
  };
}

/** Records calls made by `CubeDemo`; proves it is renderer-agnostic. */
class RecordingRenderer3D implements Renderer3D {
  readonly backend = "canvas2d" as const;
  readonly frames: number[] = [];
  readonly rotations: number[] = [];
  readonly origins: Array<{ x: number; y: number; z: number }> = [];
  readonly cameraPositions: Array<{ x: number; y: number; z: number }> = [];
  readonly cameraTargets: Array<{ x: number; y: number; z: number }> = [];
  readonly colors: string[] = [];
  readonly sizes: number[] = [];
  drawCalls = 0;
  textureMemoryMB = 0;

  async init(): Promise<{ maxTextureSize: number; compressedFormats: string[] }> {
    return { maxTextureSize: 0, compressedFormats: [] };
  }

  resize(_cssWidth: number, _cssHeight: number, _dpr: number): void {}

  beginFrame(alpha: number): void {
    this.frames.push(alpha);
    this.drawCalls = 0;
  }

  endFrame(): void {}

  setCamera(
    position: { x: number; y: number; z: number },
    target: { x: number; y: number; z: number },
  ): void {
    this.cameraPositions.push(position);
    this.cameraTargets.push(target);
  }

  drawCube(
    position: { x: number; y: number; z: number },
    size: number,
    color: string,
    rotationY: number,
  ): void {
    this.origins.push(position);
    this.sizes.push(size);
    this.colors.push(color);
    this.rotations.push(rotationY);
    this.drawCalls += 1;
  }

  dispose(): void {}
}

/* eslint-enable @typescript-eslint/no-unused-vars */

// ---------------------------------------------------------------------------
// Capability gate and friendly fallback (FR-9.3, FR-12.1)
// ---------------------------------------------------------------------------

describe("WebGL2 capability gate", () => {
  test("[FR-9.3, FR-12.1] detection reads MAX_TEXTURE_SIZE and E1 compressed formats", () => {
    const gl = new FakeWebGL2();
    const canvas = canvasWith({ webgl2: gl });

    const capability = detectWebgl2(() => canvas);

    expect(capability.available).toBe(true);
    expect(capability.maxTextureSize).toBe(16384);
    expect(capability.compressedFormats).toEqual([
      "WEBGL_compressed_texture_s3tc",
      "EXT_texture_compression_bptc",
    ]);
  });

  test("[FR-9.3, FR-12.1] a missing WebGL2 context is unavailable, not an exception", () => {
    const canvas = canvasWith({});
    expect(detectWebgl2(() => canvas)).toEqual({
      available: false,
      maxTextureSize: 0,
      compressedFormats: [],
    });
  });

  test("[FR-9.3, FR-12.1] a browser without WebGL2 falls back to Canvas2D with a friendly notice", async () => {
    const context = new Fake2DContext();
    const canvas = canvasWith({ "2d": context });

    const selection = await initRenderer(canvas, "webgl2", {
      browserName: "Chrome",
    });

    expect(selection.backend).toBe("canvas2d");
    expect(selection.webgl2).toBe(false);
    expect(selection.capabilities).toEqual({
      maxTextureSize: 0,
      compressedFormats: [],
    });
    const notice = selection.fallbackNotice;
    expect(notice).not.toBeNull();
    expect(notice?.reason).toBe("webgl2-unavailable");
    expect(notice?.title).toContain("WebGL2");
    expect(notice?.message).toContain("Chrome");
    const hints = notice?.hints.join(" ") ?? "";
    expect(hints).toContain("Update Chrome");
    expect(hints).toContain("HDMI");
    expect(hints.toLowerCase()).toContain("another browser");
  });

  test("[FR-9.3, FR-12.1] a WebGL2 context that fails to initialise falls back without crashing", async () => {
    const gl = new FakeWebGL2({ failCompile: true });
    const context = new Fake2DContext();
    const canvas = canvasWith({ webgl2: gl, "2d": context });

    const selection = await initRenderer(canvas, "webgl2", {
      browserName: "Firefox",
    });

    expect(selection.backend).toBe("canvas2d");
    expect(selection.fallbackNotice?.reason).toBe("webgl2-init-failed");
    expect(selection.fallbackNotice?.message).toContain("Firefox");
    // The half-initialised GPU program was disposed, not leaked.
    expect(gl.drawInstanceCounts).toHaveLength(0);
  });

  test("[FR-9.3] both backends failing rejects with a renderable notice", async () => {
    const canvas = canvasWith({});
    let caught: unknown;
    try {
      await initRenderer(canvas, "webgl2", { browserName: "Chrome" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RendererUnavailableError);
    const notice = (caught as RendererUnavailableError).notice;
    expect(notice.hints.join(" ")).toContain("HDMI");
    expect(notice.message).toContain("Chrome");
  });

  test("[FR-12.1] the browser name is display-only and never decides capabilities", () => {
    expect(
      displayBrowserName({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
      }),
    ).toBe("Chrome");
    expect(
      displayBrowserName({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0",
      }),
    ).toBe("Microsoft Edge");
    expect(displayBrowserName({ userAgent: "" })).toBe("this browser");

    const notice = createFallbackNotice("canvas2d-unavailable", "Safari");
    expect(notice.title).toContain("Cannot draw");
    expect(notice.message).toContain("Safari");
  });
});

// ---------------------------------------------------------------------------
// TV render profile (FR-9.4): DPR 1, 1080p backing store, CSS upscales.
// Actual TV acceptance remains PENDING in docs/RESULTS.md (D1 has desktop
// Chrome only); this test asserts the profile the code applies.
// ---------------------------------------------------------------------------

describe("TV render profile", () => {
  test("[FR-9.4] the backing store is capped at 1080p while CSS keeps the full size", async () => {
    const context = new Fake2DContext();
    const canvas = canvasWith({ "2d": context });
    const renderer = new Canvas2DRenderer({ maxRenderHeight: 1080 });
    await renderer.init(canvas);

    renderer.resize(3840, 2160, 1);

    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
    expect(canvas.style.width).toBe("3840px");
    expect(canvas.style.height).toBe("2160px");
    // Draws happen in CSS pixels; the transform maps them to the backing store.
    expect(context.calls[0]).toBe("setTransform:0.5,0,0,0.5,0,0");

    renderer.resize(1280, 720, 1);
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
    expect(canvas.style.width).toBe("1280px");
  });

  test("[FR-9.4] the cap also applies to WebGL2 and preserves aspect ratio", async () => {
    const gl = new FakeWebGL2();
    const canvas = canvasWith({ webgl2: gl });
    const renderer = new WebGL2Renderer({ maxRenderHeight: 1080 });
    await renderer.init(canvas);

    renderer.resize(2560, 1440, 2);

    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
    expect(canvas.style.width).toBe("2560px");
    expect(canvas.style.height).toBe("1440px");
    expect(gl.viewports.at(-1)).toEqual([0, 0, 1920, 1080]);
  });

  test("[FR-9.4] selecting the TV profile option does not alter the CSS size", async () => {
    const context = new Fake2DContext();
    const canvas = canvasWith({ "2d": context });
    const selection = await initRenderer(canvas, "canvas2d", {
      maxRenderHeight: 1080,
    });

    selection.renderer.resize(3840, 2160, 1);

    expect(canvas.width).toBe(1920);
    expect(canvas.style.width).toBe("3840px");
  });
});

// ---------------------------------------------------------------------------
// Cube demo: fixed simulate + interpolated render through Renderer3D.
// ---------------------------------------------------------------------------

describe("cube demo", () => {
  test("[FR-9.1] render interpolates between the last two fixed-tick states", () => {
    const recorder = new RecordingRenderer3D();
    const demo = new CubeDemo(recorder);

    demo.simulate(DT, snapshotWith(1, 0, 0));
    const simulatedYaw = demo.yaw;
    expect(simulatedYaw).toBeCloseTo(CUBE_DEMO_TURN_RATE * DT, 10);

    demo.render(0.5);
    expect(recorder.rotations.at(-1)).toBeCloseTo(simulatedYaw / 2, 10);
    expect(recorder.frames.at(-1)).toBe(0.5);

    demo.render(0);
    expect(recorder.rotations.at(-1)).toBeCloseTo(0, 10);

    demo.render(1);
    expect(recorder.rotations.at(-1)).toBeCloseTo(simulatedYaw, 10);

    // Alpha is clamped, so a late frame cannot overshoot or rewind.
    demo.render(4);
    expect(recorder.rotations.at(-1)).toBeCloseTo(simulatedYaw, 10);
    demo.render(-2);
    expect(recorder.rotations.at(-1)).toBeCloseTo(0, 10);
  });

  test("[FR-9.1] an A press pulses and cycles the palette once per edge", () => {
    const recorder = new RecordingRenderer3D();
    const demo = new CubeDemo(recorder);
    expect(demo.colorIndex).toBe(0);

    demo.simulate(DT, snapshotWith(0, 0, EDGE_A));
    expect(demo.colorIndex).toBe(1);
    expect(demo.pulse).toBeGreaterThan(0.9);

    demo.render(1);
    expect(recorder.colors.at(-1)).toBe(CUBE_DEMO_COLORS[1]);
    const pulsedSize = recorder.sizes.at(-1) ?? 0;
    expect(pulsedSize).toBeGreaterThan(1);

    // Without another edge the pulse decays and the colour stays put.
    for (let index = 0; index < 60; index += 1) {
      demo.simulate(DT, snapshotWith(0, 0, 0));
    }
    expect(demo.colorIndex).toBe(1);
    expect(demo.pulse).toBe(0);
  });

  test("[PR-9.3] rendering reuses the camera and instance objects every frame", () => {
    const recorder = new RecordingRenderer3D();
    const demo = new CubeDemo(recorder);
    const snapshot = snapshotWith(0.5, 0.25, 0);

    for (let index = 0; index < 120; index += 1) {
      demo.simulate(DT, snapshot);
      demo.render((index % 10) / 10);
    }

    expect(new Set(recorder.origins).size).toBe(1);
    expect(new Set(recorder.cameraPositions).size).toBe(1);
    expect(new Set(recorder.cameraTargets).size).toBe(1);
  });

  test("[PR-9.1] one demo frame issues one draw call, far below the 120 ceiling", async () => {
    const gl = new FakeWebGL2();
    const canvas = canvasWith({ webgl2: gl });
    const renderer = new WebGL2Renderer();
    await renderer.init(canvas);
    renderer.resize(1280, 720, 1);

    const demo = createCubeDemo(renderer);
    demo.init();
    demo.simulate(DT, snapshotWith(1, 0, 0));
    demo.render(0.5);

    expect(renderer.drawCalls).toBe(1);
    expect(renderer.drawCalls).toBeLessThanOrEqual(120);
    expect(gl.drawInstanceCounts).toEqual([1]);
    demo.dispose();
  });

  test("[PR-9.1] the same demo frame draws once on the Canvas2D fallback", async () => {
    const context = new Fake2DContext();
    const canvas = canvasWith({ "2d": context });
    const renderer = new Canvas2DRenderer();
    await renderer.init(canvas);
    renderer.resize(1280, 720, 1);

    const demo = new CubeDemo(renderer);
    demo.init();
    demo.simulate(DT, snapshotWith(0, 1, EDGE_A));
    demo.render(0.5);

    expect(renderer.drawCalls).toBe(1);
    expect(context.calls.some((call) => call.startsWith("fillRect"))).toBe(true);
  });

  test("[E12, FR-9.3, NR-6.2] the renderer backend is swappable behind Renderer3D", async () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/render/CubeDemo.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toContain("WebGL2Renderer");
    expect(source).not.toContain("Canvas2DRenderer");
    expect(source).toContain(
      'import type { GameRenderer3D as Renderer3D } from "@lanpad/sdk";',
    );
    expect(source).not.toContain("document.");
    expect(source).not.toContain("html");

    // Both real backends run the same module unchanged.
    const context = new Fake2DContext();
    const canvas2d = canvasWith({ "2d": context });
    const fallback = await initRenderer(canvas2d, "canvas2d");
    const demo = createCubeDemo(fallback.renderer);
    demo.init();
    demo.simulate(DT, snapshotWith(1, 1, EDGE_A));
    demo.render(0.5);
    expect(fallback.renderer.drawCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Instancing and culling (PR-9.6, PR-9.7)
// ---------------------------------------------------------------------------

async function readyWebGL2(
  options: { maxRenderHeight?: number } = {},
): Promise<{ renderer: WebGL2Renderer; gl: FakeWebGL2; canvas: HTMLCanvasElement }> {
  const gl = new FakeWebGL2();
  const canvas = canvasWith({ webgl2: gl });
  const renderer = new WebGL2Renderer(options);
  await renderer.init(canvas);
  renderer.resize(1280, 720, 1);
  return { renderer, gl, canvas };
}

function cubes(count: number): CubeInstance[] {
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const result: CubeInstance[] = [];
  for (let index = 0; index < count; index += 1) {
    result.push({
      x: ((index % columns) - (columns - 1) / 2) * 0.3,
      y: (Math.floor(index / columns) - (rows - 1) / 2) * 0.3,
      z: 0,
      size: 0.2,
      rotationY: index * 0.1,
      color: "#6ee7ff",
    });
  }
  return result;
}

describe("WebGL2 batching", () => {
  test("[PR-9.6] repeated cubes are packed into one instanced draw call", async () => {
    const { renderer, gl } = await readyWebGL2();
    renderer.setCamera({ x: 0, y: 0, z: 3 }, { x: 0, y: 0, z: 0 });
    renderer.beginFrame(0);

    const batch = cubes(12);
    expect(batch).toHaveLength(12);
    renderer.drawCubes(batch);

    expect(renderer.drawCalls).toBe(1);
    expect(gl.drawInstanceCounts).toEqual([12]);
    expect(INSTANCING_THRESHOLD).toBe(10);
    expect(batch.length).toBeGreaterThan(INSTANCING_THRESHOLD);
  });

  test("[PR-9.6] a 100-cube batch still draws once", async () => {
    const { renderer, gl } = await readyWebGL2();
    renderer.setCamera({ x: 0, y: 0, z: 3 }, { x: 0, y: 0, z: 0 });
    renderer.beginFrame(0);

    renderer.drawCubes(cubes(100));

    expect(renderer.drawCalls).toBe(1);
    expect(gl.drawInstanceCounts).toEqual([100]);
  });

  test("[PR-9.6] a 300-cube batch grows the buffer once and still draws once", async () => {
    const { renderer, gl } = await readyWebGL2();
    renderer.setCamera({ x: 0, y: 0, z: 3 }, { x: 0, y: 0, z: 0 });
    renderer.beginFrame(0);

    const batch: CubeInstance[] = [];
    for (let index = 0; index < 300; index += 1) {
      batch.push({
        x: 0,
        y: 0,
        z: 0,
        size: 0.5,
        rotationY: index * 0.01,
        color: "#ffffff",
      });
    }
    renderer.drawCubes(batch);

    expect(renderer.drawCalls).toBe(1);
    expect(gl.drawInstanceCounts).toEqual([300]);
  });

  test("[PR-9.7] frustum culling rejects cubes behind and beyond the camera", async () => {
    const { renderer, gl } = await readyWebGL2();
    renderer.setCamera({ x: 0, y: 0, z: 3 }, { x: 0, y: 0, z: 0 });
    renderer.beginFrame(0);

    renderer.drawCube({ x: 0, y: 0, z: 0 }, 1, "#ffffff", 0);
    expect(renderer.drawCalls).toBe(1);
    expect(renderer.culledCubes).toBe(0);
    expect(gl.drawInstanceCounts).toEqual([1]);

    renderer.drawCube({ x: 0, y: 0, z: 1000 }, 1, "#ffffff", 0);
    expect(renderer.drawCalls).toBe(1);
    expect(renderer.culledCubes).toBe(1);

    renderer.drawCube({ x: 0, y: 0, z: -500 }, 1, "#ffffff", 0);
    expect(renderer.drawCalls).toBe(1);
    expect(renderer.culledCubes).toBe(2);

    // A batch culls individual instances before packing the survivors.
    renderer.beginFrame(0);
    const batch: CubeInstance[] = [
      { x: 0, y: 0, z: 0, size: 1, rotationY: 0, color: "#ffffff" },
      { x: 0.5, y: 0, z: 0, size: 1, rotationY: 0, color: "#ffffff" },
      { x: 0, y: 0, z: 1000, size: 1, rotationY: 0, color: "#ffffff" },
    ];
    renderer.drawCubes(batch);

    expect(renderer.drawCalls).toBe(1);
    expect(renderer.culledCubes).toBe(1);
    // The fake collects GPU draw history, so the batch's 2 instances are the
    // last entry; the earlier single-cube draw is still in the list.
    expect(gl.drawInstanceCounts.at(-1)).toBe(2);
    expect(gl.drawInstanceCounts).toHaveLength(2);
  });

  test("[PR-9.7] a fully culled batch issues no draw call at all", async () => {
    const { renderer, gl } = await readyWebGL2();
    renderer.setCamera({ x: 0, y: 0, z: 3 }, { x: 0, y: 0, z: 0 });
    renderer.beginFrame(0);

    renderer.drawCubes([
      { x: 0, y: 0, z: 1000, size: 1, rotationY: 0, color: "#ffffff" },
      { x: 0, y: 0, z: 2000, size: 1, rotationY: 0, color: "#ffffff" },
    ]);

    expect(renderer.drawCalls).toBe(0);
    expect(renderer.culledCubes).toBe(2);
    expect(gl.drawInstanceCounts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// NR-6.2: no virtual DOM, no framework in the render path.
// ---------------------------------------------------------------------------

describe("runtime rendering stack", () => {
  test("[NR-6.2] render modules import no virtual-DOM framework", () => {
    const renderDir = fileURLToPath(
      new URL("../src/render/", import.meta.url),
    );
    const files = readdirSync(renderDir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    const forbidden =
      /from\s+["'](?:react|react-dom|vue|svelte|preact|solid-js|lit|@angular\/[^"']+)["']/;
    const loopFiles = new Set([
      "CubeDemo.ts",
      "Canvas2DRenderer.ts",
      "WebGL2Renderer.ts",
    ]);

    for (const file of files) {
      const source = readFileSync(join(renderDir, file), "utf8");
      expect(source, `${file} imports a virtual-DOM framework`).not.toMatch(
        forbidden,
      );
      if (loopFiles.has(file)) {
        // Per-frame DOM creation would also fail `[NR-6.2]`; renderers only
        // draw through the injected context.
        expect(source, `${file} touches the DOM`).not.toContain(
          "document.createElement",
        );
        expect(source, `${file} touches the DOM`).not.toContain("innerHTML");
      }
    }

    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { dependencies?: Record<string, string> };
    const dependencyNames = Object.keys(pkg.dependencies ?? {});
    expect(dependencyNames.sort()).toEqual(["@lanpad/protocol", "@lanpad/sdk"]);
    for (const name of dependencyNames) {
      expect(name.startsWith("react")).toBe(false);
      expect(name.startsWith("vue")).toBe(false);
    }
  });
});
