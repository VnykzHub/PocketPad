/**
 * ER-06-03: GLB subset decode against synthetic buffers.
 *
 * The accepted set is one mesh, 1-8 triangle primitives, an embedded BIN
 * chunk, POSITION/NORMAL/TEXCOORD_0 float32 and uint16/uint32 indices.
 */

import { describe, expect, test } from "vitest";
import { decodeGlb } from "../src/codec/glb.js";
import { AssetEngineError } from "../src/errors.js";
import { buildTriangleGlb, catchError, expectCode } from "./helpers.js";

function decode(bytes: ArrayBuffer): ReturnType<typeof decodeGlb> {
  return decodeGlb("meshes/tri", bytes);
}

describe("ER-06-03 GLB decode", () => {
  test("ER-06-03 decodes a stride-32 triangle into one primitive", () => {
    const decoded = decode(buildTriangleGlb());
    expect(decoded.droppedAttributes).toBe(0);
    expect(decoded.mesh.formatVersion).toBe(1);
    expect(decoded.mesh.id).toBe("meshes/tri");
    expect(decoded.mesh.materialNames).toEqual(["body"]);
    expect(decoded.mesh.primitives).toHaveLength(1);
    const primitive = decoded.mesh.primitives[0];
    expect(primitive?.vertexCount).toBe(3);
    expect(primitive?.indexCount).toBe(3);
    expect(primitive?.indexFormat).toBe("uint16");
    expect(primitive?.materialSlot).toBe(0);
    expect(Array.from(primitive?.indices ?? [])).toEqual([0, 1, 2]);
    expect(primitive?.vertices.byteLength).toBe(3 * 8 * 4);
    const vertices = primitive?.vertices ?? new Float32Array(0);
    expect(Array.from(vertices.slice(0, 8))).toEqual([
      0, 0, 0, 0, 0, 1, 0, 0,
    ]);
    expect(Array.from(vertices.slice(8, 16))).toEqual([
      1, 0, 0, 0, 0, 1, 1, 0,
    ]);
    expect(decoded.mesh.bounds.radius).toBeGreaterThan(0);
    expect(decoded.mesh.bounds.center).toEqual({ x: 0.5, y: 0.5, z: 0 });
  });

  test("ER-06-03 drops and counts TANGENT without changing strides", () => {
    const decoded = decode(buildTriangleGlb({ tangent: true }));
    expect(decoded.droppedAttributes).toBe(1);
    expect(decoded.mesh.primitives[0]?.vertexCount).toBe(3);
  });

  test("ER-06-03 rejects an external buffer URI", () => {
    const error = catchError(() =>
      decode(buildTriangleGlb({ externalBuffer: true })),
    );
    expectCode(error, "E_ASSET_FORMAT");
    expect((error as AssetEngineError).message).toContain("external buffers");
  });

  test("ER-06-03 rejects a missing NORMAL attribute", () => {
    const error = catchError(() =>
      decode(buildTriangleGlb({ omitNormal: true })),
    );
    expectCode(error, "E_ASSET_FORMAT");
    expect((error as AssetEngineError).message).toContain("NORMAL is required");
  });

  test("ER-06-03 rejects an index at or beyond the vertex count", () => {
    const error = catchError(() => decode(buildTriangleGlb({ badIndex: true })));
    expectCode(error, "E_ASSET_FORMAT");
    expect((error as AssetEngineError).message).toContain(
      "index is larger than the vertex count",
    );
  });

  test("ER-06-03 rejects a bad container magic", () => {
    const bytes = buildTriangleGlb();
    new DataView(bytes).setUint32(0, 0x00000000, true);
    const error = catchError(() => decode(bytes));
    expectCode(error, "E_ASSET_FORMAT");
    expect((error as AssetEngineError).message).toContain("magic");
  });

  test("ER-06-03 rejects a length field that disagrees with the buffer", () => {
    const bytes = buildTriangleGlb();
    new DataView(bytes).setUint32(8, bytes.byteLength + 4, true);
    const error = catchError(() => decode(bytes));
    expectCode(error, "E_ASSET_FORMAT");
    expect((error as AssetEngineError).message).toContain("length");
  });

  test("ER-06-03 rejects a truncated GLB", () => {
    const error = catchError(() => decode(new ArrayBuffer(8)));
    expectCode(error, "E_ASSET_FORMAT");
    expect((error as AssetEngineError).message).toContain("too small");
  });
});
