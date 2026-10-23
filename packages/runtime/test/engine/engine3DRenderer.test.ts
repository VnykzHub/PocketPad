// @req ER-04-17 — the legacy 3D adapter's lifecycle, draw counts and dispose contract.
import type {
  Mat4,
  MaterialDesc,
  MaterialHandle,
  MeshDesc,
  MeshHandle,
  RenderDevice,
  RenderFrame,
  Vec3,
} from "@lanpad/engine-core";
import { describe, expect, test, vi } from "vitest";
import {
  EngineGameRenderer,
  EngineGameRendererError,
} from "../../src/engine/engine3DRenderer.js";

interface FakeFrame {
  readonly frame: RenderFrame;
  setCamera: ReturnType<typeof vi.fn>;
  draw: ReturnType<typeof vi.fn>;
  drawInstanced: ReturnType<typeof vi.fn>;
}

interface FakeDevice {
  readonly device: RenderDevice;
  readonly frames: FakeFrame[];
  readonly meshDescs: MeshDesc[];
  readonly materialDescs: MaterialDesc[];
  createMesh: ReturnType<typeof vi.fn>;
  createMaterial: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  stats: { drawCalls: number; textureBytes: number };
}

interface FakeDeviceOptions {
  readonly backend?: "webgl2" | "webgpu";
  readonly valid?: boolean;
}

function fakeFrame(valid: boolean): FakeFrame {
  const setCamera = vi.fn<(viewProjection: Mat4) => void>();
  const draw = vi.fn();
  const drawInstanced = vi.fn();
  const frame = {
    valid,
    setCamera,
    setCameraMatrices: vi.fn(),
    draw,
    drawInstanced,
    drawLod: vi.fn(),
    beginPass: vi.fn(),
    drawFullscreen: vi.fn(),
  } as unknown as RenderFrame;
  return { frame, setCamera, draw, drawInstanced };
}

function handle<T>(index: number, kind: string): T {
  return { index, generation: 1, __kind: kind } as unknown as T;
}

/** NDC z of a world point through a column-major view-projection matrix. */
function projectNdcZ(viewProjection: Mat4, point: Vec3): number {
  const m = viewProjection.m;
  const clipZ = m[2]! * point.x + m[6]! * point.y + m[10]! * point.z + m[14]!;
  const clipW = m[3]! * point.x + m[7]! * point.y + m[11]! * point.z + m[15]!;
  return clipZ / clipW;
}

function fakeDevice(options: FakeDeviceOptions = {}): FakeDevice {
  const frames: FakeFrame[] = [];
  const meshDescs: MeshDesc[] = [];
  const materialDescs: MaterialDesc[] = [];
  let nextHandle = 1;

  const createMesh = vi.fn((desc: MeshDesc): MeshHandle => {
    meshDescs.push(desc);
    return handle<MeshHandle>(nextHandle++, "mesh");
  });
  const createMaterial = vi.fn((desc: MaterialDesc): MaterialHandle => {
    materialDescs.push(desc);
    return handle<MaterialHandle>(nextHandle++, "material");
  });
  const stats = { drawCalls: 0, textureBytes: 0 };
  const device = {
    backend: options.backend ?? "webgl2",
    features: new Set<string>(),
    limits: {},
    capabilities: {
      supportedFormats: new Set(["rgba8unorm", "s3tc-dxt5", "astc-4x4"]),
      maxTextureSize: 8192,
    },
    stats,
    size: { width: 1280, height: 720 },
    resize: vi.fn(),
    beginFrame: vi.fn(() => {
      const frame = fakeFrame(options.valid !== false);
      frames.push(frame);
      return frame.frame;
    }),
    endFrame: vi.fn(),
    createMesh,
    createMaterial,
    destroy: vi.fn(),
    dispose: vi.fn(),
  } as unknown as RenderDevice;

  return {
    device,
    frames,
    meshDescs,
    materialDescs,
    createMesh,
    createMaterial,
    destroy: device.destroy as ReturnType<typeof vi.fn>,
    dispose: device.dispose as ReturnType<typeof vi.fn>,
    resize: device.resize as ReturnType<typeof vi.fn>,
    stats,
  };
}

const canvas = {} as HTMLCanvasElement;

