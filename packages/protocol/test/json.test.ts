import { describe, expect, test } from "vitest";
import {
  MAX_JSON_FRAME_BYTES,
  MAX_LAYOUT_JSON_FRAME_BYTES,
  MAX_PLAYER_NAME_CHARS,
  ProtocolError,
  assertJsonWithinLimit,
  isClientToServerMessage,
  isHostToServerMessage,
  jsonByteLength,
  parseJsonMessage,
  stringifyJsonMessage,
  type JsonControlMessage,
  type SlotStats,
} from "../src/index";

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

function expectPanel(text: string): Extract<JsonControlMessage, { t: "panel" }> {
  const message = parseJsonMessage(text);
  if (message.t !== "panel") {
    throw new Error(`expected panel, got ${message.t}`);
  }
  return message;
}

/**
 * Builds a structurally valid panel message whose serialized JSON text is
 * exactly `byteLength` bytes. Content is ASCII, so one character is one byte.
 */
const PANEL_PREFIX_LENGTH = JSON.stringify({ t: "panel", slot: 1, content: "" }).length;

function asciiPanelFrame(byteLength: number): string {
  const padding = byteLength - PANEL_PREFIX_LENGTH;
  expect(padding).toBeGreaterThan(0);
  return JSON.stringify({ t: "panel", slot: 1, content: "x".repeat(padding) });
}

/** Same idea for a setLayout frame; A13 allows this type up to 16 KB. */
const SET_LAYOUT_PREFIX_LENGTH = JSON.stringify({
  t: "setLayout",
  slot: "all",
  layout: { id: "big-v1", blob: "" },
}).length;

function asciiSetLayoutFrame(byteLength: number): string {
  const padding = byteLength - SET_LAYOUT_PREFIX_LENGTH;
  expect(padding).toBeGreaterThan(0);
  return JSON.stringify({
    t: "setLayout",
    slot: "all",
    layout: { id: "big-v1", blob: "x".repeat(padding) },
  });
}

/** Same idea for an event frame; events keep the 4 KB cap. */
const EVENT_PREFIX_LENGTH = JSON.stringify({
  t: "event",
  slot: 1,
  name: "x",
  data: "",
}).length;

function asciiEventFrame(byteLength: number): string {
  const padding = byteLength - EVENT_PREFIX_LENGTH;
  expect(padding).toBeGreaterThan(0);
  return JSON.stringify({ t: "event", slot: 1, name: "x", data: "x".repeat(padding) });
}

function validStat(slot: number): SlotStats {
  return {
    slot,
    rttMs: 12,
    jitterMs: 2,
    lastInputAgeMs: 16,
    packetsPerSecond: 60,
    drops: 0,
  };
}

