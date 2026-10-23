/**
 * 02 §8 conformance: every fixture case, every matrix element, every probe.
 *
 * The fixtures are repo-owned, synthetic and hand-computed from the spec
 * formulas (`math-projection.json`, `math-quat-order.json`). Each field is
 * asserted so a fixture edit that the implementation does not follow fails.
 *
 * ER-02-04: quaternion product order and vector images.
 * ER-02-05: both projection families and near/far depth.
 * ER-02-06: right-handed lookAt.
 */

import { describe, expect, test } from "vitest";
import {
  mat4Create,
  mat4LookAt,
  mat4OrthographicWebGL2,
  mat4OrthographicWebGPU,
  mat4PerspectiveWebGL2,
  mat4PerspectiveWebGPU,
  mat4TransformDirection,
  mat4TransformVec4,
  quatCreate,
  quatLength,
  quatMultiply,
  quatRotateVec3,
  quatToMat4,
  vec3Create,
  vec4Create,
} from "../../src/math/index.js";
import type { Mat4, Vec3 } from "../../src/math/index.js";
import { at, expectVec3Close, loadFixture, near } from "./helpers.js";
import type { ProjectionCase, ProjectionProbe } from "./helpers.js";
import type {
  FixtureQuat,
  ProjectionFixture,
  QuatOrderFixture,
} from "./helpers.js";

const projectionFixture = loadFixture<ProjectionFixture>("math-projection.json");
const quatFixture = loadFixture<QuatOrderFixture>("math-quat-order.json");

function numberArg(fixtureCase: ProjectionCase, index: number): number {
  const value = fixtureCase.args[index];
  if (typeof value !== "number") {
    throw new Error(
      `fixture ${fixtureCase.id}: argument ${index} is not a number`,
    );
  }
  return value;
}

function vectorArg(fixtureCase: ProjectionCase, index: number): Vec3 {
  const value = fixtureCase.args[index];
  if (typeof value === "number" || value === undefined) {
    throw new Error(
      `fixture ${fixtureCase.id}: argument ${index} is not a vector`,
    );
  }
  return vec3Create(value[0]!, value[1]!, value[2]!);
}

function buildMatrix(fixtureCase: ProjectionCase): Mat4 {
  const out = mat4Create();
  switch (fixtureCase.fn) {
    case "mat4PerspectiveWebGL2":
      return mat4PerspectiveWebGL2(
        out,
        numberArg(fixtureCase, 0),
        numberArg(fixtureCase, 1),
        numberArg(fixtureCase, 2),
        numberArg(fixtureCase, 3),
      );
    case "mat4PerspectiveWebGPU":
      return mat4PerspectiveWebGPU(
        out,
        numberArg(fixtureCase, 0),
        numberArg(fixtureCase, 1),
        numberArg(fixtureCase, 2),
        numberArg(fixtureCase, 3),
      );
    case "mat4OrthographicWebGL2":
      return mat4OrthographicWebGL2(
        out,
        numberArg(fixtureCase, 0),
        numberArg(fixtureCase, 1),
        numberArg(fixtureCase, 2),
        numberArg(fixtureCase, 3),
        numberArg(fixtureCase, 4),
        numberArg(fixtureCase, 5),
      );
    case "mat4OrthographicWebGPU":
      return mat4OrthographicWebGPU(
        out,
        numberArg(fixtureCase, 0),
        numberArg(fixtureCase, 1),
        numberArg(fixtureCase, 2),
        numberArg(fixtureCase, 3),
        numberArg(fixtureCase, 4),
        numberArg(fixtureCase, 5),
      );
    case "mat4LookAt":
      return mat4LookAt(
        out,
        vectorArg(fixtureCase, 0),
        vectorArg(fixtureCase, 1),
        vectorArg(fixtureCase, 2),
      );
    default:
      throw new Error(`fixture ${fixtureCase.id}: unknown fn ${fixtureCase.fn}`);
  }
}

function probeVector(probe: ProjectionProbe) {
  const [x, y, z, w] = probe.point;
  return vec4Create(x, y, z, w);
}

function expectMatrix(
  actual: Mat4,
  expected: readonly number[],
  label: string,
): void {
  for (let index = 0; index < 16; index += 1) {
    near(at(actual.m, index), expected[index]!, 1e-6, `${label} m[${index}]`);
  }
}

function fixtureRotation(quat: FixtureQuat) {
  return quatCreate(quat.x, quat.y, quat.z, quat.w);
}

