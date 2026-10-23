/**
 * Shadow GL state cache (05 §5.8).
 *
 * Every setter compares against the last value this backend wrote. The cache
 * never reads GL state: a `getParameter` in the frame path is a stall. After
 * context restoration `reset()` marks every slot unknown so the next setter
 * re-issues its call.
 */

const TEXTURE_UNIT_COUNT = 32;
const UBO_BINDING_COUNT = 32;

interface TextureUnitState {
  target: number | undefined;
  texture: WebGLTexture | null | undefined;
  sampler: WebGLSampler | null | undefined;
}

export class StateCache {
  private readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram | null | undefined;
  private vao: WebGLVertexArrayObject | null | undefined;
  private arrayBuffer: WebGLBuffer | null | undefined;
  private elementBuffer: WebGLBuffer | null | undefined;
  private activeUnit = -1;
  private readonly units: TextureUnitState[] = [];
  private readonly uboBindings: Array<WebGLBuffer | null | undefined> = [];
  private blendEnabled: boolean | undefined;
  private blendSrcRGB: number | undefined;
  private blendDstRGB: number | undefined;
  private blendSrcAlpha: number | undefined;
  private blendDstAlpha: number | undefined;
  private blendEquation: number | undefined;
  private depthTest: boolean | undefined;
  private depthFunc: number | undefined;
  private depthWrite: boolean | undefined;
  private cullEnabled: boolean | undefined;
  private cullFace: number | undefined;
  private frontFaceMode: number | undefined;
  private viewportX: number | undefined;
  private viewportY: number | undefined;
  private viewportW: number | undefined;
  private viewportH: number | undefined;
  private clearR: number | undefined;
  private clearG: number | undefined;
  private clearB: number | undefined;
  private clearA: number | undefined;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    for (let unit = 0; unit < TEXTURE_UNIT_COUNT; unit += 1) {
      this.units.push({ target: undefined, texture: undefined, sampler: undefined });
    }
    for (let index = 0; index < UBO_BINDING_COUNT; index += 1) {
      this.uboBindings.push(undefined);
    }
    this.reset();
  }

  /** Marks every slot unknown; the next setter always calls GL. */
  reset(): void {
    this.program = undefined;
    this.vao = undefined;
    this.arrayBuffer = undefined;
    this.elementBuffer = undefined;
    this.activeUnit = -1;
    for (let unit = 0; unit < this.units.length; unit += 1) {
      const state = this.units[unit];
      if (state === undefined) continue;
      state.target = undefined;
      state.texture = undefined;
      state.sampler = undefined;
    }
    for (let index = 0; index < this.uboBindings.length; index += 1) {
      this.uboBindings[index] = undefined;
    }
    this.blendEnabled = undefined;
    this.blendSrcRGB = undefined;
    this.blendDstRGB = undefined;
    this.blendSrcAlpha = undefined;
    this.blendDstAlpha = undefined;
    this.blendEquation = undefined;
    this.depthTest = undefined;
    this.depthFunc = undefined;
    this.depthWrite = undefined;
    this.cullEnabled = undefined;
    this.cullFace = undefined;
    this.frontFaceMode = undefined;
    this.viewportX = undefined;
    this.viewportY = undefined;
    this.viewportW = undefined;
    this.viewportH = undefined;
    this.clearR = undefined;
    this.clearG = undefined;
    this.clearB = undefined;
    this.clearA = undefined;
  }

  useProgram(program: WebGLProgram | null): void {
    if (this.program === program) return;
    this.program = program;
    this.gl.useProgram(program);
  }

  bindVertexArray(vao: WebGLVertexArrayObject | null): void {
    if (this.vao === vao) return;
    this.vao = vao;
    this.gl.bindVertexArray(vao);
  }

  bindArrayBuffer(buffer: WebGLBuffer | null): void {
    if (this.arrayBuffer === buffer) return;
    this.arrayBuffer = buffer;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
  }

  bindElementBuffer(buffer: WebGLBuffer | null): void {
    if (this.elementBuffer === buffer) return;
    this.elementBuffer = buffer;
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, buffer);
  }

  bindBufferBase(index: number, target: number, buffer: WebGLBuffer | null): void {
    if (index < 0 || index >= this.uboBindings.length) return;
    if (this.uboBindings[index] === buffer) return;
    this.uboBindings[index] = buffer;
    this.gl.bindBufferBase(target, index, buffer);
  }

  bindTexture(unit: number, target: number, texture: WebGLTexture | null): void {
    if (unit < 0 || unit >= this.units.length) return;
    if (this.activeUnit !== unit) {
      this.gl.activeTexture(this.gl.TEXTURE0 + unit);
      this.activeUnit = unit;
    }
    const state = this.units[unit];
    if (state === undefined) return;
    if (state.target === target && state.texture === texture) return;
    state.target = target;
    state.texture = texture;
    this.gl.bindTexture(target, texture);
  }

  bindSampler(unit: number, sampler: WebGLSampler | null): void {
    if (unit < 0 || unit >= this.units.length) return;
    const state = this.units[unit];
    if (state === undefined || state.sampler === sampler) return;
    state.sampler = sampler;
    this.gl.bindSampler(unit, sampler);
  }

  setBlend(
    enabled: boolean,
    srcRGB: number,
    dstRGB: number,
    srcAlpha: number,
    dstAlpha: number,
    equation: number,
  ): void {
    if (this.blendEnabled !== enabled) {
      this.blendEnabled = enabled;
      if (enabled) this.gl.enable(this.gl.BLEND);
      else this.gl.disable(this.gl.BLEND);
    }
    if (
      this.blendSrcRGB === srcRGB &&
      this.blendDstRGB === dstRGB &&
      this.blendSrcAlpha === srcAlpha &&
      this.blendDstAlpha === dstAlpha
    ) {
      return;
    }
    this.blendSrcRGB = srcRGB;
    this.blendDstRGB = dstRGB;
    this.blendSrcAlpha = srcAlpha;
    this.blendDstAlpha = dstAlpha;
    this.gl.blendFuncSeparate(srcRGB, dstRGB, srcAlpha, dstAlpha);
    if (this.blendEquation !== equation) {
      this.blendEquation = equation;
      this.gl.blendEquation(equation);
    }
  }

  setDepth(test: boolean, func: number, write: boolean): void {
    if (this.depthTest !== test) {
      this.depthTest = test;
      if (test) this.gl.enable(this.gl.DEPTH_TEST);
      else this.gl.disable(this.gl.DEPTH_TEST);
    }
    if (this.depthFunc !== func) {
      this.depthFunc = func;
      this.gl.depthFunc(func);
    }
    if (this.depthWrite !== write) {
      this.depthWrite = write;
      this.gl.depthMask(write);
    }
  }

  setCull(enabled: boolean, face: number): void {
    if (this.cullEnabled !== enabled) {
      this.cullEnabled = enabled;
      if (enabled) this.gl.enable(this.gl.CULL_FACE);
      else this.gl.disable(this.gl.CULL_FACE);
    }
    if (this.cullFace !== face) {
      this.cullFace = face;
      this.gl.cullFace(face);
    }
  }

  setFrontFace(mode: number): void {
    if (this.frontFaceMode === mode) return;
    this.frontFaceMode = mode;
    this.gl.frontFace(mode);
  }

  setViewport(x: number, y: number, width: number, height: number): void {
    if (
      this.viewportX === x &&
      this.viewportY === y &&
      this.viewportW === width &&
      this.viewportH === height
    ) {
      return;
    }
    this.viewportX = x;
    this.viewportY = y;
    this.viewportW = width;
    this.viewportH = height;
    this.gl.viewport(x, y, width, height);
  }

  setClearColor(r: number, g: number, b: number, a: number): void {
    if (this.clearR === r && this.clearG === g && this.clearB === b && this.clearA === a) {
      return;
    }
    this.clearR = r;
    this.clearG = g;
    this.clearB = b;
    this.clearA = a;
    this.gl.clearColor(r, g, b, a);
  }
}
