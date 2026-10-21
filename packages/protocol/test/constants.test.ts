import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import * as protocol from "../src/index";
import {
  BUTTON_BITS,
  INPUT_FRAME_BYTES,
  INPUT_FWD_FRAME_BYTES,
  MAX_BINARY_FRAME_BYTES,
  MAX_CONTROLLERS,
  MAX_HAPTIC_STEPS,
  MAX_JSON_FRAME_BYTES,
  MSG,
  PROTOCOL_VERSION,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_PIN_LENGTH,
  TICK_HZ,
  TOKEN_BYTES,
  TOKEN_LENGTH,
} from "../src/index";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(packageRoot, "src");
const sourceFiles = readdirSync(srcDir).filter((name) => name.endsWith(".ts"));

function readSource(name: string): string {
  return readFileSync(join(srcDir, name), "utf8");
}

describe("protocol constants (D0-PROTO-01)", () => {
  test("[FR-7.2] message IDs, frame sizes and caps match the spec", () => {
    expect(MSG).toEqual({
      Input: 0x02,
      Ping: 0x03,
      Pong: 0x82,
      Haptic: 0x84,
      HapticCmd: 0xa2,
      InputFwd: 0xb2,
    });
    expect(PROTOCOL_VERSION).toBe(1);
    expect(TICK_HZ).toBe(60);
    expect(MAX_CONTROLLERS).toBe(8);
    expect(MAX_BINARY_FRAME_BYTES).toBe(64);
    expect(MAX_JSON_FRAME_BYTES).toBe(4096);
    expect(MAX_HAPTIC_STEPS).toBe(8);
    expect(INPUT_FRAME_BYTES).toBe(26);
    expect(INPUT_FWD_FRAME_BYTES).toBe(27);
  });

  test("[FR-7.2] button bitfield matches spec positions", () => {
    expect(BUTTON_BITS).toEqual({
      A: 0,
      B: 1,
      X: 2,
      Y: 3,
      L1: 4,
      R1: 5,
      L2: 6,
      R2: 7,
      DUp: 8,
      DDown: 9,
      DLeft: 10,
      DRight: 11,
      L3: 12,
      R3: 13,
      Start: 14,
      Select: 15,
    });
    // Sixteen distinct bit positions, exactly 0..15.
    expect(Object.values(BUTTON_BITS).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 16 }, (_, index) => index),
    );
  });

  test("[FR-5.3] room code and token constants match the plan defaults", () => {
    expect(ROOM_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(32);
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[ILOU]/);
    expect(ROOM_CODE_LENGTH).toBe(4);
    expect(ROOM_PIN_LENGTH).toBe(4);
    expect(TOKEN_BYTES).toBe(16);
    expect(TOKEN_LENGTH).toBe(22);
  });

  test("[FR-10.1] protocol package has zero runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
    expect(pkg.optionalDependencies ?? {}).toEqual({});

    expect(sourceFiles.length).toBeGreaterThan(0);
    for (const file of sourceFiles) {
      const text = readSource(file);
      expect(text, `${file} must not import Node built-ins`).not.toMatch(
        /from\s+["']node:/,
      );
      expect(text, `${file} must not import Node built-ins`).not.toMatch(
        /from\s+["'](?:assert|buffer|child_process|crypto|events|fs|http|https|net|os|path|stream|tls|url|util|zlib)(?:\/[^"']*)?["']/,
      );
      expect(text, `${file} must not use Node's Buffer`).not.toMatch(/\bBuffer\s*[.(]/);
    }
  });

  test("[FR-4.4] only WebSocket transport constants are exported", () => {
    expect(Object.keys(MSG)).toEqual([
      "Input",
      "Ping",
      "Pong",
      "Haptic",
      "HapticCmd",
      "InputFwd",
    ]);
    // No socket / WebRTC / fetch implementation leaks out of the wire contract.
    expect(Object.keys(protocol).filter((name) => /socket|webrtc|fetch/i.test(name))).toEqual([]);
    for (const file of sourceFiles) {
      expect(readSource(file), `${file} must not hard-code a WebSocket URL`).not.toMatch(
        /wss?:\/\//,
      );
    }
  });
});
