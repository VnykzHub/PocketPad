/**
 * Hand-written WebGL2 + canvas fakes for the Node test project (05 §7).
 *
 * The fake is a recorder, not a WebGL implementation: it assigns stable
 * numeric constants, returns distinct opaque objects, and records every method
 * call in order. Tests assert call order/state and handle validation. Real GL
 * behaviour (pixel output, frame time, context loss on hardware) stays
 * `PENDING`; this file cannot produce that evidence.
 */

export interface GlCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

const CONSTANT_BY_NAME = new Map<string, number>();
const NAME_BY_CONSTANT = new Map<number, string>();
let nextConstant = 0x10000;

/** Stable pseudo-GL constant per enum name (WebGL names are unique strings). */
export function glConstant(name: string): number {
  const existing = CONSTANT_BY_NAME.get(name);
  if (existing !== undefined) return existing;
  const value = nextConstant;
  nextConstant += 1;
  CONSTANT_BY_NAME.set(name, value);
  NAME_BY_CONSTANT.set(value, name);
  return value;
}

interface LoseContextExtension {
  loseContext(): void;
  restoreContext(): void;
}

export class FakeWebGL2 {
  readonly calls: GlCall[] = [];
  readonly extensionObjects = new Map<string, Record<string, unknown>>();
  readonly INVALID_INDEX = 0xffffffff;
  extensions: string[] = [];
  shaderCompiles = true;
  programLinks = true;
  contextLost = false;
  restoreRequested = false;

  private readonly parameters = new Map<string, number | string>();
  private readonly shaderSources = new Map<unknown, string>();
  private nextObjectId = 1;

  constructor() {
    const numeric: ReadonlyArray<readonly [string, number]> = [
      ["MAX_TEXTURE_SIZE", 4096],
      ["MAX_CUBE_MAP_TEXTURE_SIZE", 4096],
      ["MAX_3D_TEXTURE_SIZE", 256],
      ["MAX_ARRAY_TEXTURE_LAYERS", 256],
      ["MAX_TEXTURE_IMAGE_UNITS", 16],
      ["MAX_VERTEX_TEXTURE_IMAGE_UNITS", 16],
      ["MAX_COMBINED_TEXTURE_IMAGE_UNITS", 32],
      ["MAX_VERTEX_ATTRIBS", 16],
      ["MAX_UNIFORM_BUFFER_BINDINGS", 16],
      ["MAX_UNIFORM_BLOCK_SIZE", 16384],
      ["MAX_DRAW_BUFFERS", 4],
      ["MAX_COLOR_ATTACHMENTS", 4],
      ["MAX_SAMPLES", 1],
    ];
    for (const [name, value] of numeric) {
      this.setParameter(name, value);
    }
    this.setParameter("VENDOR", "Fake Vendor");
    this.setParameter("RENDERER", "Fake GL Renderer");
    this.setParameter("VERSION", "WebGL 2.0 (fake)");
    this.setParameter("SHADING_LANGUAGE_VERSION", "WebGL GLSL ES 3.00 (fake)");
  }

  setParameter(name: string, value: number | string): void {
    glConstant(name);
    this.parameters.set(name, value);
  }

  /** Registers an extension object and makes `getSupportedExtensions` list it. */
  addExtension(name: string, object: Record<string, unknown> = {}): void {
    if (!this.extensions.includes(name)) this.extensions.push(name);
    this.extensionObjects.set(name, object);
  }

  clearCalls(): void {
    this.calls.length = 0;
  }

  count(name: string): number {
    let total = 0;
    for (const call of this.calls) {
      if (call.name === name) total += 1;
    }
    return total;
  }

  callsNamed(name: string): readonly GlCall[] {
    return this.calls.filter((call) => call.name === name);
  }

  lastCall(name: string): GlCall | undefined {
    for (let index = this.calls.length - 1; index >= 0; index -= 1) {
      const call = this.calls[index];
      if (call !== undefined && call.name === name) return call;
    }
    return undefined;
  }

  private record(name: string, args: readonly unknown[]): void {
    this.calls.push({ name, args });
  }

