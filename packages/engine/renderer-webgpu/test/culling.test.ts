/**
 * Frustum-culling tests (04 §5.12, ER-04-10).
 *
 * The pure culler is checked against a synthetic WebGPU-clip fixture, then the
 * same cases are driven through the fake-GPU draw path. No real GPU exists in
 * these tests: the fixture is contract data, not a hardware measurement.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  mat4Create,
  mat4FromScale,
  mat4FromTranslation,
  mat4Multiply,
  mat4OrthographicWebGPU,
  vec3Create,
} from "@lanpad/engine-core";
import type { Mat4, Vec3 } from "@lanpad/engine-core";
import {
  FrustumCuller,
  unionSphereForInstances,
} from "../src/culling/FrustumCuller.js";
import { WebGpuRendererError } from "../src/errors.js";
import {
  currentPassLog,
  errorOf,
  initialized,
  instanceTransforms,
  instancedMeshDesc,
  materialDesc,
  staticMeshDesc,
  translation,
} from "./helpers.js";

interface CullingCase {
  readonly id: string;
  readonly center: readonly number[];
  readonly radius: number;
  readonly visible: boolean;
}

interface TransformedCase {
  readonly id: string;
  readonly translation: readonly number[];
  readonly scale: readonly number[];
  readonly center: readonly number[];
  readonly radius: number;
  readonly visible: boolean;
}

interface CullingFixture {
  readonly formatVersion: number;
  readonly synthetic: boolean;
  readonly clip: string;
  readonly projection: {
    readonly left: number;
    readonly right: number;
    readonly bottom: number;
    readonly top: number;
    readonly near: number;
    readonly far: number;
  };
  readonly cases: readonly CullingCase[];
  readonly transformedCases: readonly TransformedCase[];
  readonly instances: {
    readonly localCenter: readonly number[];
    readonly localRadius: number;
    readonly twoFarApart: {
      readonly translations: readonly (readonly number[])[];
      readonly center: readonly number[];
      readonly radius: number;
    };
  };
}

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/culling-cases.json", import.meta.url),
    "utf8",
  ),
) as CullingFixture;

function xyz(values: readonly number[]): Vec3 {
  return { x: values[0] ?? 0, y: values[1] ?? 0, z: values[2] ?? 0 };
}

function fixtureProjection(): Mat4 {
  const projection = fixture.projection;
  return mat4OrthographicWebGPU(
    mat4Create(),
    projection.left,
    projection.right,
    projection.bottom,
    projection.top,
    projection.near,
    projection.far,
  );
}

function modelFor(entry: TransformedCase): Mat4 {
  return mat4Multiply(
    mat4Create(),
    mat4FromTranslation(mat4Create(), xyz(entry.translation)),
    mat4FromScale(mat4Create(), xyz(entry.scale)),
  );
}

describe("frustum reference set", () => {
  test("[ER-04-10] the culling fixture declares WebGPU clip and the ABI projection", () => {
    expect(fixture.formatVersion).toBe(1);
    expect(fixture.synthetic).toBe(true);
    expect(fixture.clip).toBe("webgpu");
    expect(fixture.projection).toEqual({
      left: -10,
      right: 10,
      bottom: -10,
      top: 10,
      near: 1,
      far: 100,
    });
  });

  test("[ER-04-10] every fixture sphere matches the extracted frustum", () => {
    const culler = new FrustumCuller();
    expect(culler.update(fixtureProjection())).toBe(true);
    expect(culler.isValid).toBe(true);
    for (const entry of fixture.cases) {
      const center = xyz(entry.center);
      expect(
        culler.sphereVisible(center.x, center.y, center.z, entry.radius),
        entry.id,
      ).toBe(entry.visible);
    }
  });

  test("[ER-04-10] model translation and scale move the culling sphere", () => {
    const culler = new FrustumCuller();
    culler.update(fixtureProjection());
    for (const entry of fixture.transformedCases) {
      const center = xyz(entry.center);
      expect(
        culler.transformedSphereVisible(
          modelFor(entry),
          center.x,
          center.y,
          center.z,
          entry.radius,
        ),
        entry.id,
      ).toBe(entry.visible);
    }
  });

  test("[ER-04-10] an invalid view-projection keeps spheres visible", () => {
    const culler = new FrustumCuller();
    const invalid = fixtureProjection();
    invalid.m[0] = Number.NaN;
    expect(culler.update(invalid)).toBe(false);
    expect(culler.isValid).toBe(false);
    expect(culler.sphereVisible(1_000, 1_000, 1_000, 0)).toBe(true);
  });

  test("[ER-04-10] union sphere encloses every instance and is empty for zero", () => {
    const group = fixture.instances.twoFarApart;
    const transforms = instanceTransforms(
      group.translations.map(
        (point) =>
          [point[0] ?? 0, point[1] ?? 0, point[2] ?? 0] as const,
      ),
    );
    const center = vec3Create();
    const radius = unionSphereForInstances(
      center,
      transforms,
      2,
      fixture.instances.localCenter[0] ?? 0,
      fixture.instances.localCenter[1] ?? 0,
      fixture.instances.localCenter[2] ?? 0,
      fixture.instances.localRadius,
    );
    expect(center.x).toBeCloseTo(group.center[0] ?? 0, 6);
    expect(center.y).toBeCloseTo(group.center[1] ?? 0, 6);
    expect(center.z).toBeCloseTo(group.center[2] ?? 0, 6);
    expect(radius).toBeCloseTo(group.radius, 6);

    const emptyRadius = unionSphereForInstances(center, transforms, 0, 0, 0, 0, 1);
    expect(emptyRadius).toBe(0);
    expect(center.x).toBe(0);
    expect(center.y).toBe(0);
    expect(center.z).toBe(0);
  });
});

describe("device draw path culling", () => {
  test("[ER-04-10] a culled draw consumes no ring slot and no draw call", async () => {
    const { harness, device } = await initialized();
    const frame = device.beginFrame();
    frame.setCamera(fixtureProjection());
    const mesh = device.createMesh(staticMeshDesc());
    const material = device.createMaterial(materialDesc());
    // Mesh creation queues its vertex/index uploads; measure the draw only.
    const uploadsBeforeDraw = device.stats.uploadCalls;

    frame.draw(mesh, material, translation(100, 0, -50));
    expect(device.stats.culledInstances).toBe(1);
    expect(device.stats.drawCalls).toBe(0);
    expect(device.stats.uploadCalls).toBe(uploadsBeforeDraw);

    frame.draw(mesh, material, translation(0, 0, -50));
    expect(device.stats.drawCalls).toBe(1);
    expect(device.stats.uploadCalls).toBeGreaterThan(uploadsBeforeDraw);

    // The first visible draw must own object-ring slot zero, proving the
    // culled draw did not allocate a slot.
    const objectBind = currentPassLog(harness).find((line) =>
      line.startsWith("setBindGroup:3:object-bind-group:"),
    );
    expect(objectBind).toBe("setBindGroup:3:object-bind-group:0");
    device.endFrame();
  });

  test("[ER-04-10] every fixture case is culled or drawn consistently", async () => {
    const { device } = await initialized();
    const frame = device.beginFrame();
    frame.setCamera(fixtureProjection());
    const material = device.createMaterial(materialDesc());

    for (const entry of fixture.cases) {
      const center = xyz(entry.center);
      const mesh = device.createMesh(
        staticMeshDesc({
          label: `mesh-${entry.id}`,
          bounds: { center: { x: 0, y: 0, z: 0 }, radius: entry.radius },
        }),
      );
      const beforeDraw = device.stats.drawCalls;
      const beforeCulled = device.stats.culledInstances;
      frame.draw(mesh, material, translation(center.x, center.y, center.z));
      if (entry.visible) {
        expect(device.stats.drawCalls, entry.id).toBe(beforeDraw + 1);
        expect(device.stats.culledInstances, entry.id).toBe(beforeCulled);
      } else {
        expect(device.stats.drawCalls, entry.id).toBe(beforeDraw);
        expect(device.stats.culledInstances, entry.id).toBe(beforeCulled + 1);
      }
    }
    device.endFrame();
  });

  test("[ER-04-10] an instanced group is culled as one union sphere", async () => {
    const { device } = await initialized();
    const frame = device.beginFrame();
    frame.setCamera(fixtureProjection());
    const mesh = device.createMesh(instancedMeshDesc());
    const material = device.createMaterial(materialDesc());

    frame.drawInstanced(
      mesh,
      material,
      instanceTransforms([
        [100, 0, -50],
        [100, 0, -50],
      ]),
      2,
    );
    expect(device.stats.drawCalls).toBe(0);
    expect(device.stats.culledInstances).toBe(2);
    expect(device.stats.instances).toBe(0);

    frame.drawInstanced(
      mesh,
      material,
      instanceTransforms([
        [0, 0, -50],
        [10, 0, -50],
      ]),
      2,
    );
    expect(device.stats.drawCalls).toBe(1);
    expect(device.stats.instances).toBe(2);
    device.endFrame();
  });

  test("[ER-04-10] a non-finite camera is rejected before drawing", async () => {
    const { device } = await initialized();
    const frame = device.beginFrame();
    const invalid = fixtureProjection();
    invalid.m[3] = Number.POSITIVE_INFINITY;
    const error = errorOf(() => frame.setCamera(invalid));
    expect(error).toBeInstanceOf(WebGpuRendererError);
    expect(error.code).toBe("E_CONTRACT");
    device.endFrame();
  });
});
