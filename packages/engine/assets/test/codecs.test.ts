/**
 * ER-06-06: audio, font, JSON and material decoders.
 *
 * Every input is synthetic. Audio is sniffed and routed, never decoded; fonts
 * are WOFF2 passthrough or a JSON atlas; materials validate ranges and
 * texture references against the manifest lookup.
 */

import { describe, expect, test } from "vitest";
import type {
  AssetKind,
  AudioAssetData,
  FontAssetData,
  MaterialData,
} from "../src/contracts/assets.js";
import {
  AUDIO_STREAM_THRESHOLD_BYTES,
  AUDIO_STREAM_THRESHOLD_SECONDS,
  audioContainerFromUrl,
  audioMimeForContainer,
  decodeAudio,
  shouldStreamAudio,
  sniffAudioContainer,
  streamAudio,
} from "../src/codec/audio.js";
import { decodeFont, MAX_FONT_ATLAS_BYTES } from "../src/codec/font.js";
import { decodeJson, MAX_JSON_ASSET_BYTES, parseJsonValue } from "../src/codec/json.js";
import {
  decodeMaterial,
  MATERIAL_MIN_ROUGHNESS,
  MAX_MATERIAL_BYTES,
  readMaterialTextureReferences,
} from "../src/codec/material.js";
import { AssetEngineError } from "../src/errors.js";
import {
  arrayBufferOf,
  buildAudio,
  buildWoff2,
  catchError,
  expectCode,
  jsonBytes,
  textBytes,
} from "./helpers.js";

function messageOf(error: unknown): string {
  return error instanceof AssetEngineError ? error.message : String(error);
}

function asEncoded(value: AudioAssetData): Extract<AudioAssetData, { kind: "encoded" }> {
  if (value.kind !== "encoded") throw new Error("expected encoded audio");
  return value;
}

function asStream(value: AudioAssetData): Extract<AudioAssetData, { kind: "stream" }> {
  if (value.kind !== "stream") throw new Error("expected streamed audio");
  return value;
}

function asWoff2(value: FontAssetData): Extract<FontAssetData, { kind: "woff2" }> {
  if (value.kind !== "woff2") throw new Error("expected WOFF2");
  return value;
}

function asAtlas(value: FontAssetData): Extract<FontAssetData, { kind: "atlas" }> {
  if (value.kind !== "atlas") throw new Error("expected atlas");
  return value;
}

const TEXTURE_LOOKUP = (assetId: string): AssetKind | undefined =>
  assetId === "textures/albedo" ? "texture" : undefined;

function decodeMaterialDoc(
  document: unknown,
  id = "materials/m",
  lookupKind: (assetId: string) => AssetKind | undefined = TEXTURE_LOOKUP,
): MaterialData {
  return decodeMaterial({ id, bytes: jsonBytes(document), lookupKind });
}

