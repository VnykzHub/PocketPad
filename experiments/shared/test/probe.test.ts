import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  detectAudioContext,
  detectBinaryWebSocket,
  detectDeviceMemory,
  detectHardwareConcurrency,
  detectWakeLock,
  detectWebGL2,
  detectWebRTC,
  detectWebSocket,
  runChecks,
} from "../probe.js";

function readShared(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

describe("[FR-12.1] capability detection uses features, not the user agent", () => {
  it("[FR-12.1] reads WebGL2 limits from a context obtained by feature detection", () => {
    const fakeCanvas = {
      getContext(contextId: string): unknown {
        if (contextId !== "webgl2") return null;
        return {
          MAX_TEXTURE_SIZE: 0x0d33,
          getParameter(parameter: number): unknown {
            return parameter === 0x0d33 ? 8192 : null;
          },
          getSupportedExtensions(): string[] {
            return ["WEBGL_compressed_texture_etc"];
          },
          getContextAttributes(): WebGLContextAttributes {
            return { alpha: false, antialias: true };
          },
        };
      },
    };

    const info = detectWebGL2(fakeCanvas);
    expect(info.supported).toBe(true);
    expect(info.maxTextureSize).toBe(8192);
    expect(info.extensions).toContain("WEBGL_compressed_texture_etc");
    expect(info.contextAttributes?.alpha).toBe(false);
  });

  it("[FR-12.1] reports a readable WebGL2 failure when context creation throws", () => {
    const brokenCanvas = {
      getContext(): unknown {
        throw new Error("simulated WebGL2 context failure");
      },
    };

    expect(() => detectWebGL2(brokenCanvas)).toThrow(
      /WebGL2 context creation threw: simulated WebGL2 context failure/,
    );
  });

  it("[FR-12.1] detects API presence from injected scopes", () => {
    class BinarySocket {
      get binaryType(): string {
        return "blob";
      }
    }
    class PlainSocket {}

    expect(detectWebSocket({ WebSocket: BinarySocket })).toBe(true);
    expect(detectWebSocket({})).toBe(false);
    expect(detectBinaryWebSocket({ WebSocket: BinarySocket })).toBe(true);
    expect(detectBinaryWebSocket({ WebSocket: PlainSocket })).toBe(false);

    expect(detectWebRTC({ RTCPeerConnection: class {} })).toBe(true);
    expect(detectWebRTC({})).toBe(false);

    expect(detectWakeLock({ wakeLock: {} })).toBe(true);
    expect(detectWakeLock({})).toBe(false);

    expect(detectDeviceMemory({ deviceMemory: 2 })).toBe(2);
    expect(detectDeviceMemory({ deviceMemory: "2" })).toBeNull();
    expect(detectDeviceMemory({})).toBeNull();

    expect(detectHardwareConcurrency({ hardwareConcurrency: 4 })).toBe(4);
    expect(detectHardwareConcurrency({})).toBeNull();

    expect(detectAudioContext({ AudioContext: class {} })).toBe(true);
    expect(detectAudioContext({ webkitAudioContext: class {} })).toBe(true);
    expect(detectAudioContext({})).toBe(false);
  });

  it("[FR-12.1] shared probe code never reads or branches on the user agent", () => {
    for (const file of ["probe.ts", "probe.js", "report.ts", "report.js"]) {
      expect(readShared(file)).not.toMatch(/userAgent|navigator\.platform/i);
    }
  });
});

describe("[E1] probe check runner", () => {
  it("[E1] keeps running after a check throws and records the failure", async () => {
    const results = await runChecks(
      [
        { id: "one", label: "One", run: () => 1 },
        {
          id: "two",
          label: "Two",
          run: () => {
            throw new Error("boom");
          },
        },
        { id: "three", label: "Three", run: () => 3 },
      ],
      { now: () => 0 },
    );

    expect(results.map((result) => result.status)).toEqual(["pass", "fail", "pass"]);
    expect(results[1]?.error).toBe("boom");
    expect(results[2]?.value).toBe(3);
  });

  it("[E1] treats a false return value as a failure", async () => {
    const results = await runChecks([{ id: "false", label: "False", run: () => false }], {
      now: () => 0,
    });

    expect(results[0]?.status).toBe("fail");
    expect(results[0]?.error).toBe("check returned false");
  });
});
