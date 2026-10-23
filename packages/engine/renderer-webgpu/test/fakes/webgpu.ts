/**
 * Hand-written WebGPU fakes for Node tests (04 §8).
 *
 * These record call order and never touch a real GPU. They are intentionally
 * small: only the members this backend actually calls are implemented, and
 * every cast to a `GPU*` type happens at this boundary. No test may claim
 * hardware evidence from this harness.
 */

import type { DeviceLimits } from "@lanpad/engine-core";
import type { WebGpuDeviceOptions } from "../../src/contracts/webgpu.js";
import {
  capabilitiesFromAdapter,
  deviceLimits,
  normalizeOptions,
} from "../../src/device/capabilities.js";
import type { WebGpuDeviceDependencies } from "../../src/device/WebGpuDevice.js";

export interface FakeLimits extends Record<string, number> {
  readonly maxTextureDimension2D: number;
  readonly maxTextureArrayLayers: number;
  readonly maxBindGroups: number;
  readonly maxUniformBufferBindingSize: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxBufferSize: number;
  readonly maxVertexBuffers: number;
  readonly maxColorAttachments: number;
  readonly maxSamplerAnisotropy: number;
  readonly minUniformBufferOffsetAlignment: number;
  readonly maxComputeWorkgroupSizeX: number;
}

export function fakeLimits(overrides: Partial<FakeLimits> = {}): FakeLimits {
  return {
    maxTextureDimension2D: 8192,
    maxTextureArrayLayers: 256,
    maxBindGroups: 4,
    maxUniformBufferBindingSize: 65_536,
    maxStorageBufferBindingSize: 134_217_728,
    maxBufferSize: 268_435_456,
    maxVertexBuffers: 8,
    maxColorAttachments: 8,
    maxSamplerAnisotropy: 16,
    minUniformBufferOffsetAlignment: 256,
    maxComputeWorkgroupSizeX: 256,
    ...overrides,
  };
}

export class FakeBuffer {
  destroyed = false;

  constructor(
    readonly label: string,
    readonly size: number,
    readonly usage: number,
  ) {}

  destroy(): void {
    this.destroyed = true;
  }
}

export class FakeTextureView {
  constructor(
    readonly texture: FakeTexture,
    readonly desc: unknown,
  ) {}
}

export class FakeTexture {
  destroyed = false;
  readonly views: FakeTextureView[] = [];

  constructor(
    readonly label: string,
    readonly desc: Record<string, unknown>,
  ) {}

