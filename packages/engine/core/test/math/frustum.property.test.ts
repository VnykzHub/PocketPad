/**
 * 02 §7 ER-02-09 property tests: frustum containment and conservative
 * intersection.
 *
 * Point containment must equal the six explicit plane tests for 10,000 random
 * points; sphere and AABB intersection must never report a false negative when
 * any of 1,000 sampled interior points is inside the frustum.
 */

import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  aabb3Create,
  aabb3FromCenterHalfExtents,
  frustumContainsPoint,
  frustumCreate,
  frustumFromViewProjection,
  frustumIntersectsAabb,
  frustumIntersectsSphere,
  mat4Create,
  mat4Identity,
  mat4Multiply,
  mat4PerspectiveWebGL2,
  mat4PerspectiveWebGPU,
  vec3Create,
} from "../../src/math/index.js";
import type { Aabb3, Frustum } from "../../src/math/index.js";

const pointArb = fc.record({
  x: fc.double({
    min: -12,
    max: 12,
    noNaN: true,
    noDefaultInfinity: true,
  }),
  y: fc.double({
    min: -12,
    max: 12,
    noNaN: true,
    noDefaultInfinity: true,
  }),
  z: fc.double({
    min: -12,
    max: 12,
    noNaN: true,
    noDefaultInfinity: true,
  }),
});

const shapeCenterArb = fc.record({
  x: fc.double({ min: -4, max: 4, noNaN: true, noDefaultInfinity: true }),
  y: fc.double({ min: -4, max: 4, noNaN: true, noDefaultInfinity: true }),
  z: fc.double({ min: -8, max: 8, noNaN: true, noDefaultInfinity: true }),
});

const radiusArb = fc.double({
  min: 0.2,
  max: 3,
  noNaN: true,
  noDefaultInfinity: true,
});

const halfArb = fc.double({
  min: 0.2,
  max: 2,
  noNaN: true,
  noDefaultInfinity: true,
});

function cameraParametersArb() {
  return fc.record({
    fov: fc.double({ min: 0.4, max: 2, noNaN: true, noDefaultInfinity: true }),
    aspect: fc.double({
      min: 0.5,
      max: 2,
      noNaN: true,
      noDefaultInfinity: true,
    }),
    near: fc.double({ min: 0.1, max: 1, noNaN: true, noDefaultInfinity: true }),
    far: fc.double({ min: 4, max: 15, noNaN: true, noDefaultInfinity: true }),
    webgpu: fc.boolean(),
  });
}

function buildFrustum(parameters: {
  fov: number;
  aspect: number;
  near: number;
  far: number;
  webgpu: boolean;
}): Frustum {
  const view = mat4Identity(mat4Create());
  const projection = parameters.webgpu
    ? mat4PerspectiveWebGPU(
        mat4Create(),
        parameters.fov,
        parameters.aspect,
        parameters.near,
        parameters.far,
      )
    : mat4PerspectiveWebGL2(
        mat4Create(),
        parameters.fov,
        parameters.aspect,
        parameters.near,
        parameters.far,
      );
  const viewProjection = mat4Multiply(mat4Create(), projection, view);
  return frustumFromViewProjection(
    frustumCreate(),
    viewProjection,
    parameters.webgpu ? "webgpu" : "webgl",
  );
}

function explicitContains(
  frustum: Frustum,
  point: { x: number; y: number; z: number },
): boolean {
  for (let index = 0; index < 6; index += 1) {
    const plane = frustum.planes[index]!;
    const distance =
      plane.normal.x * point.x +
      plane.normal.y * point.y +
      plane.normal.z * point.z +
      plane.constant;
    if (!(distance > 0)) {
      return false;
    }
  }
  return true;
}

