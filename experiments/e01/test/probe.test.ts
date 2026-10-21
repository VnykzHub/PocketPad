import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INPUT_FWD_TYPE,
  INPUT_TYPE,
  classifyCompressedExtensions,
  decodeInputFwdFrame,
  e1TvOnlyViable,
  encodeProbeInput,
  measureAnimationFrameRate,
  probeWebSocketUrl,
  summarizeFrameIntervals,
} from "../probe.js";

function readSource(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

describe("[E1] binary WebSocket frame helpers", () => {
  it("[E1] encodes a 26-byte Input frame and decodes the 27-byte InputFwd echo", () => {
    const input = encodeProbeInput(0x01020304, 0x0001, 0x0001);
    expect(input).toBeInstanceOf(Uint8Array);
    expect(input.byteLength).toBe(26);
    expect(input[0]).toBe(INPUT_TYPE);

    const inputView = new DataView(input.buffer);
    expect(inputView.getUint32(1, true)).toBe(0x01020304);
    expect(inputView.getUint16(5, true)).toBe(0x0001);
    expect(inputView.getUint16(7, true)).toBe(0x0001);

    const echo = new Uint8Array(27);
    echo[0] = INPUT_FWD_TYPE;
    echo[1] = 3;
    echo.set(input.subarray(1), 2);

    expect(decodeInputFwdFrame(echo)).toEqual({
      slot: 3,
      tick: 0x01020304,
      buttons: 0x0001,
      edges: 0x0001,
      byteLength: 27,
    });
  });

  it("[E1] rejects malformed InputFwd echoes with a readable error", () => {
    const valid = new Uint8Array(27);
    valid[0] = INPUT_FWD_TYPE;
    valid[1] = 1;

    expect(() => decodeInputFwdFrame(new Uint8Array(26))).toThrow(/expected 27/);

    const wrongType = valid.slice();
    wrongType[0] = INPUT_TYPE;
    expect(() => decodeInputFwdFrame(wrongType)).toThrow(/type byte/);

    const wrongSlot = valid.slice();
    wrongSlot[1] = 9;
    expect(() => decodeInputFwdFrame(wrongSlot)).toThrow(/slot 9/);
  });

  it("[E1] derives the same-origin /ws URL from the page location", () => {
    expect(probeWebSocketUrl({ protocol: "http:", host: "192.168.1.5:8080" })).toBe(
      "ws://192.168.1.5:8080/ws",
    );
    expect(probeWebSocketUrl({ protocol: "https:", host: "example.test" })).toBe(
      "wss://example.test/ws",
    );
    expect(() => probeWebSocketUrl({ protocol: "file:", host: "" })).toThrow(/dev server/);
  });
});

describe("[E1] WebGL2 capability", () => {
  it("[E1][FR-12.1] WebGL2 presence is detected without UA sniffing", () => {
    const pageSource = readSource("page.ts");
    expect(pageSource).toContain("detectWebGL2");
    expect(pageSource).toContain('id: "webgl2"');
    expect(readSource("probe.ts")).not.toMatch(/userAgent/i);
    expect(pageSource.match(/userAgent/g) ?? []).toHaveLength(1);
  });
});

describe("[E1] compressed texture extensions", () => {
  it("[E1] compressed texture extensions are listed exactly", () => {
    const support = classifyCompressedExtensions([
      "WEBGL_compressed_texture_astc",
      "WEBGL_compressed_texture_etc",
      "WEBGL_compressed_texture_s3tc",
      "EXT_texture_compression_bptc",
      "EXT_color_buffer_float",
    ]);

    expect(support).toEqual({
      astc: true,
      etc: true,
      etc1: false,
      s3tc: true,
      bptc: true,
      extensions: [
        "WEBGL_compressed_texture_astc",
        "WEBGL_compressed_texture_etc",
        "WEBGL_compressed_texture_s3tc",
        "EXT_texture_compression_bptc",
      ],
    });
    // KTX2 is not a WebGL extension and is never inferred from ASTC.
    expect("ktx2" in support).toBe(false);
  });

  it("[E1] ASTC alone does not imply ETC, ETC1, S3TC or BPTC", () => {
    const support = classifyCompressedExtensions(["WEBGL_compressed_texture_astc"]);
    expect(support.astc).toBe(true);
    expect(support.etc).toBe(false);
    expect(support.etc1).toBe(false);
    expect(support.s3tc).toBe(false);
    expect(support.bptc).toBe(false);
  });
});

describe("[E1] requestAnimationFrame rate", () => {
  it("[E1] summarizes the mean interval and converts it to Hz", () => {
    const summary = summarizeFrameIntervals([16, 17, 15]);
    expect(summary.frames).toBe(3);
    expect(summary.meanIntervalMs).toBe(16);
    expect(summary.hz).toBe(62.5);
    expect(summary.minIntervalMs).toBe(15);
    expect(summary.maxIntervalMs).toBe(17);
  });

  it("[E1] measures 120 intervals through an injected requestAnimationFrame", async () => {
    let timestamp = 0;
    const summary = await measureAnimationFrameRate(
      (callback) => {
        timestamp += 16;
        queueMicrotask(() => callback(timestamp));
        return 1;
      },
      120,
      3000,
    );

    expect(summary.frames).toBe(120);
    expect(summary.meanIntervalMs).toBe(16);
    expect(summary.hz).toBe(62.5);
  });

  it("[E1] turns a stalled requestAnimationFrame into a readable error", async () => {
    await expect(measureAnimationFrameRate(() => 1, 2, 20)).rejects.toThrow(
      /keep the tab visible/,
    );
  });
});

describe("[FR-12.1] capability probe uses feature detection", () => {
  it("[FR-12.1] capability helpers never read the user agent", () => {
    const probeSource = readSource("probe.ts");
    expect(probeSource).not.toMatch(/userAgent|navigator\.platform/i);
  });

  it("[FR-12.1] the page records the UA once and never branches on it", () => {
    const pageSource = readSource("page.ts");
    expect(pageSource.match(/userAgent/g) ?? []).toHaveLength(1);
    expect(pageSource).toMatch(/id: "user-agent"/);
    expect(pageSource).not.toMatch(/\bif\b[^\n]*userAgent/i);
    expect(pageSource).not.toMatch(/userAgent[^\n]*(?:===|!==|&&|\|\||\?)/);
  });

  it("[FR-12.1] checks call the feature detectors instead of parsing the UA", () => {
    const pageSource = readSource("page.ts");
    for (const helper of [
      "detectWebGL2",
      "detectWebRTC",
      "detectWakeLock",
      "detectDeviceMemory",
      "detectHardwareConcurrency",
      "detectAudioContext",
    ]) {
      expect(pageSource).toContain(helper);
    }
  });
});

describe("[G6] TV-only viability", () => {
  it("[G6] TV-only viability is recorded from WebGL2 and binary WebSocket", () => {
    expect(e1TvOnlyViable(true, true)).toBe(true);
    expect(e1TvOnlyViable(false, true)).toBe(false);
    expect(e1TvOnlyViable(true, false)).toBe(false);
    expect(e1TvOnlyViable(false, false)).toBe(false);
  });

  it("[G6] the page records the criterion in a dedicated check", () => {
    const pageSource = readSource("page.ts");
    expect(pageSource).toContain('id: "tv-only-criterion"');
    expect(pageSource).toContain("e1TvOnlyViable");
    expect(pageSource).toContain("WebGL2 and binary WebSocket both present");
  });
});

describe("[SR-7] E1 probe stays on the dev-server origin", () => {
  it("[SR-7] the probe only creates a room through /api/rooms and derives the socket URL from location", () => {
    const probeSource = readSource("probe.ts");
    expect(probeSource).toContain('"/api/rooms"');
    expect(probeSource).not.toMatch(/XMLHttpRequest|sendBeacon|EventSource/);
    expect(probeSource).not.toMatch(/["'`]https?:\/\//);
    expect(probeSource).toContain("location.host");
    expect(probeSource).not.toMatch(/["'`]wss?:\/\//);
  });
});