  createView(desc?: unknown): FakeTextureView {
    const view = new FakeTextureView(this, desc);
    this.views.push(view);
    return view;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

export class FakeSampler {
  constructor(
    readonly label: string,
    readonly desc: unknown,
  ) {}
}

export class FakeShaderModule {
  constructor(
    readonly label: string,
    readonly code: string,
  ) {}
}

export class FakeRenderPipeline {
  constructor(
    readonly label: string,
    readonly desc: unknown,
  ) {}
}

export class FakeBindGroupLayout {
  constructor(
    readonly label: string,
    readonly entries: unknown,
  ) {}
}

export class FakePipelineLayout {
  constructor(
    readonly label: string,
    readonly bindGroupLayouts: readonly unknown[],
  ) {}
}

export class FakeBindGroup {
  constructor(
    readonly label: string,
    readonly entries: unknown,
  ) {}
}

export interface WriteBufferCall {
  readonly buffer: FakeBuffer;
  readonly bufferOffset: number;
  readonly bytes: Uint8Array;
}

export interface WriteTextureCall {
  readonly texture: FakeTexture;
  readonly bytes: Uint8Array;
  readonly destination: unknown;
}

export class FakeQueue {
  readonly writeBufferCalls: WriteBufferCall[] = [];
  readonly writeTextureCalls: WriteTextureCall[] = [];
  readonly submitCalls: (readonly unknown[])[] = [];

  writeBuffer(
    buffer: FakeBuffer,
    bufferOffset: number,
    data: ArrayBufferView,
    dataOffset = 0,
    size?: number,
  ): void {
    const byteLength = size ?? data.byteLength - dataOffset;
    this.writeBufferCalls.push({
      buffer,
      bufferOffset,
      bytes: new Uint8Array(
        new Uint8Array(data.buffer, data.byteOffset + dataOffset, byteLength),
      ),
    });
  }

  writeTexture(
    destination: unknown,
    data: ArrayBufferView,
    _layout: unknown,
    _size: unknown,
  ): void {
    // The fake records only the destination bytes; layout and size remain part
    // of the GPUQueue-shaped signature for call-site compatibility.
    void _layout;
    void _size;
    const destinationRecord = destination as {
      readonly texture?: FakeTexture;
    };
    const texture = destinationRecord.texture;
    if (texture === undefined) {
      throw new Error("fake writeTexture requires a texture destination");
    }
    this.writeTextureCalls.push({
      texture,
      bytes: new Uint8Array(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      ),
      destination,
    });
  }

  submit(buffers: readonly unknown[]): void {
    this.submitCalls.push(buffers.slice());
  }
}

export class FakePass {
  readonly log: string[] = [];
  ended = false;

  constructor(readonly descriptor: unknown) {}

  setViewport(
    x: number,
    y: number,
    width: number,
    height: number,
    minDepth: number,
    maxDepth: number,
  ): void {
    this.log.push(
      `setViewport:${x}:${y}:${width}:${height}:${minDepth}:${maxDepth}`,
    );
  }

  setPipeline(pipeline: FakeRenderPipeline): void {
    this.log.push(`setPipeline:${pipeline.label}`);
  }

  setBindGroup(
    index: number,
    group: FakeBindGroup,
    dynamicOffsets?: Uint32Array,
  ): void {
    const suffix =
      dynamicOffsets === undefined ? "" : `:${dynamicOffsets[0] ?? 0}`;
    this.log.push(`setBindGroup:${index}:${group.label}${suffix}`);
  }

  setVertexBuffer(
    slot: number,
    buffer: FakeBuffer,
    offset = 0,
    size?: number,
  ): void {
    this.log.push(
      `setVertexBuffer:${slot}:${buffer.label}:${offset}:${size ?? "all"}`,
    );
  }

  setIndexBuffer(buffer: FakeBuffer, format: string): void {
    this.log.push(`setIndexBuffer:${buffer.label}:${format}`);
  }

  drawIndexed(
    indexCount: number,
    instanceCount: number,
    firstIndex: number,
    baseVertex: number,
    firstInstance: number,
  ): void {
    this.log.push(
      `drawIndexed:${indexCount}:${instanceCount}:${firstIndex}:${baseVertex}:${firstInstance}`,
    );
  }

  draw(
    vertexCount: number,
    instanceCount: number,
    firstVertex: number,
    firstInstance: number,
  ): void {
    this.log.push(
      `draw:${vertexCount}:${instanceCount}:${firstVertex}:${firstInstance}`,
    );
  }

  end(): void {
    this.ended = true;
    this.log.push("end");
  }
}

export class FakeCommandEncoder {
  readonly passes: FakePass[] = [];
  finished = false;

  constructor(readonly label: string) {}

  beginRenderPass(descriptor: unknown): FakePass {
    const pass = new FakePass(descriptor);
    this.passes.push(pass);
    return pass;
  }

  finish(): unknown {
    this.finished = true;
    return { label: `${this.label}-commands` };
  }
}

type UncapturedListener = (event: unknown) => void;

export interface FakeDeviceCounts {
  createBuffer: number;
  createTexture: number;
  createSampler: number;
  createShaderModule: number;
  createRenderPipeline: number;
  createBindGroup: number;
  createBindGroupLayout: number;
  createPipelineLayout: number;
  createCommandEncoder: number;
  destroy: number;
}

export class FakeDevice {
  readonly features: Set<string>;
  readonly limits: FakeLimits;
  readonly queue = new FakeQueue();
  readonly counts: FakeDeviceCounts = {
    createBuffer: 0,
    createTexture: 0,
    createSampler: 0,
    createShaderModule: 0,
    createRenderPipeline: 0,
    createBindGroup: 0,
    createBindGroupLayout: 0,
    createPipelineLayout: 0,
    createCommandEncoder: 0,
    destroy: 0,
  };
  readonly buffers: FakeBuffer[] = [];
  readonly textures: FakeTexture[] = [];
  readonly samplers: FakeSampler[] = [];
  readonly shaderModules: FakeShaderModule[] = [];
  readonly renderPipelines: FakeRenderPipeline[] = [];
  readonly encoders: FakeCommandEncoder[] = [];
  readonly pipelineLabels: string[] = [];
  destroyed = false;
  failRenderPipelineLabels = new Set<string>();
  failAllRenderPipelines = false;
  failShaderModules = false;

  private readonly lostPromise: Promise<{ reason: string; message: string }>;
  private resolveLost: (info: { reason: string; message: string }) => void =
    () => {};
  private readonly listeners = new Map<string, Set<UncapturedListener>>();

  constructor(
    limits: FakeLimits,
    features: Iterable<string> = [],
  ) {
    this.limits = limits;
    this.features = new Set(features);
    this.lostPromise = new Promise((resolve) => {
      this.resolveLost = resolve;
    });
  }

  get lost(): Promise<{ reason: string; message: string }> {
    return this.lostPromise;
  }

  lose(reason = "unknown", message = "forced loss"): void {
    this.resolveLost({ reason, message });
  }

  addEventListener(type: string, listener: UncapturedListener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: UncapturedListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emitUncapturedError(): void {
    for (const listener of this.listeners.get("uncapturederror") ?? []) {
      listener({ error: new Error("fake validation error") });
    }
  }

  createBuffer(desc: {
    readonly label?: string;
    readonly size: number;
    readonly usage: number;
  }): FakeBuffer {
    this.counts.createBuffer += 1;
    const buffer = new FakeBuffer(desc.label ?? "buffer", desc.size, desc.usage);
    this.buffers.push(buffer);
    return buffer;
  }

  createTexture(desc: {
    readonly label?: string;
    readonly format?: string;
  }): FakeTexture {
    this.counts.createTexture += 1;
    const texture = new FakeTexture(
      desc.label ?? "texture",
      desc as unknown as Record<string, unknown>,
    );
    this.textures.push(texture);
    return texture;
  }

  createSampler(desc: { readonly label?: string }): FakeSampler {
    this.counts.createSampler += 1;
    const sampler = new FakeSampler(desc.label ?? "sampler", desc);
    this.samplers.push(sampler);
    return sampler;
  }

  createShaderModule(desc: {
    readonly label?: string;
    readonly code: string;
  }): FakeShaderModule {
    this.counts.createShaderModule += 1;
    if (this.failShaderModules) {
      throw new Error("fake shader compile failure");
    }
    const module = new FakeShaderModule(desc.label ?? "shader", desc.code);
    this.shaderModules.push(module);
    return module;
  }

  createRenderPipeline(desc: { readonly label?: string }): FakeRenderPipeline {
    this.counts.createRenderPipeline += 1;
    const label = desc.label ?? "pipeline";
    this.pipelineLabels.push(label);
    if (
      this.failAllRenderPipelines ||
      this.failRenderPipelineLabels.has(label)
    ) {
      throw new Error(`fake pipeline validation failure: ${label}`);
    }
    const pipeline = new FakeRenderPipeline(label, desc);
    this.renderPipelines.push(pipeline);
    return pipeline;
  }

  createBindGroupLayout(desc: {
    readonly label?: string;
    readonly entries?: unknown;
  }): FakeBindGroupLayout {
    this.counts.createBindGroupLayout += 1;
    return new FakeBindGroupLayout(desc.label ?? "bind-group-layout", desc.entries);
  }

  createPipelineLayout(desc: {
    readonly label?: string;
    readonly bindGroupLayouts?: readonly unknown[];
  }): FakePipelineLayout {
    this.counts.createPipelineLayout += 1;
    return new FakePipelineLayout(
      desc.label ?? "pipeline-layout",
      desc.bindGroupLayouts ?? [],
    );
  }

  createBindGroup(desc: {
    readonly label?: string;
    readonly entries?: unknown;
  }): FakeBindGroup {
    this.counts.createBindGroup += 1;
    return new FakeBindGroup(desc.label ?? "bind-group", desc.entries);
  }

  createCommandEncoder(desc?: { readonly label?: string }): FakeCommandEncoder {
    this.counts.createCommandEncoder += 1;
    const encoder = new FakeCommandEncoder(desc?.label ?? "encoder");
    this.encoders.push(encoder);
    return encoder;
  }

  destroy(): void {
    this.counts.destroy += 1;
    this.destroyed = true;
    // Real WebGPU resolves `device.lost` with reason "destroyed" on destroy.
    this.lose("destroyed", "device destroyed");
  }
}

export class FakeAdapter {
  readonly devices: FakeDevice[] = [];
  readonly requestDeviceCalls: unknown[] = [];
  failRequestDevice = false;

  constructor(
    readonly limits: FakeLimits = fakeLimits(),
    readonly features: Set<string> = new Set(),
    readonly info: Record<string, string> = {
      description: "Fake GPU",
      vendor: "fake",
      architecture: "test",
      device: "fake-device",
    },
  ) {}

  private gate: Promise<void> | null = null;

  /** Holds the next `requestDevice` until the returned release is called. */
  deferNextRequestDevice(): () => void {
    let release: () => void = () => {};
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.gate = null;
      release();
    };
  }

  newDevice(): FakeDevice {
    const device = new FakeDevice(this.limits, this.features);
    this.devices.push(device);
    return device;
  }

  async requestDevice(desc?: unknown): Promise<GPUDevice> {
    this.requestDeviceCalls.push(desc);
    if (this.failRequestDevice) {
      throw new Error("fake requestDevice failure");
    }
    const gate = this.gate;
    if (gate !== null) {
      await gate;
    }
    return this.newDevice() as unknown as GPUDevice;
  }
}

export class FakeGpu {
  preferredFormat = "bgra8unorm";
  readonly adapters: FakeAdapter[] = [];
  readonly requestAdapterCalls: { readonly powerPreference?: string }[] = [];
  makeAdapter: () => FakeAdapter = () => new FakeAdapter();
  failRequestAdapter = false;
  requestAdapterFailuresRemaining = 0;
  returnNullAdapter = false;

  getPreferredCanvasFormat(): string {
    return this.preferredFormat;
  }

  async requestAdapter(
    options?: GPURequestAdapterOptions,
  ): Promise<GPUAdapter | null> {
    const call =
      options?.powerPreference === undefined
        ? {}
        : { powerPreference: options.powerPreference };
    this.requestAdapterCalls.push(call);
    if (this.requestAdapterFailuresRemaining > 0) {
      this.requestAdapterFailuresRemaining -= 1;
      throw new Error("fake requestAdapter failure");
    }
    if (this.failRequestAdapter) {
      throw new Error("fake requestAdapter failure");
    }
    if (this.returnNullAdapter) {
      return null;
    }
    const adapter = this.makeAdapter();
    this.adapters.push(adapter);
    return adapter as unknown as GPUAdapter;
  }
}

export class FakeCanvasContext {
  configureCalls = 0;
  unconfigureCalls = 0;
  getCurrentTextureCalls = 0;
  readonly configureDescriptors: unknown[] = [];
  readonly errorQueue: string[] = [];
  current: FakeTexture = new FakeTexture("swapchain", {
    format: "bgra8unorm",
  });

  configure(descriptor: unknown): void {
    this.configureCalls += 1;
    this.configureDescriptors.push(descriptor);
  }

  unconfigure(): void {
    this.unconfigureCalls += 1;
  }

  getCurrentTexture(): FakeTexture {
    this.getCurrentTextureCalls += 1;
    const error = this.errorQueue.shift();
    if (error !== undefined) {
      throw new Error(error);
    }
    return this.current;
  }
}

export class FakeCanvas {
  width = 0;
  height = 0;
  readonly context = new FakeCanvasContext();

  getContext(contextId: "webgpu"): unknown {
    return contextId === "webgpu" ? this.context : null;
  }
}

export interface Harness {
  readonly gpu: FakeGpu;
  readonly adapter: FakeAdapter;
  readonly device: FakeDevice;
  readonly dependencies: WebGpuDeviceDependencies;
  readonly canvas: FakeCanvas;
  readonly context: FakeCanvasContext;
  readonly limits: DeviceLimits;
}

/** Builds dependencies plus a canvas; the device is not initialized. */
export function createHarness(options?: WebGpuDeviceOptions): Harness {
  const gpu = new FakeGpu();
  const adapter = new FakeAdapter();
  const device = adapter.newDevice();
  gpu.makeAdapter = () => adapter;
  const normalized = normalizeOptions(options);
  const limits = deviceLimits(adapter.limits as unknown as GPUSupportedLimits);
  const capabilities = capabilitiesFromAdapter(
    adapter as unknown as GPUAdapter,
    normalized,
    [],
    limits,
  );
  const canvas = new FakeCanvas();
  const dependencies: WebGpuDeviceDependencies = {
    gpu: gpu as unknown as GPU,
    adapter: adapter as unknown as GPUAdapter,
    device: device as unknown as GPUDevice,
    requestedFeatures: [],
    limits,
    capabilities,
    options: options ?? {},
  };
  return {
    gpu,
    adapter,
    device,
    dependencies,
    canvas,
    context: canvas.context,
    limits,
  };
}

export function canvasSurface(
  canvas: FakeCanvas,
  cssWidth = 640,
  cssHeight = 360,
  dpr = 1,
): {
  readonly kind: "canvas";
  readonly native: FakeCanvas;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly dpr: number;
} {
  return { kind: "canvas", native: canvas, cssWidth, cssHeight, dpr };
}