  private makeObject(kind: string): Record<string, unknown> {
    const object: Record<string, unknown> = { kind, id: this.nextObjectId };
    this.nextObjectId += 1;
    return object;
  }

  getParameter(name: number): unknown {
    this.record("getParameter", [name]);
    const key = NAME_BY_CONSTANT.get(name);
    if (key === undefined) return 0;
    return this.parameters.get(key) ?? 0;
  }

  getSupportedExtensions(): string[] {
    this.record("getSupportedExtensions", []);
    return [...this.extensions];
  }

  getExtension(name: string): unknown {
    this.record("getExtension", [name]);
    if (name === "WEBGL_lose_context") {
      const extension: LoseContextExtension = {
        loseContext: () => {
          this.contextLost = true;
        },
        restoreContext: () => {
          this.restoreRequested = true;
          this.contextLost = false;
        },
      };
      return extension;
    }
    return this.extensionObjects.get(name) ?? null;
  }

  isContextLost(): boolean {
    this.record("isContextLost", []);
    return this.contextLost;
  }

  getError(): number {
    this.record("getError", []);
    return 0;
  }

  createShader(type: number): unknown {
    this.record("createShader", [type]);
    const shader = this.makeObject("shader");
    this.shaderSources.set(shader, "");
    return shader;
  }

  shaderSource(shader: unknown, source: string): void {
    this.record("shaderSource", [shader, source]);
    this.shaderSources.set(shader, source);
  }

  compileShader(shader: unknown): void {
    this.record("compileShader", [shader]);
  }

  getShaderParameter(shader: unknown, pname: number): unknown {
    this.record("getShaderParameter", [shader, pname]);
    return this.shaderCompiles;
  }

  getShaderInfoLog(shader: unknown): string {
    this.record("getShaderInfoLog", [shader]);
    return "";
  }

  deleteShader(shader: unknown): void {
    this.record("deleteShader", [shader]);
    this.shaderSources.delete(shader);
  }

  getShaderSource(shader: unknown): string | undefined {
    return this.shaderSources.get(shader);
  }

  createProgram(): unknown {
    this.record("createProgram", []);
    return this.makeObject("program");
  }

  attachShader(program: unknown, shader: unknown): void {
    this.record("attachShader", [program, shader]);
  }

  linkProgram(program: unknown): void {
    this.record("linkProgram", [program]);
  }

  getProgramParameter(program: unknown, pname: number): unknown {
    this.record("getProgramParameter", [program, pname]);
    return this.programLinks;
  }

  getProgramInfoLog(program: unknown): string {
    this.record("getProgramInfoLog", [program]);
    return "";
  }

  deleteProgram(program: unknown): void {
    this.record("deleteProgram", [program]);
  }

  getUniformLocation(program: unknown, name: string): unknown {
    this.record("getUniformLocation", [program, name]);
    return this.makeObject(`uniform:${name}`);
  }

  getUniformBlockIndex(program: unknown, blockName: string): number {
    this.record("getUniformBlockIndex", [program, blockName]);
    if (blockName === "FrameBlock") return 0;
    if (blockName === "MaterialBlock") return 1;
    return this.INVALID_INDEX;
  }

  uniformBlockBinding(program: unknown, blockIndex: number, binding: number): void {
    this.record("uniformBlockBinding", [program, blockIndex, binding]);
  }

  useProgram(program: unknown): void {
    this.record("useProgram", [program]);
  }

  createBuffer(): unknown {
    this.record("createBuffer", []);
    return this.makeObject("buffer");
  }

  bindBuffer(target: number, buffer: unknown): void {
    this.record("bindBuffer", [target, buffer]);
  }

  bufferData(...args: unknown[]): void {
    this.record("bufferData", args);
  }

  bufferSubData(...args: unknown[]): void {
    this.record("bufferSubData", args);
  }

  deleteBuffer(buffer: unknown): void {
    this.record("deleteBuffer", [buffer]);
  }

  bindBufferBase(target: number, index: number, buffer: unknown): void {
    this.record("bindBufferBase", [target, index, buffer]);
  }

  createVertexArray(): unknown {
    this.record("createVertexArray", []);
    return this.makeObject("vertexArray");
  }

