/**
 * Instancing, instance-ring and batch-splitting tests (04 §5.16, ER-04-10).
 *
 * Ring arithmetic is pure; the device cases use the fake GPU recorder and never
 * a real adapter. Byte offsets and split counts are contract data from
 * `fixtures/instance-batches.json`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { INSTANCE_STRIDE_BYTES, OBJECTS_PER_FRAME } from "../src/abi.js";
import {
  INSTANCE_RING_CAPACITY_BYTES,
  InstanceRing,
  MAX_INSTANCES_PER_FRAME,
} from "../src/buffer/InstanceRing.js";
import {
  currentPassLog,
  errorOf,
  initialized,
  instanceTransforms,
  instancedMeshDesc,
  materialDesc,
  orthoProjection,
  staticMeshDesc,
} from "./helpers.js";

interface AllocationCase {
  readonly id: string;
  readonly requests: readonly number[];
  readonly accepted: readonly number[];
  readonly offsets: readonly number[];
}

interface DeviceCase {
  readonly id: string;
  readonly counts: readonly number[];
  readonly drawCalls: number;
  readonly accepted: readonly number[];
  readonly droppedDraws: number;
}

interface InstanceFixture {
  readonly formatVersion: number;
  readonly synthetic: boolean;
  readonly instanceStrideBytes: number;
  readonly ringCapacityBytes: number;
  readonly ringCapacityInstances: number;
  readonly maxInstancesPerFrame: number;
  readonly maxObjectsPerFrame: number;
  readonly smallRing: {
    readonly capacityBytes: number;
    readonly capacityInstances: number;
    readonly allocations: readonly AllocationCase[];
  };
  readonly deviceCases: readonly DeviceCase[];
  readonly overCapacity: {
    readonly count: number;
    readonly devError: string;
    readonly productionAccepted: number;
    readonly productionDroppedDraws: number;
  };
}

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/instance-batches.json", import.meta.url),
    "utf8",
  ),
) as InstanceFixture;

/** Identity instances translated to z = -50 (inside the ortho fixture). */
function fullInstances(count: number): Float32Array {
  const out = new Float32Array(count * 16);
  for (let index = 0; index < count; index += 1) {
    const base = index * 16;
    out[base] = 1;
    out[base + 5] = 1;
    out[base + 10] = 1;
    out[base + 14] = -50;
    out[base + 15] = 1;
  }
  return out;
}

function bytesAsFloats(bytes: Uint8Array): Float32Array {
  return new Float32Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength / 4,
  );
}

describe("instance ring arithmetic", () => {
  test("[ER-04-10] instance ring constants match the frozen ABI", () => {
    expect(fixture.formatVersion).toBe(1);
    expect(fixture.synthetic).toBe(true);
    expect(INSTANCE_STRIDE_BYTES).toBe(fixture.instanceStrideBytes);
    expect(INSTANCE_RING_CAPACITY_BYTES).toBe(fixture.ringCapacityBytes);
    expect(MAX_INSTANCES_PER_FRAME).toBe(fixture.ringCapacityInstances);
    expect(OBJECTS_PER_FRAME).toBe(fixture.maxObjectsPerFrame);
    expect(
      fixture.ringCapacityBytes / fixture.instanceStrideBytes,
    ).toBe(fixture.ringCapacityInstances);
  });

  test("[ER-04-10] the ring splits, fills and refuses overflow", () => {
    expect(
      fixture.smallRing.capacityBytes / fixture.instanceStrideBytes,
    ).toBe(fixture.smallRing.capacityInstances);
    for (const entry of fixture.smallRing.allocations) {
      const ring = new InstanceRing(fixture.smallRing.capacityBytes);
      const accepted: number[] = [];
      const offsets: number[] = [];
      for (const request of entry.requests) {
        const offset = { value: -1 };
        accepted.push(ring.allocate(request, offset));
        offsets.push(offset.value);
      }
      expect(accepted, entry.id).toEqual(entry.accepted);
      expect(offsets, entry.id).toEqual(entry.offsets);
    }
  });
});