describe("JSON framing and validation (D0-PROTO-03)", () => {
  test("[SR-6] JSON frame over 4096 bytes is rejected and closes the socket", () => {
    // Exactly 4096 ASCII bytes is accepted. (Closing the socket is the
    // caller's job; this module only reports `tooLarge`.)
    const atLimit = asciiPanelFrame(MAX_JSON_FRAME_BYTES);
    expect(atLimit.length).toBe(MAX_JSON_FRAME_BYTES);
    expect(jsonByteLength(atLimit)).toBe(MAX_JSON_FRAME_BYTES);
    expectPanel(atLimit);

    const overLimit = asciiPanelFrame(MAX_JSON_FRAME_BYTES + 1);
    expect(jsonByteLength(overLimit)).toBe(MAX_JSON_FRAME_BYTES + 1);
    expectProtocolError(() => parseJsonMessage(overLimit), "tooLarge");
    expectProtocolError(() => assertJsonWithinLimit(overLimit), "tooLarge");

    // Byte counting, not character counting: 4096 characters but 4097 bytes.
    const padding = MAX_JSON_FRAME_BYTES - PANEL_PREFIX_LENGTH;
    const multibyte = JSON.stringify({
      t: "panel",
      slot: 1,
      content: "x".repeat(padding - 1) + "é",
    });
    expect(multibyte.length).toBe(MAX_JSON_FRAME_BYTES);
    expect(jsonByteLength(multibyte)).toBe(MAX_JSON_FRAME_BYTES + 1);
    expectProtocolError(() => parseJsonMessage(multibyte), "tooLarge");

    // Acceptance bullet: 4097 bytes of multi-byte characters is rejected.
    expectProtocolError(() => parseJsonMessage("é".repeat(MAX_JSON_FRAME_BYTES + 1)), "tooLarge");
    // The cap is checked before JSON parsing, so it also guards invalid input.
    expectProtocolError(() => parseJsonMessage("not json ".repeat(600)), "tooLarge");
  });

  test("[SR-6][FR-8.2] only setLayout JSON frames may exceed 4096 bytes (A13)", () => {
    // The SDK accepts layout documents up to 16 KB, so a 5-14 KB document must
    // reach the wire as one setLayout frame.
    const text = asciiSetLayoutFrame(14 * 1024);
    expect(jsonByteLength(text)).toBe(14 * 1024);
    const message = parseJsonMessage(text);
    expect(message.t).toBe("setLayout");
    if (message.t !== "setLayout") {
      throw new Error("expected setLayout");
    }
    expect(message.slot).toBe("all");
    expect(message.layout).toEqual({
      id: "big-v1",
      blob: "x".repeat(14 * 1024 - SET_LAYOUT_PREFIX_LENGTH),
    });

    // The 16 KB ceiling is inclusive; one byte more is rejected before parsing.
    expect(parseJsonMessage(asciiSetLayoutFrame(MAX_LAYOUT_JSON_FRAME_BYTES)).t).toBe(
      "setLayout",
    );
    expectProtocolError(
      () => parseJsonMessage(asciiSetLayoutFrame(MAX_LAYOUT_JSON_FRAME_BYTES + 1)),
      "tooLarge",
    );
    // Oversized hostile input never reaches JSON.parse.
    expectProtocolError(
      () => parseJsonMessage("x".repeat(MAX_LAYOUT_JSON_FRAME_BYTES + 1)),
      "tooLarge",
    );
  });

  test("[SR-6][FR-8.2] non-setLayout JSON over 4096 bytes is rejected (A13)", () => {
    // A 4.1 KB panel and a 4.1 KB event keep the SR-6 cap.
    expectProtocolError(
      () => parseJsonMessage(asciiPanelFrame(MAX_JSON_FRAME_BYTES + 1)),
      "tooLarge",
    );
    expectProtocolError(
      () => parseJsonMessage(asciiEventFrame(MAX_JSON_FRAME_BYTES + 1)),
      "tooLarge",
    );
    // Malformed input between 4 KB and 16 KB cannot be a setLayout, so the
    // default cap still applies.
    expectProtocolError(
      () => parseJsonMessage("y".repeat(MAX_JSON_FRAME_BYTES + 1)),
      "tooLarge",
    );
    // A panel at exactly the 4 KB cap is still accepted.
    expectPanel(asciiPanelFrame(MAX_JSON_FRAME_BYTES));
  });

  test("[SR-6][FR-8.2][FR-7.9] stringifyJsonMessage selects the per-message cap", () => {
    const layout = { id: "big-v1", blob: "x".repeat(14 * 1024) };
    const text = stringifyJsonMessage({ t: "setLayout", slot: "all", layout });
    expect(jsonByteLength(text)).toBeGreaterThan(MAX_JSON_FRAME_BYTES);
    expect(parseJsonMessage(text)).toEqual({ t: "setLayout", slot: "all", layout });

    // setLayout still has a ceiling: an over-16 KB body is refused.
    const maxLayout = { id: "big-v1", blob: "x".repeat(MAX_LAYOUT_JSON_FRAME_BYTES) };
    expectProtocolError(
      () => stringifyJsonMessage({ t: "setLayout", slot: "all", layout: maxLayout }),
      "tooLarge",
    );

    // Panel and event keep the 4 KB cap.
    expectProtocolError(
      () =>
        stringifyJsonMessage({
          t: "panel",
          slot: 1,
          content: "x".repeat(MAX_JSON_FRAME_BYTES),
        }),
      "tooLarge",
    );
    expectProtocolError(
      () =>
        stringifyJsonMessage({
          t: "event",
          slot: 1,
          name: "x",
          data: "x".repeat(MAX_JSON_FRAME_BYTES),
        }),
      "tooLarge",
    );
  });

  test("[SR-6] jsonByteLength counts UTF-8 bytes for ASCII, accents and emoji", () => {
    expect(jsonByteLength("abc")).toBe(3);
    expect(jsonByteLength("é")).toBe(2);
    expect(jsonByteLength("😀")).toBe(4);
    expect(jsonByteLength("")).toBe(0);
    expect(jsonByteLength('{"t":"leave"}')).toBe('{"t":"leave"}'.length);
  });

  test("[SR-6] stringifyJsonMessage refuses to emit a frame over the cap", () => {
    const message: JsonControlMessage = { t: "panel", slot: 1, content: "hi" };
    expect(JSON.parse(stringifyJsonMessage(message))).toEqual(message);

    const oversized: JsonControlMessage = {
      t: "panel",
      slot: 1,
      content: "x".repeat(MAX_JSON_FRAME_BYTES),
    };
    expectProtocolError(() => stringifyJsonMessage(oversized), "tooLarge");
  });

  test("[FR-7.9] arbitrary panel body passes through unmodified", () => {
    const content = {
      widgets: [
        {
          kind: "button",
          label: "Jump",
          rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
          haptic: null,
        },
        { kind: "stick", deadzone: 0.15, invertY: false },
      ],
      meta: { title: "Panel", nested: [1, 2, [3, { deep: true }]] },
    };
    const message = expectPanel(
      JSON.stringify({ t: "panel", slot: 3, content }),
    );
    expect(message).toEqual({ t: "panel", slot: 3, content });
    expect(message.content).toEqual(content);

    // The parser does not validate or reshape layout/panel internals.
    expect(expectPanel('{"t":"panel","slot":1,"content":null}').content).toBeNull();
    expectPanel('{"t":"panel","slot":1,"content":"text"}');
    expectPanel('{"t":"panel","slot":1,"content":[1,"two",false,null]}');

    // Unknown top-level fields are dropped, not copied through.
    expect(expectPanel('{"t":"panel","slot":1,"content":{},"extra":true}')).toEqual({
      t: "panel",
      slot: 1,
      content: {},
    });

    // JSON.parse keeps `__proto__` as an own data property; the parser must not
    // merge it into any object.
    const polluted = expectPanel(
      '{"t":"panel","slot":1,"content":{"__proto__":{"polluted":true}}}',
    );
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(
      Object.prototype.hasOwnProperty.call(
        polluted.content as Record<string, unknown>,
        "__proto__",
      ),
    ).toBe(true);
  });

  test("[FR-7.9] layout bodies pass through unchanged for setLayout and joined", () => {
    const layout = {
      id: "layout-v3",
      theme: "dark",
      groups: [{ id: "main", widgets: [{ type: "button", action: "jump" }] }],
      version: 3,
      enabled: true,
      extra: null,
    };
    expect(parseJsonMessage(JSON.stringify({ t: "setLayout", slot: "all", layout }))).toEqual({
      t: "setLayout",
      slot: "all",
      layout,
    });
    expect(
      parseJsonMessage(JSON.stringify({ t: "joined", slot: 2, session: "s", serverTime: 5, layout })),
    ).toEqual({ t: "joined", slot: 2, session: "s", serverTime: 5, layout });

    // D5-PROTO-01: the body stays opaque but must be an object with an id.
    expectProtocolError(
      () => parseJsonMessage('{"t":"setLayout","slot":8,"layout":null}'),
      "badType",
    );
  });

  test("[FR-5.1] join accepts token, pin, session, or token+pin in QR PIN mode; not session+token", () => {
    expect(
      parseJsonMessage('{"t":"join","v":1,"code":"ABCD","session":"session-1"}'),
    ).toEqual({ t: "join", v: 1, code: "ABCD", session: "session-1" });

    expect(parseJsonMessage('{"t":"join","v":1,"code":"ABCD","token":"token-1"}')).toEqual({
      t: "join",
      v: 1,
      code: "ABCD",
      token: "token-1",
    });

    expect(parseJsonMessage('{"t":"join","v":1,"code":"ABCD","pin":"1234"}')).toEqual({
      t: "join",
      v: 1,
      code: "ABCD",
      pin: "1234",
    });

    // A11 QR PIN mode: token + pin is structurally valid; the broker checks
    // requirePinForQr before accepting it.
    expect(
      parseJsonMessage('{"t":"join","v":1,"code":"ABCD","token":"token-1","pin":"1234"}'),
    ).toEqual({ t: "join", v: 1, code: "ABCD", token: "token-1", pin: "1234" });

    // `session` never combines with token or pin.
    expectProtocolError(
      () => parseJsonMessage('{"t":"join","v":1,"code":"ABCD","session":"s","token":"t"}'),
      "badValue",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"join","v":1,"code":"ABCD","session":"s","pin":"1234"}'),
      "badValue",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"join","v":1,"code":"ABCD","session":"s","token":"t","pin":"1234"}'),
      "badValue",
    );
    // At least one credential is required.
    expectProtocolError(
      () => parseJsonMessage('{"t":"join","v":1,"code":"ABCD"}'),
      "badValue",
    );

    // Optional display name, capped at 24 characters.
    expect(
      parseJsonMessage(
        JSON.stringify({
          t: "join",
          v: 1,
          code: "ABCD",
          pin: "1234",
          name: "a".repeat(MAX_PLAYER_NAME_CHARS),
        }),
      ),
    ).toMatchObject({ name: "a".repeat(MAX_PLAYER_NAME_CHARS) });
    expectProtocolError(
      () =>
        parseJsonMessage(
          JSON.stringify({
            t: "join",
            v: 1,
            code: "ABCD",
            pin: "1234",
            name: "a".repeat(MAX_PLAYER_NAME_CHARS + 1),
          }),
        ),
      "badLength",
    );

    // Codes and PINs are fixed-width, PINs are digits only.
    expectProtocolError(
      () => parseJsonMessage('{"t":"join","v":1,"code":"ABC","pin":"1234"}'),
      "badLength",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"join","v":1,"code":"ABCD","pin":"123"}'),
      "badLength",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"join","v":1,"code":"ABCD","pin":"12a4"}'),
      "badValue",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"join","v":1,"code":"ABCD","token":""}'),
      "badValue",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"join","v":1,"code":"ABCD","token":7}'),
      "badType",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"join","code":"ABCD","pin":"1234"}'),
      "badType",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"join","v":"1","code":"ABCD","pin":"1234"}'),
      "badType",
    );
  });

  test("[A2] hostJoin requires code and hostToken", () => {
    const hostToken = "h".repeat(22);
    expect(
      parseJsonMessage(JSON.stringify({ t: "hostJoin", v: 1, code: "ABCD", hostToken })),
    ).toEqual({ t: "hostJoin", v: 1, code: "ABCD", hostToken });

    expectProtocolError(
      () => parseJsonMessage('{"t":"hostJoin","v":1,"code":"ABCD"}'),
      "badType",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"hostJoin","v":1,"hostToken":"' + hostToken + '"}'),
      "badType",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"hostJoin","code":"ABCD","hostToken":"' + hostToken + '"}'),
      "badType",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"hostJoin","v":1,"code":"ABC","hostToken":"' + hostToken + '"}'),
      "badLength",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"hostJoin","v":1,"code":"ABCD","hostToken":"short"}'),
      "badLength",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"hostJoin","v":1,"code":"ABCD","hostToken":42}'),
      "badType",
    );
  });

  test("[FR-7.8] event validates slot, name and opaque data", () => {
    const event = { t: "event", slot: 4, name: "goal", data: { points: 2, tags: ["a"] } };
    expect(parseJsonMessage(JSON.stringify(event))).toEqual(event);

    // `data` is any JsonValue, including null and primitives.
    expect(parseJsonMessage('{"t":"event","slot":1,"name":"x","data":null}')).toEqual({
      t: "event",
      slot: 1,
      name: "x",
      data: null,
    });
    // D5-PROTO-01: names are 1..64 characters (an empty name is not routable).
    expectProtocolError(
      () => parseJsonMessage('{"t":"event","slot":1,"name":"","data":0}'),
      "badLength",
    );

    expectProtocolError(
      () => parseJsonMessage('{"t":"event","slot":0,"name":"x","data":null}'),
      "badValue",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"event","slot":9,"name":"x","data":null}'),
      "badValue",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"event","slot":1.5,"name":"x","data":null}'),
      "badValue",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"event","slot":1,"name":"x"}'),
      "badType",
    );
    expectProtocolError(
      () =>
        parseJsonMessage(
          JSON.stringify({ t: "event", slot: 1, name: "n".repeat(65), data: null }),
        ),
      "badLength",
    );
  });

  test("[G4] host layout and panel messages validate slots", () => {
    expect(parseJsonMessage('{"t":"setLayout","slot":"all","layout":{"id":"l1"}}')).toEqual({
      t: "setLayout",
      slot: "all",
      layout: { id: "l1" },
    });
    expect(parseJsonMessage('{"t":"setLayout","slot":1,"layout":{"id":"l1"}}')).toEqual({
      t: "setLayout",
      slot: 1,
      layout: { id: "l1" },
    });
    expectProtocolError(
      () => parseJsonMessage('{"t":"setLayout","slot":0,"layout":null}'),
      "badValue",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"setLayout","slot":9,"layout":null}'),
      "badValue",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"setLayout","slot":"alll","layout":null}'),
      "badType",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"setLayout","slot":"all"}'),
      "badType",
    );
    expectProtocolError(() => parseJsonMessage('{"t":"panel","slot":0,"content":null}'), "badValue");
    expectProtocolError(() => parseJsonMessage('{"t":"panel","slot":9,"content":null}'), "badValue");
    expectProtocolError(() => parseJsonMessage('{"t":"panel","slot":1}'), "badType");

    expect(parseJsonMessage('{"t":"hostPause"}')).toEqual({ t: "hostPause" });
    expect(parseJsonMessage('{"t":"hostResume"}')).toEqual({ t: "hostResume" });
  });

  test("[G4] server status messages validate slots, sessions and reasons", () => {
    expect(parseJsonMessage('{"t":"suspend"}')).toEqual({ t: "suspend" });
    expect(parseJsonMessage('{"t":"leave"}')).toEqual({ t: "leave" });

    expect(
      parseJsonMessage('{"t":"joined","slot":1,"session":"s","serverTime":12.5}'),
    ).toEqual({ t: "joined", slot: 1, session: "s", serverTime: 12.5 });
    expectProtocolError(
      () => parseJsonMessage('{"t":"joined","slot":9,"session":"s","serverTime":0}'),
      "badValue",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"joined","slot":1,"session":"s"}'),
      "badType",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"joined","slot":1,"session":"","serverTime":0}'),
      "badValue",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"joined","slot":1,"session":"s","serverTime":"0"}'),
      "badType",
    );

    expect(parseJsonMessage('{"t":"hostJoined","code":"ABCD","serverTime":0}')).toEqual({
      t: "hostJoined",
      code: "ABCD",
      serverTime: 0,
    });
    expectProtocolError(
      () => parseJsonMessage('{"t":"hostJoined","code":"ABC","serverTime":0}'),
      "badLength",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"hostJoined","code":"ABCD"}'),
      "badType",
    );

    const reasons = [
      "roomFull",
      "badToken",
      "badPin",
      "expired",
      "rateLimited",
      "badCode",
      "badHostToken",
      "badVersion",
    ] as const;
    for (const reason of reasons) {
      expect(parseJsonMessage(JSON.stringify({ t: "joinError", reason }))).toEqual({
        t: "joinError",
        reason,
      });
    }
    expectProtocolError(
      () => parseJsonMessage('{"t":"joinError","reason":"nope"}'),
      "badValue",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"joinError","reason":3}'),
      "badType",
    );

    for (const t of ["playerJoined", "playerLeft", "playerSuspended", "playerResumed"] as const) {
      expect(parseJsonMessage(JSON.stringify({ t, slot: 4 }))).toEqual({ t, slot: 4 });
      expectProtocolError(() => parseJsonMessage(JSON.stringify({ t })), "badType");
      expectProtocolError(() => parseJsonMessage(JSON.stringify({ t, slot: 0 })), "badValue");
    }

    expect(parseJsonMessage('{"t":"kick","reason":"host ended"}')).toEqual({
      t: "kick",
      reason: "host ended",
    });
    expectProtocolError(() => parseJsonMessage('{"t":"kick"}'), "badType");
    expectProtocolError(() => parseJsonMessage('{"t":"kick","reason":1}'), "badType");
  });

  test("[G4] stats accepts up to eight slot entries with non-negative metrics", () => {
    const slots = Array.from({ length: 8 }, (_, index) => validStat(index + 1));
    expect(parseJsonMessage(JSON.stringify({ t: "stats", slots }))).toEqual({
      t: "stats",
      slots,
    });
    expect(parseJsonMessage('{"t":"stats","slots":[]}')).toEqual({ t: "stats", slots: [] });

    const nine = Array.from({ length: 9 }, (_, index) => validStat(index + 1));
    expectProtocolError(
      () => parseJsonMessage(JSON.stringify({ t: "stats", slots: nine })),
      "badValue",
    );

    const missingDrops = {
      t: "stats",
      slots: [{ slot: 1, rttMs: 1, jitterMs: 0, lastInputAgeMs: 0, packetsPerSecond: 0 }],
    };
    expectProtocolError(() => parseJsonMessage(JSON.stringify(missingDrops)), "badType");

    expectProtocolError(
      () =>
        parseJsonMessage(
          JSON.stringify({ t: "stats", slots: [{ ...validStat(1), drops: -1 }] }),
        ),
      "badValue",
    );
    expectProtocolError(
      () =>
        parseJsonMessage(
          JSON.stringify({ t: "stats", slots: [{ ...validStat(1), slot: 1.5 }] }),
        ),
      "badValue",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"stats","slots":[null]}'),
      "badType",
    );
  });

  test("[FR-4.4] malformed roots and unknown types are rejected", () => {
    expectProtocolError(() => parseJsonMessage("{nope"), "badType");
    expectProtocolError(() => parseJsonMessage("null"), "badType");
    expectProtocolError(() => parseJsonMessage("[]"), "badType");
    expectProtocolError(() => parseJsonMessage("42"), "badType");
    expectProtocolError(() => parseJsonMessage('"hello"'), "badType");
    expectProtocolError(() => parseJsonMessage("{}"), "badType");
    expectProtocolError(() => parseJsonMessage('{"t":42}'), "badType");
    expectProtocolError(() => parseJsonMessage('{"t":null}'), "badType");
    expectProtocolError(() => parseJsonMessage('{"t":"nope"}'), "badType");
    expectProtocolError(() => parseJsonMessage('{"t":"JOIN"}'), "badType");
  });

  test("[FR-4.4] role guards reject wrong-direction messages", () => {
    const join: JsonControlMessage = { t: "join", v: 1, code: "ABCD", pin: "1234" };
    const hostJoin: JsonControlMessage = {
      t: "hostJoin",
      v: 1,
      code: "ABCD",
      hostToken: "h".repeat(22),
    };
    const setLayout: JsonControlMessage = { t: "setLayout", slot: "all", layout: {} };
    const panel: JsonControlMessage = { t: "panel", slot: 1, content: null };
    const joined: JsonControlMessage = {
      t: "joined",
      slot: 1,
      session: "s",
      serverTime: 0,
    };

    expect(isClientToServerMessage(join)).toBe(true);
    expect(isClientToServerMessage(hostJoin)).toBe(true); // host handshake shares this guard
    expect(isClientToServerMessage({ t: "suspend" })).toBe(true);
    expect(isClientToServerMessage({ t: "leave" })).toBe(true);
    expect(isClientToServerMessage({ t: "event", slot: 1, name: "x", data: null })).toBe(true);
    expect(isClientToServerMessage(setLayout)).toBe(false);
    expect(isClientToServerMessage(panel)).toBe(false);
    expect(isClientToServerMessage({ t: "hostPause" })).toBe(false);
    expect(isClientToServerMessage(joined)).toBe(false);

    expect(isHostToServerMessage({ t: "hostPause" })).toBe(true);
    expect(isHostToServerMessage({ t: "hostResume" })).toBe(true);
    expect(isHostToServerMessage(setLayout)).toBe(true);
    expect(isHostToServerMessage(panel)).toBe(true);
    expect(isHostToServerMessage(join)).toBe(false);
    expect(isHostToServerMessage(hostJoin)).toBe(false);
    expect(isHostToServerMessage(joined)).toBe(false);
    expect(isHostToServerMessage({ t: "stats", slots: [] })).toBe(false);
  });

  test("[FR-7.9] parsing keeps opaque bodies canonicalizable", () => {
    // Everything the parser accepts can be re-serialized by stringifyJsonMessage.
    const text = JSON.stringify({
      t: "setLayout",
      slot: 2,
      layout: { id: "canonical-v1", nested: { deep: [1, "two", null, true] } },
    });
    const parsed = parseJsonMessage(text);
    expect(JSON.parse(stringifyJsonMessage(parsed))).toEqual(parsed);
  });
});
