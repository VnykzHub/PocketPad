/**
 * W0 contract checks for `@lanpad/engine-core`.
 *
 * These tests assert the declared surface (names, shapes, literal versions)
 * and synthetic fixture values derived from the specs. They do not import or
 * exercise an implementation: the package has none in W0.
 *
 * Requirement tags are intentionally absent: `TRACEABILITY.md` has no ER-*
 * rows yet (REVIEW.md RV-09), so a tag would not resolve.
 */
import { expect, expectTypeOf, test } from "vitest";
import type {
  Entity,
  Frustum,
  Mat4,
  RenderDevice,
  RenderDeviceOptions,
  SaveHeaderFields,
} from "../src/index";
import {
  ENGINE_VERSION,
  RENDERER_ABI_VERSION,
  SHADER_ABI_VERSION,
} from "../src/index";
import { ERROR_CODES, ERROR_CODES_ARE_COMPLETE } from "./errorCodes";

test("ENGINE_VERSION runtime value is the frozen 0.1.0 literal", () => {
  expect(ENGINE_VERSION).toBe("0.1.0");
  expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  expectTypeOf(ENGINE_VERSION).toEqualTypeOf<"0.1.0">();

  type DeclaredVersion =
    typeof import("../src/contracts/engine").ENGINE_VERSION;
  expectTypeOf<DeclaredVersion>().toEqualTypeOf<"0.1.0">();
});

test("renderer and shader ABI constants are 1 at runtime and in the contract", () => {
  expect(RENDERER_ABI_VERSION).toBe(1);
  expect(SHADER_ABI_VERSION).toBe(1);

  type DeclaredRendererAbi =
    typeof import("../src/contracts/render-device").RENDERER_ABI_VERSION;
  type DeclaredShaderAbi =
    typeof import("../src/contracts/render-device").SHADER_ABI_VERSION;
  expectTypeOf<DeclaredRendererAbi>().toEqualTypeOf<1>();
  expectTypeOf<DeclaredShaderAbi>().toEqualTypeOf<1>();
});

test("every declared error code is a well-formed, unique string", () => {
  const codes: readonly string[] = ERROR_CODES;

  expect(ERROR_CODES_ARE_COMPLETE).toBe(true);
  expect(new Set(codes).size).toBe(codes.length);
  for (const code of codes) {
    expect(typeof code).toBe("string");
    expect(code).toMatch(/^E_[A-Z][A-Z0-9_]*$/);
  }
});

test("the six save error codes and the two additive codes are declared", () => {
  for (const code of [
    "E_SAVE_FORMAT",
    "E_SAVE_VERSION",
    "E_SAVE_HASH",
    "E_SAVE_GAME",
    "E_SAVE_QUOTA",
    "E_SAVE_IO",
  ] as const) {
    expect(ERROR_CODES).toContain(code);
  }
  // Additive codes referenced by 03 and 04 but missing from 00 §5.9.
  expect(ERROR_CODES).toContain("E_SCENE_FORMAT");
  expect(ERROR_CODES).toContain("E_FRAME_CLOSED");
});

// Synthetic header values only. The timestamp is integer epoch seconds, not
// simulation time and not a date string (00 §3.5).
const SAVE_HEADER = {
  formatVersion: 1,
  engineMajor: 0,
  engineMinor: 1,
  enginePatch: 0,
  gameId: "synthetic-game",
  gameVersion: "0.0.1",
  createdAtUnixSeconds: 1_700_000_000,
  payloadBytes: 1024,
  payloadUncompressedBytes: 0,
  payloadHash: 0x1a2b3c4d,
  flags: 0,
} satisfies SaveHeaderFields;

test("SaveHeaderFields keeps the frozen 00 §3.5 field list", () => {
  expectTypeOf<keyof SaveHeaderFields>().toEqualTypeOf<
    | "formatVersion"
    | "engineMajor"
    | "engineMinor"
    | "enginePatch"
    | "gameId"
    | "gameVersion"
    | "createdAtUnixSeconds"
    | "payloadBytes"
    | "payloadUncompressedBytes"
    | "payloadHash"
    | "flags"
  >();

  expect(Object.keys(SAVE_HEADER).sort()).toEqual(
    [
      "createdAtUnixSeconds",
      "engineMajor",
      "engineMinor",
      "enginePatch",
      "flags",
      "formatVersion",
      "gameId",
      "gameVersion",
      "payloadBytes",
      "payloadHash",
      "payloadUncompressedBytes",
    ].sort(),
  );
});

test("SaveHeader fixture uses version 1, epoch seconds and a u32 hash", () => {
  expect(SAVE_HEADER.formatVersion).toBe(1);
  expect(Number.isInteger(SAVE_HEADER.createdAtUnixSeconds)).toBe(true);
  expect(SAVE_HEADER.createdAtUnixSeconds).toBeGreaterThan(0);
  expect(
    new Date(SAVE_HEADER.createdAtUnixSeconds * 1000).getUTCFullYear(),
  ).toBe(2023);
  expect(SAVE_HEADER.payloadHash).toBeGreaterThanOrEqual(0);
  expect(SAVE_HEADER.payloadHash).toBeLessThanOrEqual(0xffffffff);
  expect(SAVE_HEADER.flags).toBe(0);
  expect(SAVE_HEADER.payloadBytes).toBeGreaterThanOrEqual(0);
});

test("both projection families exist with the 02 §3.6 signatures", () => {
  type WebGL2 = typeof import("../src/contracts/math").mat4PerspectiveWebGL2;
  type WebGPU = typeof import("../src/contracts/math").mat4PerspectiveWebGPU;
  type Expected = (
    out: Mat4,
    fovY: number,
    aspect: number,
    near: number,
    far: number,
  ) => Mat4;

  expectTypeOf<WebGL2>().toEqualTypeOf<Expected>();
  expectTypeOf<WebGPU>().toEqualTypeOf<Expected>();
});

test("frustum extraction selects the near plane by clip convention", () => {
  type Extract = typeof import("../src/contracts/math").frustumFromViewProjection;
  type Clip = Parameters<Extract>[2];

  expectTypeOf<Clip>().toEqualTypeOf<"webgl" | "webgpu">();
  expectTypeOf<Extract>().returns.toEqualTypeOf<Frustum>();
});

test("Entity handles are id plus generation", () => {
  expectTypeOf<Entity>().toEqualTypeOf<{
    readonly id: number;
    readonly generation: number;
  }>();
});

test("RenderDevice exposes the additive 04 initialization options", () => {
  type InitOptions = Parameters<RenderDevice["init"]>[1];

  expectTypeOf<InitOptions>().toEqualTypeOf<
    RenderDeviceOptions | undefined
  >();
  expectTypeOf<RenderDevice["stats"]>().not.toBeAny();
});