describe("device instanced batches", () => {
  test("[ER-04-10] exactly 65,536 instances upload and draw in one call", async () => {
    const { harness, device } = await initialized();
    const frame = device.beginFrame();
    frame.setCamera(orthoProjection());
    const mesh = device.createMesh(instancedMeshDesc());
    const material = device.createMaterial(materialDesc());

    const count = fixture.maxInstancesPerFrame;
    frame.drawInstanced(mesh, material, fullInstances(count), count);

    expect(device.stats.drawCalls).toBe(1);
    expect(device.stats.instances).toBe(count);
    expect(device.stats.droppedDraws).toBe(0);
    const log = currentPassLog(harness);
    expect(log).toContain("setPipeline:builtin-lit-instanced");
    expect(log).toContain(
      `setVertexBuffer:1:instance-ring:0:${fixture.ringCapacityBytes}`,
    );
    expect(log.some((line) => line.startsWith(`drawIndexed:3:${count}:`))).toBe(
      true,
    );

    const upload = harness.device.queue.writeBufferCalls.find(
      (call) =>
        call.buffer.label === "instance-ring" && call.bufferOffset === 0,
    );
    if (upload === undefined) {
      throw new Error("expected the instance-ring upload");
    }
    expect(upload.bytes.byteLength).toBe(fixture.ringCapacityBytes);
    const floats = bytesAsFloats(upload.bytes);
    expect(floats[0]).toBe(1);
    expect(floats[14]).toBe(-50);
    const lastBase = (count - 1) * 16;
    expect(floats[lastBase + 14]).toBe(-50);
    expect(floats[lastBase + 15]).toBe(1);
    device.endFrame();
  });

  test("[ER-04-10] a batch larger than the free ring splits into exact draws", async () => {
    const deviceCase = fixture.deviceCases.find(
      (entry) => entry.id === "split-across-ring",
    );
    if (deviceCase === undefined) {
      throw new Error("split-across-ring fixture missing");
    }
    const [firstCount, secondCount] = deviceCase.counts;
    if (firstCount === undefined || secondCount === undefined) {
      throw new Error("split fixture needs two counts");
    }
    const { harness, device } = await initialized();
    const frame = device.beginFrame();
    frame.setCamera(orthoProjection());
    const mesh = device.createMesh(instancedMeshDesc());
    const material = device.createMaterial(materialDesc());

    // Two separate draw calls share the frame ring: 60,000 fits, then 10,000
    // splits at the remaining 5,536 instances.
    frame.drawInstanced(mesh, material, fullInstances(firstCount), firstCount);
    frame.drawInstanced(
      mesh,
      material,
      fullInstances(secondCount),
      secondCount,
    );

    expect(device.stats.drawCalls).toBe(deviceCase.drawCalls);
    expect(device.stats.instances).toBe(
      deviceCase.accepted.reduce((sum, value) => sum + value, 0),
    );
    expect(device.stats.droppedDraws).toBe(deviceCase.droppedDraws);

    const log = currentPassLog(harness);
    const draws = log.filter((line) => line.startsWith("drawIndexed:"));
    expect(draws).toEqual(
      deviceCase.accepted.map(
        (accepted) => `drawIndexed:3:${accepted}:0:0:0`,
      ),
    );
    const slots = log.filter((line) => line.startsWith("setVertexBuffer:1:"));
    const [firstAccepted, secondAccepted] = deviceCase.accepted;
    if (firstAccepted === undefined || secondAccepted === undefined) {
      throw new Error("split fixture needs two accepted counts");
    }
    expect(slots).toEqual([
      `setVertexBuffer:1:instance-ring:0:${
        firstAccepted * fixture.instanceStrideBytes
      }`,
      `setVertexBuffer:1:instance-ring:${
        firstAccepted * fixture.instanceStrideBytes
      }:${secondAccepted * fixture.instanceStrideBytes}`,
    ]);
    const objectBinds = log.filter((line) =>
      line.startsWith("setBindGroup:3:object-bind-group:"),
    );
    expect(objectBinds).toEqual([
      "setBindGroup:3:object-bind-group:0",
      "setBindGroup:3:object-bind-group:256",
    ]);

    const instanceUploads = harness.device.queue.writeBufferCalls.filter(
      (call) => call.buffer.label === "instance-ring",
    );
    expect(
      instanceUploads.map((call) => [
        call.bufferOffset,
        call.bytes.byteLength,
      ]),
    ).toEqual([
      [0, firstAccepted * fixture.instanceStrideBytes],
      [
        firstAccepted * fixture.instanceStrideBytes,
        secondAccepted * fixture.instanceStrideBytes,
      ],
    ]);
    // The split tail copies the second call's first matrices, not a restarted
    // or skipped source range.
    const secondUpload = instanceUploads[1];
    if (secondUpload === undefined) {
      throw new Error("expected the second instance upload");
    }
    const floats = bytesAsFloats(secondUpload.bytes);
    expect(floats[14]).toBe(-50);
    expect(floats[15]).toBe(1);
    device.endFrame();
  });

  test("[ER-04-10] 65,537 instances is rejected in dev before any upload", async () => {
    const { harness, device } = await initialized();
    const frame = device.beginFrame();
    frame.setCamera(orthoProjection());
    const mesh = device.createMesh(instancedMeshDesc());
    const material = device.createMaterial(materialDesc());
    const uploadsBefore = device.stats.uploadCalls;
    const count = fixture.overCapacity.count;

    const error = errorOf(() =>
      frame.drawInstanced(mesh, material, fullInstances(count), count),
    );
    expect(error.code).toBe(fixture.overCapacity.devError);
    expect(error.code).toBe("E_UNSUPPORTED_FEATURE");
    expect(device.stats.uploadCalls).toBe(uploadsBefore);
    expect(device.stats.drawCalls).toBe(0);
    expect(device.stats.droppedDraws).toBe(0);
    expect(
      harness.device.queue.writeBufferCalls.some(
        (call) => call.buffer.label === "instance-ring",
      ),
    ).toBe(false);
    device.endFrame();
  });

  test("[ER-04-10] a single-instance draw binds its instance transform", async () => {
    const { harness, device } = await initialized();
    const frame = device.beginFrame();
    frame.setCamera(orthoProjection());
    const mesh = device.createMesh(instancedMeshDesc());
    const material = device.createMaterial(materialDesc());

    frame.drawInstanced(
      mesh,
      material,
      instanceTransforms([[0, 0, -50]]),
      1,
    );

    expect(device.stats.drawCalls).toBe(1);
    expect(device.stats.instances).toBe(1);
    expect(device.stats.droppedDraws).toBe(0);
    const log = currentPassLog(harness);
    expect(log).toContain("setVertexBuffer:1:instance-ring:0:64");
    expect(log.some((line) => line.startsWith("drawIndexed:3:1:"))).toBe(true);
    device.endFrame();
  });

  test("[ER-04-10] invalid counts and transform buffers are rejected", async () => {
    const { device } = await initialized();
    const frame = device.beginFrame();
    frame.setCamera(orthoProjection());
    const mesh = device.createMesh(instancedMeshDesc());
    const material = device.createMaterial(materialDesc());
    const one = instanceTransforms([[0, 0, -50]]);

    expect(errorOf(() => frame.drawInstanced(mesh, material, one, 0)).code).toBe(
      "E_CONTRACT",
    );
    expect(errorOf(() => frame.drawInstanced(mesh, material, one, -1)).code).toBe(
      "E_CONTRACT",
    );
    expect(
      errorOf(() => frame.drawInstanced(mesh, material, one, 1.5)).code,
    ).toBe("E_CONTRACT");
    expect(errorOf(() => frame.drawInstanced(mesh, material, one, 2)).code).toBe(
      "E_CONTRACT",
    );

    const notFinite = one.slice();
    notFinite[0] = Number.NaN;
    expect(
      errorOf(() => frame.drawInstanced(mesh, material, notFinite, 1)).code,
    ).toBe("E_CONTRACT");

    expect(device.stats.drawCalls).toBe(0);
    expect(device.stats.droppedDraws).toBe(0);
    device.endFrame();
  });

  test("[ER-04-10] drawInstanced requires the instanced vertex layout", async () => {
    const { device } = await initialized();
    const frame = device.beginFrame();
    frame.setCamera(orthoProjection());
    const mesh = device.createMesh(staticMeshDesc());
    const material = device.createMaterial(materialDesc());

    const error = errorOf(() =>
      frame.drawInstanced(
        mesh,
        material,
        instanceTransforms([[0, 0, -50]]),
        1,
      ),
    );
    expect(error.code).toBe("E_UNSUPPORTED_FEATURE");
    expect(device.stats.drawCalls).toBe(0);
    device.endFrame();
  });
});