/** 1,000 deterministic points inside the sphere (95% of its radius). */
function sphereSamples(
  center: { x: number; y: number; z: number },
  radius: number,
): Array<{ x: number; y: number; z: number }> {
  const samples: Array<{ x: number; y: number; z: number }> = [];
  const scale = radius * 0.95;
  const goldenAngle = 2.399963229728653;
  for (let index = 0; index < 1_000; index += 1) {
    const z = 1 - (2 * index + 1) / 1_000;
    const ring = Math.sqrt(Math.max(0, 1 - z * z));
    const theta = index * goldenAngle;
    samples.push({
      x: center.x + Math.cos(theta) * ring * scale,
      y: center.y + Math.sin(theta) * ring * scale,
      z: center.z + z * scale,
    });
  }
  return samples;
}

/** A deterministic 10x10x10 grid inside the AABB. */
function aabbSamples(box: Aabb3): Array<{ x: number; y: number; z: number }> {
  const samples: Array<{ x: number; y: number; z: number }> = [];
  for (let ix = 0; ix < 10; ix += 1) {
    for (let iy = 0; iy < 10; iy += 1) {
      for (let iz = 0; iz < 10; iz += 1) {
        samples.push({
          x: box.min.x + ((box.max.x - box.min.x) * (ix + 0.5)) / 10,
          y: box.min.y + ((box.max.y - box.min.y) * (iy + 0.5)) / 10,
          z: box.min.z + ((box.max.z - box.min.z) * (iz + 0.5)) / 10,
        });
      }
    }
  }
  return samples;
}

describe("Frustum point containment properties", () => {
  test("[ER-02-09] point containment equals the six explicit plane tests for 10,000 points", () => {
    fc.assert(
      fc.property(cameraParametersArb(), pointArb, (parameters, point) => {
        const frustum = buildFrustum(parameters);
        expect(frustumContainsPoint(frustum, point)).toBe(
          explicitContains(frustum, point),
        );
      }),
      { numRuns: 10_000 },
    );
  });
});

describe("Frustum conservative intersection properties", () => {
  test("[ER-02-09] sphere intersection has no false negative against 1,000 interior samples", () => {
    fc.assert(
      fc.property(
        cameraParametersArb(),
        shapeCenterArb,
        radiusArb,
        (parameters, center, radius) => {
          const frustum = buildFrustum(parameters);
          let sampledInside = false;
          for (const sample of sphereSamples(center, radius)) {
            if (frustumContainsPoint(frustum, sample)) {
              sampledInside = true;
              break;
            }
          }
          if (sampledInside) {
            expect(frustumIntersectsSphere(frustum, center, radius)).toBe(
              true,
            );
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  test("[ER-02-09] AABB intersection has no false negative against 1,000 interior samples", () => {
    fc.assert(
      fc.property(
        cameraParametersArb(),
        shapeCenterArb,
        halfArb,
        halfArb,
        halfArb,
        (parameters, center, hx, hy, hz) => {
          const frustum = buildFrustum(parameters);
          const box = aabb3FromCenterHalfExtents(
            aabb3Create(),
            vec3Create(center.x, center.y, center.z),
            vec3Create(hx, hy, hz),
          );
          let sampledInside = false;
          for (const sample of aabbSamples(box)) {
            if (frustumContainsPoint(frustum, sample)) {
              sampledInside = true;
              break;
            }
          }
          if (sampledInside) {
            expect(frustumIntersectsAabb(frustum, box)).toBe(true);
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  test("[ER-02-09] a point on the near plane is excluded strictly", () => {
    const parameters = {
      fov: Math.PI / 2,
      aspect: 1,
      near: 1,
      far: 5,
      webgpu: false,
    };
    const frustum = buildFrustum(parameters);
    expect(frustumContainsPoint(frustum, vec3Create(0, 0, -1))).toBe(false);
    expect(frustumContainsPoint(frustum, vec3Create(0, 0, -1.0001))).toBe(true);
    const webgpuFrustum = buildFrustum({ ...parameters, webgpu: true });
    expect(frustumContainsPoint(webgpuFrustum, vec3Create(0, 0, -1))).toBe(
      false,
    );
    expect(
      frustumContainsPoint(webgpuFrustum, vec3Create(0, 0, -1.0001)),
    ).toBe(true);
  });
});