describe("Projection conformance fixture", () => {
  test("[ER-02-05] the fixture is well formed and every case is exercised", () => {
    expect(projectionFixture.formatVersion).toBe(1);
    expect(projectionFixture.synthetic).toBe(true);
    expect(projectionFixture.cases.length).toBeGreaterThanOrEqual(5);
    const ids = new Set<string>();
    for (const fixtureCase of projectionFixture.cases) {
      expect(ids.has(fixtureCase.id), `duplicate id ${fixtureCase.id}`).toBe(
        false,
      );
      ids.add(fixtureCase.id);
      expect(fixtureCase.expected).toHaveLength(16);
      expect(fixtureCase.probes.length).toBeGreaterThan(0);
      for (const probe of fixtureCase.probes) {
        expect(
          probe.expectNdcZ !== undefined || probe.expectClip !== undefined,
          `${fixtureCase.id}/${probe.label} has no expectation`,
        ).toBe(true);
      }
    }
  });

  for (const fixtureCase of projectionFixture.cases) {
    const requirementId =
      fixtureCase.fn === "mat4LookAt" ? "ER-02-06" : "ER-02-05";
    test(`[${requirementId}] fixture case ${fixtureCase.id} matches the hand-computed matrix and probes`, () => {
      const matrix = buildMatrix(fixtureCase);
      expectMatrix(matrix, fixtureCase.expected, fixtureCase.id);
      for (const probe of fixtureCase.probes) {
        const transformed = mat4TransformVec4(
          vec4Create(),
          matrix,
          probeVector(probe),
        );
        const label = `${fixtureCase.id}/${probe.label}`;
        if (probe.expectNdcZ !== undefined) {
          near(transformed.z / transformed.w, probe.expectNdcZ, 1e-6, label);
        }
        if (probe.expectClip !== undefined) {
          const [x, y, z, w] = probe.expectClip;
          near(transformed.x, x, 1e-6, `${label}.x`);
          near(transformed.y, y, 1e-6, `${label}.y`);
          near(transformed.z, z, 1e-6, `${label}.z`);
          near(transformed.w, w, 1e-6, `${label}.w`);
        }
      }
    });
  }
});

describe("Quaternion order conformance fixture", () => {
  test("[ER-02-04] the fixture is well formed and unit length", () => {
    expect(quatFixture.formatVersion).toBe(1);
    expect(quatFixture.synthetic).toBe(true);
    const a = fixtureRotation(quatFixture.quaternions.a);
    const b = fixtureRotation(quatFixture.quaternions.b);
    near(quatLength(a), 1, 1e-12);
    near(quatLength(b), 1, 1e-12);
    expect(quatFixture.products).toHaveLength(2);
    const expressions = quatFixture.products.map(
      (product) => product.expression,
    );
    expect(expressions).toContain("a*b");
    expect(expressions).toContain("b*a");
    for (const product of quatFixture.products) {
      expect(product.expected).toHaveLength(4);
      expect(product.vectors.length).toBeGreaterThan(0);
    }
  });

  for (const product of quatFixture.products) {
    test(`[ER-02-04] fixture product ${product.id} (${product.expression}) matches its quaternion and vector images`, () => {
      const a = fixtureRotation(quatFixture.quaternions.a);
      const b = fixtureRotation(quatFixture.quaternions.b);
      if (product.expression !== "a*b" && product.expression !== "b*a") {
        throw new Error(`fixture ${product.id}: unknown expression`);
      }
      const aFirst = product.expression === "a*b";
      const actual = quatMultiply(
        quatCreate(),
        aFirst ? a : b,
        aFirst ? b : a,
      );
      const [x, y, z, w] = product.expected;
      near(actual.x, x, 1e-6, `${product.id}.x`);
      near(actual.y, y, 1e-6, `${product.id}.y`);
      near(actual.z, z, 1e-6, `${product.id}.z`);
      near(actual.w, w, 1e-6, `${product.id}.w`);
      const matrix = quatToMat4(mat4Create(), actual);
      for (const vector of product.vectors) {
        const [ix, iy, iz] = vector.input;
        const [ex, ey, ez] = vector.expect;
        const input = vec3Create(ix, iy, iz);
        const expected = vec3Create(ex, ey, ez);
        const byQuat = vec3Create();
        quatRotateVec3(byQuat, actual, input);
        expectVec3Close(byQuat, expected, 1e-6, `${product.id} quat`);
        const byMatrix = vec3Create();
        mat4TransformDirection(byMatrix, matrix, input);
        expectVec3Close(byMatrix, expected, 1e-6, `${product.id} matrix`);
      }
    });
  }
});
