import { describe, expect, test } from "vitest";
import {
  BUTTON_BITS,
  INPUT_FRAME_BYTES,
  INPUT_FWD_FRAME_BYTES,
  MAX_BINARY_FRAME_BYTES,
  MSG,
  decodeInput,
  decodeInputFwd,
  encodeHaptic,
  encodeHapticCmd,
  encodeInput,
  encodeInputFwd,
  encodePing,
  encodePong,
  type InputState,
} from "../src/index";

/**
 * Golden vectors pin endianness and byte offsets. These are the D0-PROTO-02
 * contract tests: if one changes, the wire format changed.
 */

function goldenState(overrides: Partial<InputState> = {}): InputState {
  return {
    tick: 0x01020304,
    buttons: 0x0102,
    edges: 0x0304,
    lx: -1,
    ly: 32767,
    rx: -32768,
    ry: 0,
    gx: 0x1234,
    gy: -0x1234,
    gz: 0,
    lt: 0xab,
    rt: 0xcd,
    flags: 0xfc,
    ...overrides,
  };
}

describe("binary golden vectors (D0-PROTO-02)", () => {
  test("[A3] tick is a u32 little-endian millisecond timestamp at offset 1", () => {
    const frame = encodeInput(goldenState({ tick: 0x01020304 }));
    expect(Array.from(frame.subarray(0, 5))).toEqual([MSG.Input, 0x04, 0x03, 0x02, 0x01]);
    expect(decodeInput(frame).tick).toBe(0x01020304);
  });

  test("[FR-7.2] buttons and edges are u16 little-endian at offsets 5 and 7", () => {
    const frame = encodeInput(goldenState({ buttons: 0x0102, edges: 0x0304 }));
    expect(Array.from(frame.subarray(5, 7))).toEqual([0x02, 0x01]);
    expect(Array.from(frame.subarray(7, 9))).toEqual([0x04, 0x03]);
    // Bit positions are not masks: A is bit 0, Select is bit 15.
    expect(1 << BUTTON_BITS.A).toBe(0x0001);
    expect(1 << BUTTON_BITS.Select).toBe(0x8000);
  });

  test("[FR-7.4] analog i16 golden vectors are little-endian two's complement", () => {
    const minusOne = encodeInput(goldenState({ lx: -1 }));
    expect(Array.from(minusOne.subarray(9, 11))).toEqual([0xff, 0xff]);

    const max = encodeInput(goldenState({ ly: 32767 }));
    expect(Array.from(max.subarray(11, 13))).toEqual([0xff, 0x7f]);

    const min = encodeInput(goldenState({ rx: -32768 }));
    expect(Array.from(min.subarray(13, 15))).toEqual([0x00, 0x80]);

    const zero = encodeInput(goldenState({ ry: 0 }));
    expect(Array.from(zero.subarray(15, 17))).toEqual([0x00, 0x00]);

    expect(decodeInput(minusOne).lx).toBe(-1);
    expect(decodeInput(max).ly).toBe(32767);
    expect(decodeInput(min).rx).toBe(-32768);
  });

  test("[FR-7.5] gyro golden vector is degrees/second x10 in i16", () => {
    const frame = encodeInput(goldenState({ gx: 0x1234, gy: -0x1234, gz: 0 }));
    expect(Array.from(frame.subarray(17, 23))).toEqual([
      0x34, 0x12, // gx = 4660
      0xcc, 0xed, // gy = -4660
      0x00, 0x00, // gz = 0
    ]);
  });

  test("[FR-7.6] flags keep reserved bits and live at offset 25", () => {
    const frame = encodeInput(goldenState({ flags: 0xfc }));
    expect(frame).toHaveLength(INPUT_FRAME_BYTES);
    expect(frame[25]).toBe(0xfc);
    expect(decodeInput(frame).flags).toBe(0xfc);
  });

  test("[FR-7.3] InputFwd golden frame prepends the slot to the Input body", () => {
    const state = goldenState();
    const input = encodeInput(state);
    const forwarded = encodeInputFwd(3, state);

    expect(forwarded).toHaveLength(INPUT_FWD_FRAME_BYTES);
    expect(forwarded[0]).toBe(MSG.InputFwd);
    expect(forwarded[1]).toBe(3);
    expect(Array.from(forwarded.subarray(2))).toEqual(Array.from(input.subarray(1)));

    const decoded = decodeInputFwd(forwarded);
    expect(decoded.slot).toBe(3);
    expect(decoded.state).toEqual(state);
  });

  test("[FR-7.14] Ping and Pong golden byte layouts", () => {
    const ping = encodePing(0x01020304);
    expect(Array.from(ping)).toEqual([MSG.Ping, 0x04, 0x03, 0x02, 0x01]);

    const pong = encodePong(0x01020304, 0x05060708);
    expect(Array.from(pong)).toEqual([
      MSG.Pong,
      0x04,
      0x03,
      0x02,
      0x01,
      0x08,
      0x07,
      0x06,
      0x05,
    ]);
  });

  test("[FR-8.11] Haptic and HapticCmd golden byte layouts", () => {
    const haptic = encodeHaptic([0x0102, 0x0304]);
    expect(Array.from(haptic)).toEqual([MSG.Haptic, 0x02, 0x02, 0x01, 0x04, 0x03]);

    const command = encodeHapticCmd(3, [0x0102, 0x0304]);
    expect(Array.from(command)).toEqual([
      MSG.HapticCmd,
      0x03,
      0x02,
      0x02,
      0x01,
      0x04,
      0x03,
    ]);
  });

  test("[SR-6] every golden frame is inside the 64-byte binary cap", () => {
    const state = goldenState();
    const frames = [
      encodeInput(state),
      encodeInputFwd(1, state),
      encodePing(1),
      encodePong(1, 2),
      encodeHaptic([1]),
      encodeHapticCmd(0, [1]),
    ];
    for (const frame of frames) {
      expect(frame.byteLength).toBeLessThanOrEqual(MAX_BINARY_FRAME_BYTES);
    }
  });
});
