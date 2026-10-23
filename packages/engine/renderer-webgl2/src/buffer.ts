/**
 * Buffers and the frame uniform ring (05 §4.5, §5.1).
 *
 * `BufferDesc` and `PipelineDesc` are opaque in the frozen core contract
 * (00 §3.2 W0 ambiguity). This module reads a documented additive subset and
 * rejects a descriptor that lacks it with `E_CONTRACT`; it never guesses.
 */

import type { BufferDesc } from "@lanpad/engine-core";
import { rendererError } from "./errors.js";
import type { StateCache } from "./state.js";
import { FRAME_UBO_BYTES } from "./shaders/forwardLit.js";

export type BufferTarget = "vertex" | "uniform" | "index";
export type BufferUsage = "static" | "dynamic";

/** Additive descriptor subset the WebGL2 backend accepts. */
export interface WebGL2BufferDesc {
  readonly label?: string;
  readonly size: number;
  readonly usage?: BufferUsage;
  readonly target?: BufferTarget;
  readonly data?: ArrayBufferView;
}

export interface BufferGpuRecord {
  readonly buffer: WebGLBuffer;
  readonly target: BufferTarget;
  readonly byteLength: number;
  readonly usage: BufferUsage;
  readonly desc: WebGL2BufferDesc;
}

export function readBufferDesc(desc: BufferDesc): WebGL2BufferDesc {
  const size = desc["size"];
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
    throw rendererError(
      "E_CONTRACT",
      "BufferDesc.size must be a positive integer byte count.",
    );
  }
  const targetValue = desc["target"];
  const target: BufferTarget = targetValue === undefined ? "vertex" : readTarget(targetValue);
  const usageValue = desc["usage"];
  const usage: BufferUsage =
    usageValue === undefined ? "static" : usageValue === "dynamic" ? "dynamic" : "static";
  const data = desc["data"];
  if (data !== undefined && !ArrayBuffer.isView(data)) {
    throw rendererError("E_CONTRACT", "BufferDesc.data must be an ArrayBufferView.");
  }
  const view = data as ArrayBufferView | undefined;
  if (view !== undefined && view.byteLength > size) {
    throw rendererError(
      "E_CONTRACT",
      "BufferDesc.data is larger than the declared buffer size.",
    );
  }
  return { size, target, usage, ...(view === undefined ? {} : { data: view }) };
}

function readTarget(value: unknown): BufferTarget {
  if (value === "vertex" || value === "uniform" || value === "index") return value;
  throw rendererError(
    "E_CONTRACT",
    'BufferDesc.target must be "vertex", "uniform" or "index".',
  );
}

function glTarget(gl: WebGL2RenderingContext, target: BufferTarget): number {
  if (target === "index") return gl.ELEMENT_ARRAY_BUFFER;
  if (target === "uniform") return gl.UNIFORM_BUFFER;
  return gl.ARRAY_BUFFER;
}

function bindFor(
  state: StateCache,
  target: BufferTarget,
  buffer: WebGLBuffer | null,
): void {
  if (target === "index") state.bindElementBuffer(buffer);
  else state.bindArrayBuffer(buffer);
}

export function createBufferGpu(
  gl: WebGL2RenderingContext,
  state: StateCache,
  desc: WebGL2BufferDesc,
  maxBufferSize: number,
): BufferGpuRecord {
  if (desc.size > maxBufferSize) {
    throw rendererError("E_CONTRACT", "BufferDesc.size exceeds maxBufferSize.");
  }
  const buffer = gl.createBuffer();
  if (buffer === null) {
    throw rendererError("E_BACKEND_INIT", "Could not allocate a GPU buffer.");
  }
  const target = glTarget(gl, desc.target ?? "vertex");
  // A direct bind is safe: the frame ring rebinds its own slot each frame.
  if ((desc.target ?? "vertex") === "uniform") {
    gl.bindBuffer(gl.UNIFORM_BUFFER, buffer);
  } else {
    bindFor(state, desc.target ?? "vertex", buffer);
  }
  const drawUsage = desc.usage === "dynamic" ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW;
  if (desc.data === undefined) {
    gl.bufferData(target, desc.size, drawUsage);
  } else {
    gl.bufferData(target, desc.data, drawUsage);
  }
  return {
    buffer,
    target: desc.target ?? "vertex",
    byteLength: desc.size,
    usage: desc.usage ?? "static",
    desc,
  };
}

export function writeBufferGpu(
  gl: WebGL2RenderingContext,
  state: StateCache,
  record: BufferGpuRecord,
  offset: number,
  data: ArrayBufferView,
): void {
  if (offset < 0 || offset + data.byteLength > record.byteLength) {
    throw rendererError("E_CONTRACT", "writeBuffer range exceeds the buffer size.");
  }
  if (record.target === "uniform") {
    gl.bindBuffer(gl.UNIFORM_BUFFER, record.buffer);
  } else {
    bindFor(state, record.target, record.buffer);
  }
  gl.bufferSubData(glTarget(gl, record.target), offset, data);
}

export function deleteBufferGpu(gl: WebGL2RenderingContext, record: BufferGpuRecord): void {
  gl.deleteBuffer(record.buffer);
}

/** Three-slot frame UBO ring (`frameIndex % 3`, 05 §5.3). */
export class FrameUniformRing {
  private readonly gl: WebGL2RenderingContext;
  private readonly state: StateCache;
  private readonly buffers: WebGLBuffer[] = [];
  private readonly scratch: Float32Array;
  private currentSlot = -1;

  constructor(gl: WebGL2RenderingContext, state: StateCache) {
    this.gl = gl;
    this.state = state;
    this.scratch = new Float32Array(FRAME_UBO_BYTES / 4);
    for (let slot = 0; slot < 3; slot += 1) {
      const buffer = gl.createBuffer();
      if (buffer === null) {
        throw rendererError("E_BACKEND_INIT", "Could not allocate the frame UBO ring.");
      }
      gl.bindBuffer(gl.UNIFORM_BUFFER, buffer);
      gl.bufferData(gl.UNIFORM_BUFFER, FRAME_UBO_BYTES, gl.DYNAMIC_DRAW);
      this.buffers.push(buffer);
    }
  }

  /** Binds slot `frameIndex % 3` at UBO binding 0. */
  begin(slotIndex: number): void {
    const slot = ((slotIndex % 3) + 3) % 3;
    this.currentSlot = slot;
    const buffer = this.buffers[slot];
    if (buffer === undefined) return;
    this.state.bindBufferBase(0, this.gl.UNIFORM_BUFFER, buffer);
  }

  get current(): number {
    return this.currentSlot;
  }

  /** Returns the shared scratch record; call `commit` after filling it. */
  data(): Float32Array {
    return this.scratch;
  }

  commit(): void {
    const buffer = this.buffers[this.currentSlot];
    if (buffer === undefined) return;
    this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, buffer);
    this.gl.bufferSubData(this.gl.UNIFORM_BUFFER, 0, this.scratch);
  }

  destroy(): void {
    for (let index = 0; index < this.buffers.length; index += 1) {
      const buffer = this.buffers[index];
      if (buffer !== undefined) this.gl.deleteBuffer(buffer);
    }
    this.buffers.length = 0;
    this.currentSlot = -1;
  }
}