  bindVertexArray(vao: unknown): void {
    this.record("bindVertexArray", [vao]);
  }

  deleteVertexArray(vao: unknown): void {
    this.record("deleteVertexArray", [vao]);
  }

  enableVertexAttribArray(index: number): void {
    this.record("enableVertexAttribArray", [index]);
  }

  vertexAttribPointer(
    index: number,
    size: number,
    type: number,
    normalized: boolean,
    stride: number,
    offset: number,
  ): void {
    this.record("vertexAttribPointer", [index, size, type, normalized, stride, offset]);
  }

  vertexAttribDivisor(index: number, divisor: number): void {
    this.record("vertexAttribDivisor", [index, divisor]);
  }

  createTexture(): unknown {
    this.record("createTexture", []);
    return this.makeObject("texture");
  }

  activeTexture(unit: number): void {
    this.record("activeTexture", [unit]);
  }

  bindTexture(target: number, texture: unknown): void {
    this.record("bindTexture", [target, texture]);
  }

  deleteTexture(texture: unknown): void {
    this.record("deleteTexture", [texture]);
  }

  texStorage2D(
    target: number,
    levels: number,
    internalFormat: number,
    width: number,
    height: number,
  ): void {
    this.record("texStorage2D", [target, levels, internalFormat, width, height]);
  }

  texSubImage2D(...args: unknown[]): void {
    this.record("texSubImage2D", args);
  }

  compressedTexSubImage2D(...args: unknown[]): void {
    this.record("compressedTexSubImage2D", args);
  }

  pixelStorei(pname: number, param: number): void {
    this.record("pixelStorei", [pname, param]);
  }

  createSampler(): unknown {
    this.record("createSampler", []);
    return this.makeObject("sampler");
  }

  samplerParameteri(sampler: unknown, pname: number, param: number): void {
    this.record("samplerParameteri", [sampler, pname, param]);
  }

  samplerParameterf(sampler: unknown, pname: number, param: number): void {
    this.record("samplerParameterf", [sampler, pname, param]);
  }

  bindSampler(unit: number, sampler: unknown): void {
    this.record("bindSampler", [unit, sampler]);
  }

  deleteSampler(sampler: unknown): void {
    this.record("deleteSampler", [sampler]);
  }

  viewport(x: number, y: number, width: number, height: number): void {
    this.record("viewport", [x, y, width, height]);
  }

  clearColor(r: number, g: number, b: number, a: number): void {
    this.record("clearColor", [r, g, b, a]);
  }

  clear(mask: number): void {
    this.record("clear", [mask]);
  }

  enable(capability: number): void {
    this.record("enable", [capability]);
  }

  disable(capability: number): void {
    this.record("disable", [capability]);
  }

  depthFunc(func: number): void {
    this.record("depthFunc", [func]);
  }

  depthMask(flag: boolean): void {
    this.record("depthMask", [flag]);
  }

  cullFace(mode: number): void {
    this.record("cullFace", [mode]);
  }

  frontFace(mode: number): void {
    this.record("frontFace", [mode]);
  }

  blendFuncSeparate(
    srcRGB: number,
    dstRGB: number,
    srcAlpha: number,
    dstAlpha: number,
  ): void {
    this.record("blendFuncSeparate", [srcRGB, dstRGB, srcAlpha, dstAlpha]);
  }

  blendEquation(mode: number): void {
    this.record("blendEquation", [mode]);
  }

  uniformMatrix4fv(...args: unknown[]): void {
    this.record("uniformMatrix4fv", args);
  }

  drawArrays(...args: unknown[]): void {
    this.record("drawArrays", args);
  }

  drawElements(...args: unknown[]): void {
    this.record("drawElements", args);
  }

  drawArraysInstanced(...args: unknown[]): void {
    this.record("drawArraysInstanced", args);
  }

  drawElementsInstanced(...args: unknown[]): void {
    this.record("drawElementsInstanced", args);
  }
}

export interface FakeWebGL2Bundle {
  readonly gl: WebGL2RenderingContext;
  readonly fake: FakeWebGL2;
}

