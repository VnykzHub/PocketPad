import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  BUTTON_BITS,
  INPUT_FRAME_BYTES,
  INPUT_FWD_FRAME_BYTES,
  MAX_BINARY_FRAME_BYTES,
  MAX_HAPTIC_STEPS,
  MSG,
  ProtocolError,
  decodeHaptic,
  decodeHapticCmd,
  decodeInput,
  decodeInputFwd,
  decodeInputFwdInto,
  decodeInputInto,
  decodePing,
  decodePong,
  encodeHaptic,
  encodeHapticCmd,
  encodeInput,
  encodeInputFwd,
  encodePing,
  encodePong,
  frameType,
  type InputState,
} from "../src/index";

const NUM_RUNS = 1000;
const i16 = fc.integer({ min: -32768, max: 32767 });
const u8 = fc.integer({ min: 0, max: 255 });
const u16 = fc.integer({ min: 0, max: 0xffff });
const u32 = fc.integer({ min: 0, max: 0xffff_ffff });

function state(overrides: Partial<InputState> = {}): InputState {
  return {
    tick: 0,
    buttons: 0,
    edges: 0,
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
    gx: 0,
    gy: 0,
    gz: 0,
    lt: 0,
    rt: 0,
    flags: 0,
    ...overrides,
  };
}

const arbitraryInputState: fc.Arbitrary<InputState> = fc.record({
  tick: u32,
  buttons: u16,
  edges: u16,
  lx: i16,
  ly: i16,
  rx: i16,
  ry: i16,
  gx: i16,
  gy: i16,
  gz: i16,
  lt: u8,
  rt: u8,
  flags: u8,
});

function expectProtocolError(run: () => unknown, code: ProtocolError["code"]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
    return;
  }
  throw new Error(`expected ProtocolError(${code})`);
}