/** Eight bytes that are neither WOFF2 nor an sfnt tag. */
function buildPngLikeBytes(): ArrayBuffer {
  return arrayBufferOf(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
}

describe("ER-06-06 audio", () => {
  test("ER-06-06 maps extensions to containers and MIME types", () => {
    expect(audioContainerFromUrl("assets/theme.ogg")).toBe("ogg");
    expect(audioContainerFromUrl("assets/theme.webm")).toBe("webm");
    expect(audioContainerFromUrl("assets/theme.mp4")).toBe("m4a");
    expect(audioContainerFromUrl("assets/theme.wav")).toBe("wav");
    expect(audioContainerFromUrl("assets/theme.bin")).toBeUndefined();
    expect(audioMimeForContainer("ogg")).toBe("audio/ogg");
    expect(audioMimeForContainer("webm")).toBe("audio/webm");
    expect(audioMimeForContainer("m4a")).toBe("audio/mp4");
    expect(audioMimeForContainer("wav")).toBe("audio/wav");
  });

  test("ER-06-06 sniffs all four audio containers", () => {
    expect(sniffAudioContainer("audio/a", buildAudio("ogg"))).toBe("ogg");
    expect(sniffAudioContainer("audio/a", buildAudio("webm"))).toBe("webm");
    expect(sniffAudioContainer("audio/a", buildAudio("wav"))).toBe("wav");
    expect(sniffAudioContainer("audio/a", buildAudio("m4a"))).toBe("m4a");
  });

  test("ER-06-06 rejects unrecognized or tiny audio signatures", () => {
    const unknown = new Uint8Array(16);
    unknown.set([0x00, 0x01, 0x02, 0x03]);
    expectCode(
      catchError(() => sniffAudioContainer("audio/a", unknown.buffer)),
      "E_ASSET_FORMAT",
    );
    expectCode(
      catchError(() => sniffAudioContainer("audio/a", new ArrayBuffer(8))),
      "E_ASSET_FORMAT",
    );
  });

  test("ER-06-06 applies the 30 s / 1 MiB stream thresholds", () => {
    expect(
      shouldStreamAudio(16, AUDIO_STREAM_THRESHOLD_SECONDS, undefined),
    ).toBe(false);
    expect(
      shouldStreamAudio(16, AUDIO_STREAM_THRESHOLD_SECONDS + 0.5, undefined),
    ).toBe(true);
    expect(
      shouldStreamAudio(AUDIO_STREAM_THRESHOLD_BYTES, undefined, undefined),
    ).toBe(false);
    expect(
      shouldStreamAudio(
        AUDIO_STREAM_THRESHOLD_BYTES + 1,
        undefined,
        undefined,
      ),
    ).toBe(true);
    expect(shouldStreamAudio(16, 600, true)).toBe(true);
    expect(shouldStreamAudio(10_000_000, 600, false)).toBe(false);
  });

  test("ER-06-06 passes short audio through as encoded bytes", () => {
    const bytes = buildAudio("ogg");
    const audio = asEncoded(
      decodeAudio({
        id: "audio/pin",
        url: "assets/pin.ogg",
        bytes,
        durationSeconds: 12.5,
      }),
    );
    expect(audio.bytes).toBe(bytes);
    expect(audio.mimeType).toBe("audio/ogg");
    expect(audio.durationSeconds).toBe(12.5);
    expect(audio.streaming).toBe(false);
  });

  test("ER-06-06 routes long audio to a stream", () => {
    const bytes = new ArrayBuffer(AUDIO_STREAM_THRESHOLD_BYTES + 1);
    new Uint8Array(bytes).set([0x4f, 0x67, 0x67, 0x53]);
    const stream = asStream(
      decodeAudio({ id: "audio/long", url: "assets/long.ogg", bytes }),
    );
    expect(stream.url).toBe("assets/long.ogg");
    expect(stream.mimeType).toBe("audio/ogg");
  });

  test("ER-06-06 honors explicit streaming overrides", () => {
    expect(
      asStream(
        decodeAudio({
          id: "audio/pin",
          url: "assets/pin.wav",
          bytes: buildAudio("wav"),
          streaming: true,
        }),
      ).kind,
    ).toBe("stream");
    const long = new ArrayBuffer(AUDIO_STREAM_THRESHOLD_BYTES + 1);
    new Uint8Array(long).set([0x4f, 0x67, 0x67, 0x53]);
    expect(
      asEncoded(
        decodeAudio({
          id: "audio/long",
          url: "assets/long.ogg",
          bytes: long,
          streaming: false,
        }),
      ).mimeType,
    ).toBe("audio/ogg");
  });

  test("ER-06-06 rejects contradictory container, MIME and extension hints", () => {
    const bytes = buildAudio("ogg");
    expectCode(
      catchError(() =>
        decodeAudio({ id: "audio/a", url: "assets/a.wav", bytes }),
      ),
      "E_ASSET_FORMAT",
    );
    expectCode(
      catchError(() =>
        decodeAudio({
          id: "audio/a",
          url: "assets/a.ogg",
          bytes,
          mimeType: "audio/wav",
        }),
      ),
      "E_ASSET_FORMAT",
    );
    expectCode(
      catchError(() =>
        decodeAudio({
          id: "audio/a",
          url: "assets/a.ogg",
          bytes,
          container: "wav",
        }),
      ),
      "E_ASSET_FORMAT",
    );
  });

  test("ER-06-06 builds a stream result without bytes", () => {
    const stream = asStream(
      streamAudio({ id: "audio/music", url: "assets/music.ogg" }),
    );
    expect(stream.mimeType).toBe("audio/ogg");
    expect("bytes" in stream).toBe(false);
    expect(
      asStream(
        streamAudio({
          id: "audio/music",
          url: "assets/music.ogg",
          durationSeconds: 120,
        }),
      ).durationSeconds,
    ).toBe(120);
    expectCode(
      catchError(() => streamAudio({ id: "audio/x", url: "assets/x" })),
      "E_ASSET_FORMAT",
    );
    expectCode(
      catchError(() =>
        streamAudio({
          id: "audio/x",
          url: "assets/x.wav",
          container: "ogg",
        }),
      ),
      "E_ASSET_FORMAT",
    );
  });
});

describe("ER-06-06 fonts", () => {
  test("ER-06-06 passes a valid WOFF2 container through", () => {
    const bytes = buildWoff2();
    const font = asWoff2(decodeFont({ id: "fonts/ui", bytes }));
    expect(font.bytes).toBe(bytes);
    expect(
      asWoff2(decodeFont({ id: "fonts/ui", bytes, container: "woff2" })).kind,
    ).toBe("woff2");
  });

  test("ER-06-06 rejects truncated, mismatched and collection WOFF2", () => {
    expectCode(
      catchError(() =>
        decodeFont({
          id: "fonts/ui",
          bytes: arrayBufferOf(new Uint8Array([0x77, 0x4f, 0x46, 0x32])),
        }),
      ),
      "E_ASSET_FORMAT",
    );

    const mismatched = buildWoff2(52);
    new DataView(mismatched).setUint32(8, 48, false);
    expectCode(
      catchError(() => decodeFont({ id: "fonts/ui", bytes: mismatched })),
      "E_ASSET_FORMAT",
    );

    const collection = buildWoff2();
    new DataView(collection).setUint32(4, 0x74746366, false);
    expectCode(
      catchError(() => decodeFont({ id: "fonts/ui", bytes: collection })),
      "E_ASSET_FORMAT",
    );

    const noTables = buildWoff2();
    new DataView(noTables).setUint16(12, 0, false);
    expectCode(
      catchError(() => decodeFont({ id: "fonts/ui", bytes: noTables })),
      "E_ASSET_FORMAT",
    );
  });

  test("ER-06-06 rejects TTF/OTF and a forced WOFF2 hint on other bytes", () => {
    const ttf = arrayBufferOf(
      new Uint8Array([0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0]),
    );
    const ttfError = catchError(() =>
      decodeFont({ id: "fonts/ui", bytes: ttf }),
    );
    expectCode(ttfError, "E_ASSET_FORMAT");
    expect(messageOf(ttfError)).toContain("TTF/OTF");

    expectCode(
      catchError(() =>
        decodeFont({
          id: "fonts/ui",
          bytes: buildPngLikeBytes(),
          container: "woff2",
        }),
      ),
      "E_ASSET_FORMAT",
    );
  });

  test("ER-06-06 parses a JSON atlas and strips a BOM", () => {
    const atlas = asAtlas(
      decodeFont({
        id: "fonts/atlas",
        bytes: textBytes('﻿{"pages":["ui.png"],"size":32}'),
      }),
    );
    expect(atlas.json).toEqual({ pages: ["ui.png"], size: 32 });
  });

  test("ER-06-06 rejects invalid, non-UTF-8 and oversized atlases", () => {
    expectCode(
      catchError(() =>
        decodeFont({ id: "fonts/atlas", bytes: textBytes("{") }),
      ),
      "E_ASSET_FORMAT",
    );
    expectCode(
      catchError(() =>
        decodeFont({
          id: "fonts/atlas",
          bytes: arrayBufferOf(new Uint8Array([0x7b, 0xc3, 0x28, 0x7d])),
        }),
      ),
      "E_ASSET_FORMAT",
    );
    expectCode(
      catchError(() =>
        decodeFont({
          id: "fonts/atlas",
          bytes: new ArrayBuffer(MAX_FONT_ATLAS_BYTES + 1),
        }),
      ),
      "E_ASSET_FORMAT",
    );
  });
});

describe("ER-06-06 JSON", () => {
  test("ER-06-06 parses any JSON value and strips a BOM", () => {
    expect(parseJsonValue("data/a", textBytes('{"a":1}'))).toEqual({ a: 1 });
    expect(parseJsonValue("data/a", textBytes("[1,2,3]"))).toEqual([1, 2, 3]);
    expect(parseJsonValue("data/a", textBytes("null"))).toBeNull();
    expect(parseJsonValue("data/a", textBytes("﻿true"))).toBe(true);
    expect(decodeJson({ id: "data/a", bytes: textBytes('{"a":1}') })).toEqual({
      json: { a: 1 },
    });
  });

  test("ER-06-06 rejects invalid JSON, invalid UTF-8 and oversize JSON", () => {
    expectCode(
      catchError(() => parseJsonValue("data/a", textBytes("{"))),
      "E_ASSET_FORMAT",
    );
    expectCode(
      catchError(() =>
        parseJsonValue(
          "data/a",
          arrayBufferOf(new Uint8Array([0x7b, 0xc3, 0x28, 0x7d])),
        ),
      ),
      "E_ASSET_FORMAT",
    );
    expectCode(
      catchError(() =>
        parseJsonValue("data/a", new ArrayBuffer(MAX_JSON_ASSET_BYTES + 1)),
      ),
      "E_ASSET_FORMAT",
    );
  });

  test("ER-06-06 parses __proto__ as data and never merges prototypes", () => {
    const value = parseJsonValue(
      "data/a",
      textBytes('{"__proto__":{"polluted":true},"ok":1}'),
    ) as Record<string, unknown>;
    expect(value["ok"]).toBe(1);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("ER-06-06 materials", () => {
  test("ER-06-06 applies material defaults", () => {
    expect(
      decodeMaterialDoc({ formatVersion: 1, id: "materials/m" }),
    ).toEqual({
      formatVersion: 1,
      id: "materials/m",
      baseColorFactor: [1, 1, 1, 1],
      metallic: 1,
      roughness: 1,
      emissiveFactor: [0, 0, 0],
      baseColorTexture: null,
      metallicRoughnessTexture: null,
      normalTexture: null,
      normalScale: 1,
      occlusionTexture: null,
      occlusionStrength: 1,
      emissiveTexture: null,
      alphaMode: "opaque",
      alphaCutoff: 0.5,
      doubleSided: false,
      unlit: false,
    });
  });

  test("ER-06-06 clamps material ranges", () => {
    const material = decodeMaterialDoc({
      formatVersion: 1,
      id: "materials/m",
      baseColorFactor: [2, -1, 0.5, 3],
      emissiveFactor: [-2, 1.5, 0.25],
      metallic: -3,
      roughness: 0,
      normalScale: 3,
      occlusionStrength: 4,
      alphaCutoff: -1,
    });
    expect(material.baseColorFactor).toEqual([1, 0, 0.5, 1]);
    expect(material.emissiveFactor).toEqual([0, 1, 0.25]);
    expect(material.metallic).toBe(0);
    expect(material.roughness).toBe(MATERIAL_MIN_ROUGHNESS);
    // normalScale is not clamped by the material schema.
    expect(material.normalScale).toBe(3);
    expect(material.occlusionStrength).toBe(1);
    expect(material.alphaCutoff).toBe(0);

    expect(
      decodeMaterialDoc({
        formatVersion: 1,
        id: "materials/m",
        roughness: 9,
        metallic: 9,
      }).roughness,
    ).toBe(1);
  });

  test("ER-06-06 keeps texture ids that resolve to texture assets", () => {
    const material = decodeMaterialDoc({
      formatVersion: 1,
      id: "materials/m",
      baseColorTexture: "textures/albedo",
      normalTexture: "textures/albedo",
      occlusionTexture: null,
    });
    expect(material.baseColorTexture).toBe("textures/albedo");
    expect(material.normalTexture).toBe("textures/albedo");
    expect(material.occlusionTexture).toBeNull();
  });

  test("ER-06-06 rejects texture ids of the wrong kind or unknown", () => {
    const wrongKind = catchError(() =>
      decodeMaterialDoc(
        {
          formatVersion: 1,
          id: "materials/m",
          baseColorTexture: "textures/albedo",
        },
        "materials/m",
        () => "mesh",
      ),
    );
    expectCode(wrongKind, "E_ASSET_FORMAT");
    expect(messageOf(wrongKind)).toContain("not a texture asset");

    const unknown = catchError(() =>
      decodeMaterialDoc(
        {
          formatVersion: 1,
          id: "materials/m",
          normalTexture: "textures/missing",
        },
        "materials/m",
        () => undefined,
      ),
    );
    expectCode(unknown, "E_ASSET_FORMAT");
  });

  test("ER-06-06 rejects structural material errors", () => {
    const cases: readonly unknown[] = [
      { formatVersion: 2, id: "materials/m" },
      { formatVersion: 1, id: "materials/other" },
      { formatVersion: 1, id: "materials/m", alphaMode: "translucent" },
      { formatVersion: 1, id: "materials/m", baseColorFactor: [1, 1, 1] },
      { formatVersion: 1, id: "materials/m", metallic: "high" },
      { formatVersion: 1, id: "materials/m", baseColorTexture: "" },
      { formatVersion: 1, id: "materials/m", doubleSided: "yes" },
      [],
    ];
    for (const document of cases) {
      expectCode(catchError(() => decodeMaterialDoc(document)), "E_ASSET_FORMAT");
    }
  });

  test("ER-06-06 lists material texture references without full validation", () => {
    const references = readMaterialTextureReferences(
      "materials/m",
      jsonBytes({
        baseColorTexture: "textures/a",
        normalTexture: null,
        metallicRoughnessTexture: "textures/b",
        emissiveTexture: "",
        occlusionTexture: 7,
      }),
    );
    expect(references).toEqual(["textures/a", "textures/b"]);
    expectCode(
      catchError(() =>
        readMaterialTextureReferences("materials/m", textBytes("[]")),
      ),
      "E_ASSET_FORMAT",
    );
  });

  test("ER-06-06 rejects oversized material documents", () => {
    expectCode(
      catchError(() =>
        readMaterialTextureReferences(
          "materials/m",
          new ArrayBuffer(MAX_MATERIAL_BYTES + 1),
        ),
      ),
      "E_ASSET_FORMAT",
    );
    expectCode(
      catchError(() =>
        decodeMaterial({
          id: "materials/m",
          bytes: new ArrayBuffer(MAX_MATERIAL_BYTES + 1),
          lookupKind: TEXTURE_LOOKUP,
        }),
      ),
      "E_ASSET_FORMAT",
    );
  });
});