/**
 * Wraps the recorder in a Proxy. Uppercase enum names resolve to stable
 * constants on demand, so the fake never needs a hand-maintained enum table.
 */
export function createFakeWebGL2(): FakeWebGL2Bundle {
  const fake = new FakeWebGL2();
  const gl = new Proxy(fake, {
    get(target, property) {
      if (typeof property !== "string") {
        return Reflect.get(target, property) as unknown;
      }
      const value = Reflect.get(target, property) as unknown;
      if (typeof value === "function") {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      if (value !== undefined) return value;
      if (/^[A-Z][A-Z0-9_]*$/.test(property)) return glConstant(property);
      return undefined;
    },
  });
  return { gl: gl as unknown as WebGL2RenderingContext, fake };
}

type CanvasListener = (event: unknown) => void;

export interface FakeCanvasOptions {
  readonly width?: number;
  readonly height?: number;
  readonly clientWidth?: number;
  readonly clientHeight?: number;
}

/** Canvas recorder: one context per type, listener dispatch, size bookkeeping. */
export class FakeCanvas {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  readonly style = { width: "", height: "" };
  readonly getContextCalls: Array<{ readonly type: string; readonly attributes: unknown }> = [];
  contextThrows = false;

  private readonly contexts = new Map<string, unknown>();
  private readonly listeners = new Map<string, Set<CanvasListener>>();

  constructor(options: FakeCanvasOptions = {}) {
    this.width = options.width ?? 0;
    this.height = options.height ?? 0;
    this.clientWidth = options.clientWidth ?? 640;
    this.clientHeight = options.clientHeight ?? 360;
  }

  registerContext(type: string, context: unknown): void {
    this.contexts.set(type, context);
  }

  getContext(type: string, attributes?: unknown): unknown {
    this.getContextCalls.push({ type, attributes });
    if (this.contextThrows) throw new Error("fake getContext failure");
    return this.contexts.get(type) ?? null;
  }

  addEventListener(type: string, listener: CanvasListener): void {
    let listeners = this.listeners.get(type);
    if (listeners === undefined) {
      listeners = new Set<CanvasListener>();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: CanvasListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  dispatch(type: string, event: unknown = {}): void {
    const listeners = this.listeners.get(type);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) listener(event);
  }

  asCanvas(): HTMLCanvasElement {
    return this as unknown as HTMLCanvasElement;
  }
}

export interface Fake2DCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

/** Minimal CanvasRenderingContext2D recorder for the 2D entry tests. */
export class Fake2DContext {
  readonly calls: Fake2DCall[] = [];
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 1;
  font = "";
  textAlign = "start";

  private record(name: string, args: readonly unknown[]): void {
    this.calls.push({ name, args });
  }

  count(name: string): number {
    let total = 0;
    for (const call of this.calls) {
      if (call.name === name) total += 1;
    }
    return total;
  }

  lastCall(name: string): Fake2DCall | undefined {
    for (let index = this.calls.length - 1; index >= 0; index -= 1) {
      const call = this.calls[index];
      if (call !== undefined && call.name === name) return call;
    }
    return undefined;
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.record("setTransform", [a, b, c, d, e, f]);
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.record("fillRect", [x, y, width, height]);
  }

  beginPath(): void {
    this.record("beginPath", []);
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void {
    this.record("arc", [x, y, radius, startAngle, endAngle]);
  }

  fill(): void {
    this.record("fill", []);
  }

  moveTo(x: number, y: number): void {
    this.record("moveTo", [x, y]);
  }

  lineTo(x: number, y: number): void {
    this.record("lineTo", [x, y]);
  }

  stroke(): void {
    this.record("stroke", []);
  }

  fillText(text: string, x: number, y: number): void {
    this.record("fillText", [text, x, y]);
  }
}

export interface Fake2DContextBundle {
  readonly ctx: CanvasRenderingContext2D;
  readonly fake: Fake2DContext;
}

export function createFake2DContext(): Fake2DContextBundle {
  const fake = new Fake2DContext();
  return { ctx: fake as unknown as CanvasRenderingContext2D, fake };
}