describe("binary codecs (D0-PROTO-02)", () => {
  test("[FR-7.3] input round-trip preserves edges including level zero", () => {
    fc.assert(
      fc.property(arbitraryInputState, (input) => {
        expect(decodeInput(encodeInput(input))).toEqual(input);
      }),
      { numRuns: NUM_RUNS },
    );

    // A tap shorter than one host tick: the press edge survives even though the
    // captured level is already zero (FR-7.3).
    const aBit = 1 << BUTTON_BITS.A;
    const decodedTap = decodeInput(encodeInput(state({ buttons: 0, edges: aBit })));
    expect(decodedTap.buttons).toBe(0);
    expect(decodedTap.edges & aBit).toBe(aBit);
  });

  test("[FR-7.4] analog i16 round-trip at min, max and zero", () => {
    for (const value of [-32768, -1, 0, 1, 32767]) {
      const decoded = decodeInput(encodeInput(state({ lx: value, rx: value })));
      expect(decoded.lx).toBe(value);
      expect(decoded.rx).toBe(value);
    }

    fc.assert(
      fc.property(i16, i16, i16, i16, (lx, ly, rx, ry) => {
        const decoded = decodeInput(encodeInput(state({ lx, ly, rx, ry })));
        expect([decoded.lx, decoded.ly, decoded.rx, decoded.ry]).toEqual([lx, ly, rx, ry]);
      }),
      { numRuns: NUM_RUNS },
    );

    // Out-of-range and fractional values clamp/truncate to the wire ranges.
    const clamped = decodeInput(
      encodeInput(state({ lx: 40000, ly: -40000, lt: 300, rt: -5 })),
    );
    expect(clamped.lx).toBe(32767);
    expect(clamped.ly).toBe(-32768);
    expect(clamped.lt).toBe(255);
    expect(clamped.rt).toBe(0);

    const triggers = decodeInput(encodeInput(state({ lt: 0, rt: 255 })));
    expect(triggers.lt).toBe(0);
    expect(triggers.rt).toBe(255);
  });

  test("[FR-7.5] gyro dps x10 round-trip", () => {
    fc.assert(
      fc.property(i16, i16, i16, (gx, gy, gz) => {
        const decoded = decodeInput(encodeInput(state({ gx, gy, gz })));
        expect([decoded.gx, decoded.gy, decoded.gz]).toEqual([gx, gy, gz]);
      }),
      { numRuns: NUM_RUNS },
    );

    const extremes = decodeInput(encodeInput(state({ gx: 32767, gy: -32768, gz: 0 })));
    expect(extremes.gx).toBe(32767);
    expect(extremes.gy).toBe(-32768);
    expect(extremes.gz).toBe(0);
  });

  test("[FR-7.6] reserved flag bits survive round-trip", () => {
    fc.assert(
      fc.property(u8, (flags) => {
        expect(decodeInput(encodeInput(state({ flags }))).flags).toBe(flags);
      }),
      { numRuns: NUM_RUNS },
    );

    // Bits 2-7 are reserved but must not be masked by the codec.
    const reserved = 0b1111_1100;
    expect(decodeInput(encodeInput(state({ flags: reserved }))).flags).toBe(reserved);
  });

  test("[FR-7.3] InputFwd preserves slot, tick, level and edges", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), arbitraryInputState, (slot, input) => {
        const frame = encodeInputFwd(slot, input);
        expect(frame).toHaveLength(INPUT_FWD_FRAME_BYTES);
        const decoded = decodeInputFwd(frame);
        expect(decoded.slot).toBe(slot);
        expect(decoded.state).toEqual(input);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("[G4] InputFwd slot is restricted to 1..8", () => {
    expectProtocolError(() => encodeInputFwd(0, state()), "badValue");
    expectProtocolError(() => encodeInputFwd(9, state()), "badValue");
    expectProtocolError(() => encodeInputFwd(1.5, state()), "badValue");

    const frame = encodeInputFwd(1, state());
    frame[1] = 0;
    expectProtocolError(() => decodeInputFwd(frame), "badValue");
    frame[1] = 9;
    expectProtocolError(() => decodeInputFwd(frame), "badValue");
  });

  test("[FR-7.14] Ping and Pong round-trip u32 timestamps", () => {
    fc.assert(
      fc.property(u32, u32, (clientTimeMs, serverTimeMs) => {
        expect(decodePing(encodePing(clientTimeMs))).toEqual({ clientTimeMs });
        expect(decodePong(encodePong(clientTimeMs, serverTimeMs))).toEqual({
          clientTimeMs,
          serverTimeMs,
        });
      }),
      { numRuns: NUM_RUNS },
    );

    expect(decodePing(encodePing(0xffff_ffff)).clientTimeMs).toBe(0xffff_ffff);
    // u32 wrap is intentional (A3): 2^32 becomes 0.
    expect(encodePing(0x1_0000_0000)[1]).toBe(0);
  });

  test("[FR-8.11] haptic durations round-trip and are capped at eight steps", () => {
    const durations = fc.array(fc.integer({ min: 0, max: 0xffff }), {
      maxLength: MAX_HAPTIC_STEPS,
    });

    fc.assert(
      fc.property(durations, (values) => {
        const haptic = encodeHaptic(values);
        expect(haptic).toHaveLength(2 + 2 * values.length);
        expect(decodeHaptic(haptic)).toEqual(values);

        const command = encodeHapticCmd(0, values);
        expect(command).toHaveLength(3 + 2 * values.length);
        expect(decodeHapticCmd(command).durationsMs).toEqual(values);
      }),
      { numRuns: NUM_RUNS },
    );

    expect(decodeHaptic(encodeHaptic([]))).toEqual([]);
    expectProtocolError(() => encodeHaptic(new Array<number>(9).fill(10)), "badValue");
    expectProtocolError(() => encodeHapticCmd(0, new Array<number>(9).fill(10)), "badValue");
    // Durations clamp to the u16 wire range rather than wrapping.
    expect(decodeHaptic(encodeHaptic([70000, -5]))).toEqual([0xffff, 0]);
  });

  test("[G4] HapticCmd accepts slots 0..8 and rejects 9", () => {
    expect(decodeHapticCmd(encodeHapticCmd(0, [10])).slot).toBe(0);
    expect(decodeHapticCmd(encodeHapticCmd(8, [10])).slot).toBe(8);
    expectProtocolError(() => encodeHapticCmd(9, []), "badValue");

    const frame = encodeHapticCmd(1, []);
    frame[1] = 9;
    expectProtocolError(() => decodeHapticCmd(frame), "badValue");
  });

  test("[SR-6] binary frame over 64 bytes is rejected", () => {
    const oversized = new Uint8Array(MAX_BINARY_FRAME_BYTES + 1);
    oversized[0] = MSG.Input;
    expectProtocolError(() => decodeInput(oversized), "tooLarge");
    expectProtocolError(() => decodeInputInto(oversized, state()), "tooLarge");

    const oversizedHaptic = new Uint8Array(MAX_BINARY_FRAME_BYTES + 1);
    oversizedHaptic[0] = MSG.Haptic;
    expectProtocolError(() => decodeHaptic(oversizedHaptic), "tooLarge");
  });

  test("[SR-6] frameType identifies frames and malformed frames use stable error codes", () => {
    expect(frameType(new Uint8Array(0))).toBeNull();
    expect(frameType(encodeInput(state()))).toBe(MSG.Input);
    expect(frameType(encodeInputFwd(1, state()))).toBe(MSG.InputFwd);
    expect(frameType(encodePing(0))).toBe(MSG.Ping);
    expect(frameType(encodePong(0, 0))).toBe(MSG.Pong);
    expect(frameType(encodeHaptic([]))).toBe(MSG.Haptic);
    expect(frameType(encodeHapticCmd(0, []))).toBe(MSG.HapticCmd);
    expect(frameType(Uint8Array.of(0x7f))).toBe(0x7f);

    const truncatedInput = encodeInput(state()).subarray(0, INPUT_FRAME_BYTES - 1);
    expectProtocolError(() => decodeInput(truncatedInput), "badLength");

    const wrongType = new Uint8Array(INPUT_FRAME_BYTES);
    wrongType[0] = MSG.Ping;
    expectProtocolError(() => decodeInput(wrongType), "badType");

    expectProtocolError(() => decodePing(encodeInput(state())), "badLength");
    expectProtocolError(() => decodePong(encodePing(0)), "badLength");
    expectProtocolError(() => decodeHaptic(encodePing(0)), "badType");
    expectProtocolError(() => decodeHapticCmd(encodeHaptic([])), "badLength");
    expectProtocolError(() => decodeHaptic(Uint8Array.of(MSG.Haptic, 1)), "badLength");
    expectProtocolError(
      () => decodeHapticCmd(Uint8Array.of(MSG.HapticCmd, 1, 1)),
      "badLength",
    );
  });

  test("[SR-6] haptic step count over eight is rejected on decode", () => {
    const haptic = new Uint8Array(2 + 18);
    haptic[0] = MSG.Haptic;
    haptic[1] = 9;
    expectProtocolError(() => decodeHaptic(haptic), "badValue");

    const command = new Uint8Array(3 + 18);
    command[0] = MSG.HapticCmd;
    command[1] = 1;
    command[2] = 9;
    expectProtocolError(() => decodeHapticCmd(command), "badValue");
  });

  test("[FR-7.4] non-finite numeric inputs are rejected", () => {
    expectProtocolError(() => encodeInput(state({ tick: Number.NaN })), "badValue");
    expectProtocolError(
      () => encodeInput(state({ lx: Number.POSITIVE_INFINITY })),
      "badValue",
    );
    expectProtocolError(() => encodePing(Number.NEGATIVE_INFINITY), "badValue");
    expectProtocolError(() => encodeHaptic([Number.NaN]), "badValue");
  });

  test("[PR-9.3] decodeInputInto performs no allocation", () => {
    const input = state({
      tick: 123,
      buttons: 0x8001,
      edges: 0x0001,
      lx: -1234,
      gz: 777,
      lt: 12,
      rt: 34,
      flags: 0b1010_0000,
    });
    const out = state({ tick: 999 });

    // The fixture reuses one `out` object and asserts identity, which is what
    // the hot path relies on: no per-packet state allocation.
    const returned = decodeInputInto(encodeInput(input), out);
    expect(returned).toBe(out);
    expect(out).toEqual(input);

    const next = state({ tick: 456, edges: 2 });
    expect(decodeInputInto(encodeInput(next), out)).toBe(out);
    expect(out).toEqual(next);

    const forwarded = encodeInputFwd(5, input);
    const fwdOut = state();
    expect(decodeInputFwdInto(forwarded, fwdOut)).toBe(5);
    expect(fwdOut).toEqual(input);
    expect(decodeInputFwdInto(forwarded, fwdOut)).toBe(5);
    expect(fwdOut).toEqual(input);
  });
});
