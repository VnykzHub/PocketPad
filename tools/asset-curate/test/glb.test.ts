import { describe, expect, test } from "vitest";
import { GlbParseError, isSafeGlbUri, parseGlb } from "../src/glb.js";

function makeGlb(json: unknown): Buffer {
  const text = Buffer.from(JSON.stringify(json), "utf8");
  const padded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + padded.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, padded]);
}

const VALID_JSON = {
  asset: { version: "2.0", generator: "test-exporter" },
  meshes: [{}, {}],
  skins: [{}],
  animations: [{ name: "Idle_Loop" }, { name: "Walk_Loop" }, { name: "" }],
  images: [{ uri: "Textures/colormap.png" }],
  buffers: [{ uri: "mesh.bin" }],
};

describe("GLB container reader", () => {
  test("[ER-23-01] parseGlb lists animations, external images and buffers", () => {
    const info = parseGlb(makeGlb(VALID_JSON));

    expect(info.generator).toBe("test-exporter");
    expect(info.animations).toEqual(["Idle_Loop", "Walk_Loop"]);
    expect(info.images).toEqual(["Textures/colormap.png"]);
    expect(info.buffers).toEqual(["mesh.bin"]);
    expect(info.skins).toBe(1);
    expect(info.meshes).toBe(2);
  });

  test("[ER-23-01] parseGlb rejects a bad header, version, length and chunk type", () => {
    const badMagic = makeGlb(VALID_JSON);
    badMagic.writeUInt32LE(0, 0);
    expect(() => parseGlb(badMagic)).toThrow(/bad GLB magic/);

    const badVersion = makeGlb(VALID_JSON);
    badVersion.writeUInt32LE(1, 4);
    expect(() => parseGlb(badVersion)).toThrow(/unsupported GLB version 1/);

    const badLength = makeGlb(VALID_JSON);
    badLength.writeUInt32LE(badLength.length + 4, 8);
    expect(() => parseGlb(badLength)).toThrow(/declared length .* does not match file length/);

    const badChunk = makeGlb(VALID_JSON);
    badChunk.writeUInt32LE(0x12345678, 16);
    expect(() => parseGlb(badChunk)).toThrow(/first chunk is not JSON/);

    expect(() => parseGlb(Buffer.alloc(10))).toThrow(GlbParseError);
  });

  test("[ER-23-01] parseGlb rejects invalid JSON and unsafe external URIs", () => {
    const text = Buffer.from("{not json", "utf8");
    const padded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
    const invalidJson = makeGlb(VALID_JSON);
    invalidJson.writeUInt32LE(padded.length, 12);
    invalidJson.writeUInt32LE(20 + padded.length, 8);
    const rebuilt = Buffer.concat([invalidJson.subarray(0, 20), padded]);
    expect(() => parseGlb(rebuilt)).toThrow(/JSON chunk is not valid JSON/);

    expect(() => parseGlb(makeGlb({ images: [{ uri: "https://example.com/a.png" }] }))).toThrow(
      /unsafe image uri/,
    );
    expect(() => parseGlb(makeGlb({ buffers: [{ uri: "../mesh.bin" }] }))).toThrow(/unsafe buffer uri/);
  });
});

describe("GLB dependency path safety", () => {
  test("[ER-23-01] isSafeGlbUri accepts relative paths and rejects escapes and URLs", () => {
    expect(isSafeGlbUri("Textures/colormap.png")).toBe(true);
    expect(isSafeGlbUri("a/b/c.bin")).toBe(true);
    expect(isSafeGlbUri("")).toBe(false);
    expect(isSafeGlbUri("/absolute.png")).toBe(false);
    expect(isSafeGlbUri("trailing/")).toBe(false);
    expect(isSafeGlbUri("back\\slash.png")).toBe(false);
    expect(isSafeGlbUri("https://example.com/a.png")).toBe(false);
    expect(isSafeGlbUri("C:/textures/a.png")).toBe(false);
    expect(isSafeGlbUri("Textures/../escape.png")).toBe(false);
    expect(isSafeGlbUri("./Textures/a.png")).toBe(false);
    expect(isSafeGlbUri("Textures//empty.png")).toBe(false);
  });
});
