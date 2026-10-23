/**
 * Shared helpers for the 02 math tests. Requirement tags live on each test,
 * not here.
 *
 * Fixtures are parsed with `JSON.parse`; the casts below are the unavoidable
 * boundary between untyped JSON and the typed fixture shapes (the fixtures are
 * repo-owned and synthetic).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as fc from "fast-check";
import { expect } from "vitest";
import type { Mat3, Mat4, Quat, Vec3 } from "../../src/math/index.js";

export const HERE = dirname(fileURLToPath(import.meta.url));

/** `noUncheckedIndexedAccess` guard for matrix element reads in tests. */
export function at(array: Float32Array, index: number): number {
  return array[index]!;
}

/** Mat4 element (row, column), column-major storage. */
export function m4(a: Mat4, row: number, column: number): number {
  return at(a.m, column * 4 + row);
}

/** Mat3 element (row, column), column-major storage. */
export function m3(a: Mat3, row: number, column: number): number {
  return at(a.m, column * 3 + row);
}

export function near(
  actual: number,
  expected: number,
  tolerance: number,
  label: string = "value",
): void {
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(tolerance);
}

/** Absolute tolerance, raised to a relative allowance for large magnitudes. */
export function nearRelative(
  actual: number,
  expected: number,
  absolute: number,
  relative: number,
  label: string = "value",
): void {
  const tolerance = Math.max(absolute, Math.abs(expected) * relative);
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(tolerance);
}

export function expectVec3Close(
  actual: Vec3,
  expected: Vec3,
  tolerance: number = 1e-5,
  label: string = "vec3",
): void {
  near(actual.x, expected.x, tolerance, `${label}.x`);
  near(actual.y, expected.y, tolerance, `${label}.y`);
  near(actual.z, expected.z, tolerance, `${label}.z`);
}

/** Accepts q and −q (the same rotation). */
export function expectQuatEquivalent(
  actual: Quat,
  expected: Quat,
  tolerance: number = 1e-5,
  label: string = "quat",
): void {
  const direct = Math.max(
    Math.abs(actual.x - expected.x),
    Math.abs(actual.y - expected.y),
    Math.abs(actual.z - expected.z),
    Math.abs(actual.w - expected.w),
  );
  const negated = Math.max(
    Math.abs(actual.x + expected.x),
    Math.abs(actual.y + expected.y),
    Math.abs(actual.z + expected.z),
    Math.abs(actual.w + expected.w),
  );
  expect(Math.min(direct, negated), label).toBeLessThanOrEqual(tolerance);
}

export interface ProjectionProbe {
  readonly label: string;
  readonly point: readonly [number, number, number, number];
  readonly expectNdcZ?: number;
  readonly expectClip?: readonly [number, number, number, number];
}

export interface ProjectionCase {
  readonly id: string;
  readonly fn: string;
  readonly argsOrder: readonly string[];
  readonly args: readonly (number | readonly [number, number, number])[];
  readonly expected: readonly number[];
  readonly probes: readonly ProjectionProbe[];
}

export interface ProjectionFixture {
  readonly formatVersion: number;
  readonly synthetic: boolean;
  readonly source: string;
  readonly note: string;
  readonly cases: readonly ProjectionCase[];
}

export interface FixtureQuat {
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export interface QuatProductCase {
  readonly id: string;
  readonly expression: string;
  readonly applies: string;
  readonly expected: readonly [number, number, number, number];
  readonly vectors: readonly {
    readonly input: readonly [number, number, number];
    readonly expect: readonly [number, number, number];
  }[];
}

export interface QuatOrderFixture {
  readonly formatVersion: number;
  readonly synthetic: boolean;
  readonly source: string;
  readonly convention: string;
  readonly note: string;
  readonly quaternions: { readonly a: FixtureQuat; readonly b: FixtureQuat };
  readonly products: readonly QuatProductCase[];
}

export function loadFixture<T>(fileName: string): T {
  const path = join(HERE, "..", "conformance", fileName);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const real = fc.double({
  min: -1000,
  max: 1000,
  noNaN: true,
  noDefaultInfinity: true,
});

const smallReal = fc.double({
  min: -8,
  max: 8,
  noNaN: true,
  noDefaultInfinity: true,
});

const unitComponent = fc.double({
  min: -1,
  max: 1,
  noNaN: true,
  noDefaultInfinity: true,
});

export function vec2Arb(): fc.Arbitrary<{ x: number; y: number }> {
  return fc.record({ x: real, y: real });
}

export function vec3Arb(): fc.Arbitrary<Vec3> {
  return fc.record({ x: real, y: real, z: real });
}

export function smallVec3Arb(): fc.Arbitrary<Vec3> {
  return fc.record({ x: smallReal, y: smallReal, z: smallReal });
}

export function vec4Arb(): fc.Arbitrary<{
  x: number;
  y: number;
  z: number;
  w: number;
}> {
  return fc.record({ x: real, y: real, z: real, w: real });
}

export function unitVec3Arb(): fc.Arbitrary<Vec3> {
  return fc
    .tuple(unitComponent, unitComponent, unitComponent)
    .filter(([x, y, z]) => x * x + y * y + z * z > 1e-4)
    .map(([x, y, z]) => {
      const length = Math.sqrt(x * x + y * y + z * z);
      return { x: x / length, y: y / length, z: z / length };
    });
}

export function unitQuatArb(): fc.Arbitrary<Quat> {
  return fc
    .tuple(unitComponent, unitComponent, unitComponent, unitComponent)
    .filter(([x, y, z, w]) => x * x + y * y + z * z + w * w > 1e-4)
    .map(([x, y, z, w]) => {
      const length = Math.sqrt(x * x + y * y + z * z + w * w);
      return { x: x / length, y: y / length, z: z / length, w: w / length };
    });
}

export function nonZeroQuatArb(): fc.Arbitrary<Quat> {
  return fc
    .tuple(real, real, real, real)
    .filter(([x, y, z, w]) => x * x + y * y + z * z + w * w > 1e-3)
    .map(([x, y, z, w]) => ({ x, y, z, w }));
}

/** Position, unit rotation, non-zero scale with an optionally negative x. */
export function trsArb(): fc.Arbitrary<{
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}> {
  return fc
    .tuple(
      smallVec3Arb(),
      unitQuatArb(),
      fc.tuple(
        fc.double({
          min: 0.1,
          max: 5,
          noNaN: true,
          noDefaultInfinity: true,
        }),
        fc.double({
          min: 0.1,
          max: 5,
          noNaN: true,
          noDefaultInfinity: true,
        }),
        fc.double({
          min: 0.1,
          max: 5,
          noNaN: true,
          noDefaultInfinity: true,
        }),
      ),
      fc.boolean(),
    )
    .map(([position, rotation, scale, flipX]) => ({
      position,
      rotation,
      scale: {
        x: flipX ? -scale[0] : scale[0],
        y: scale[1],
        z: scale[2],
      },
    }));
}