describe("EngineGameRenderer", () => {
  test("[ER-04-04] init uploads one instanced unit cube and dispose frees every handle once", async () => {
    const fake = fakeDevice();
    const renderer = new EngineGameRenderer(fake.device, canvas);

    await renderer.init(canvas);
    await renderer.init(canvas);

    expect(fake.createMesh).toHaveBeenCalledTimes(1);
    const desc = fake.meshDescs[0]!;
    expect(desc.layout).toBe("instanced-transform-v1");
    expect(desc.vertices).toHaveLength(1);
    expect(desc.vertices[0]!.byteLength).toBe(6 * 4 * 32);
    expect(desc.indices?.data.length).toBe(36);
    expect(desc.indices?.format).toBe("uint16");
    expect(desc.bounds.radius).toBeCloseTo(Math.sqrt(3) / 2, 6);

    renderer.beginFrame(0);
    renderer.drawCube({ x: 0, y: 0, z: 0 }, 1, "#6ee7ff", 0);
    renderer.drawCube({ x: 1, y: 0, z: 0 }, 1, "#6ee7ff", 0);
    renderer.drawCube({ x: 2, y: 0, z: 0 }, 1, "#ffd166", 0);
    renderer.endFrame();

    expect(fake.createMaterial).toHaveBeenCalledTimes(2);
    renderer.dispose();
    renderer.dispose();

    expect(fake.destroy).toHaveBeenCalledTimes(3);
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });

  test("[ER-04-17] groups instances by color and reports one draw call per group", async () => {
    const fake = fakeDevice();
    const renderer = new EngineGameRenderer(fake.device, canvas);
    await renderer.init(canvas);

    renderer.resize(800, 600, 1);
    renderer.setCamera({ x: 0, y: 1.2, z: 3.2 }, { x: 0, y: 0, z: 0 });
    renderer.beginFrame(0.5);
    renderer.drawCube({ x: -1, y: 0, z: 0 }, 1, "#6ee7ff", 0);
    renderer.drawCube({ x: 1, y: 0, z: 0 }, 1, "#6ee7ff", Math.PI / 2);
    renderer.drawCube({ x: 0, y: 0, z: -1 }, 2, "#ffd166", 0);
    renderer.endFrame();

    const frame = fake.frames[0]!;
    expect(frame.setCamera).toHaveBeenCalledTimes(1);
    const camera = frame.setCamera.mock.calls[0]![0] as Mat4;
    expect(camera.m).toHaveLength(16);
    // WebGL2 maps the near plane to NDC z = -1. The adapter's default camera
    // is (0, 1.2, 3.2) looking at the origin.
    const eyeDistance = Math.hypot(1.2, 3.2);
    const nearPoint: Vec3 = {
      x: 0,
      y: 1.2 - (1.2 / eyeDistance) * 0.1,
      z: 3.2 - (3.2 / eyeDistance) * 0.1,
    };
    expect(projectNdcZ(camera, nearPoint)).toBeCloseTo(-1, 5);

    expect(frame.drawInstanced).toHaveBeenCalledTimes(2);
    const [firstMesh, firstMaterial, firstTransforms, firstCount] =
      frame.drawInstanced.mock.calls[0]!;
    const [secondMesh, secondMaterial, secondTransforms, secondCount] =
      frame.drawInstanced.mock.calls[1]!;

    expect(firstMesh).toBe(secondMesh);
    expect(firstMaterial).not.toBe(secondMaterial);
    expect(firstCount).toBe(2);
    expect(secondCount).toBe(1);

    const first = firstTransforms as Float32Array;
    expect(first[12]).toBe(-1);
    expect(first[13]).toBe(0);
    expect(first[14]).toBe(0);
    expect(first[15]).toBe(1);
    // Second instance: 90° yaw, column 0 is (cos, 0, -sin) * size.
    expect(first[16 + 0]).toBeCloseTo(0, 6);
    expect(first[16 + 2]).toBeCloseTo(-1, 6);
    expect(first[16 + 12]).toBe(1);

    const third = secondTransforms as Float32Array;
    expect(third[5]).toBe(2);
    expect(third[14]).toBe(-1);
    expect(renderer.drawCalls).toBe(2);
    expect(fake.device.endFrame).toHaveBeenCalledTimes(1);
  });

  test("[ER-04-17] passes CSS colors through unchanged until RV-76 is fixed", async () => {
    const fake = fakeDevice();
    const renderer = new EngineGameRenderer(fake.device, canvas);
    await renderer.init(canvas);

    renderer.beginFrame(0);
    renderer.drawCube({ x: 0, y: 0, z: 0 }, 1, "#ffd166", 0);
    renderer.endFrame();

    const factor = fake.materialDescs[0]?.baseColorFactor ?? [0, 0, 0, 0];
    expect(factor[0]).toBeCloseTo(1, 6);
    expect(factor[1]).toBeCloseTo(0xd1 / 255, 6);
    expect(factor[2]).toBeCloseTo(0x66 / 255, 6);
    expect(factor[3]).toBe(1);
  });

  test("[ER-04-17] uses the WebGPU depth range when the device is WebGPU", async () => {
    const fake = fakeDevice({ backend: "webgpu" });
    const renderer = new EngineGameRenderer(fake.device, canvas);
    await renderer.init(canvas);

    renderer.beginFrame(0);
    renderer.drawCube({ x: 0, y: 0, z: 0 }, 1, "#ffffff", 0);
    renderer.endFrame();

    const frame = fake.frames[0]!;
    const camera = frame.setCamera.mock.calls[0]![0] as Mat4;
    // WebGPU maps the near plane to NDC z = 0 and the far plane to 1.
    const eyeDistance = Math.hypot(1.2, 3.2);
    const nearPoint: Vec3 = {
      x: 0,
      y: 1.2 - (1.2 / eyeDistance) * 0.1,
      z: 3.2 - (3.2 / eyeDistance) * 0.1,
    };
    const farPoint: Vec3 = {
      x: 0,
      y: 1.2 - (1.2 / eyeDistance) * 100,
      z: 3.2 - (3.2 / eyeDistance) * 100,
    };
    expect(projectNdcZ(camera, nearPoint)).toBeCloseTo(0, 5);
    expect(projectNdcZ(camera, farPoint)).toBeCloseTo(1, 5);
  });

  test("[ER-04-06] forwards resize dimensions and exposes the CSS size", async () => {
    const fake = fakeDevice();
    const renderer = new EngineGameRenderer(fake.device, canvas);
    await renderer.init(canvas);

    renderer.resize(1280, 720, 2);

    expect(fake.resize).toHaveBeenCalledWith(1280, 720, 2);
    expect(renderer.size).toEqual({ width: 1280, height: 720 });
  });

  test("[ER-04-17] an invalid frame draws nothing but still ends the device frame", async () => {
    const fake = fakeDevice({ valid: false });
    const renderer = new EngineGameRenderer(fake.device, canvas);
    await renderer.init(canvas);

    renderer.beginFrame(0);
    renderer.drawCube({ x: 0, y: 0, z: 0 }, 1, "#ffffff", 0);
    renderer.endFrame();

    const frame = fake.frames[0]!;
    expect(frame.setCamera).not.toHaveBeenCalled();
    expect(frame.drawInstanced).not.toHaveBeenCalled();
    expect(fake.device.endFrame).toHaveBeenCalledTimes(1);
    expect(renderer.drawCalls).toBe(0);
  });

  test("[ER-04-08] steady-state frames reuse the instance buffer", async () => {
    const fake = fakeDevice();
    const renderer = new EngineGameRenderer(fake.device, canvas);
    await renderer.init(canvas);

    renderer.beginFrame(0);
    renderer.drawCube({ x: 0, y: 0, z: 0 }, 1, "#ffffff", 0);
    renderer.endFrame();
    const firstBuffer = fake.frames[0]!.drawInstanced.mock.calls[0]![2];

    renderer.beginFrame(0);
    renderer.drawCube({ x: 0, y: 0, z: 0 }, 1, "#ffffff", 0);
    renderer.endFrame();
    const secondBuffer = fake.frames[1]!.drawInstanced.mock.calls[0]![2];

    expect(secondBuffer).toBe(firstBuffer);
  });

  test("[ER-04-17] refuses more colors than the cache allows", async () => {
    const fake = fakeDevice();
    const renderer = new EngineGameRenderer(fake.device, canvas, {
      maxMaterials: 1,
    });
    await renderer.init(canvas);

    renderer.beginFrame(0);
    renderer.drawCube({ x: 0, y: 0, z: 0 }, 1, "#ffffff", 0);
    let captured: unknown = null;
    try {
      renderer.drawCube({ x: 0, y: 0, z: 0 }, 1, "#000000", 0);
    } catch (error) {
      captured = error;
    }
    renderer.endFrame();

    expect(captured).toBeInstanceOf(EngineGameRendererError);
    expect((captured as EngineGameRendererError).code).toBe(
      "E_UNSUPPORTED_FEATURE",
    );
    expect(renderer.drawCalls).toBe(1);
  });

  test("[ER-04-17] refuses a foreign canvas and drawCube before init", async () => {
    const fake = fakeDevice();
    const renderer = new EngineGameRenderer(fake.device, canvas);

    await expect(renderer.init({} as HTMLCanvasElement)).rejects.toThrow(
      "different canvas",
    );
    expect(() =>
      renderer.drawCube({ x: 0, y: 0, z: 0 }, 1, "#ffffff", 0),
    ).toThrow("init() must complete");
  });

  test("[ER-04-17] reports texture memory from device stats", () => {
    const fake = fakeDevice();
    const renderer = new EngineGameRenderer(fake.device, canvas);
    fake.stats.textureBytes = 2 * 1024 * 1024;

    expect(renderer.textureMemoryMB).toBe(2);
  });
});
