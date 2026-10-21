import { describe, expect, test } from "vitest";
import {
  MAX_CONTROLLERS,
  MAX_JSON_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  isClientToServerMessage,
  isHostToServerMessage,
  parseJsonMessage,
  stringifyJsonMessage,
  type HostStatusState,
  type JsonControlMessage,
  type ServerToClientMessage,
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

function expectHostStatus(
  text: string,
): Extract<ServerToClientMessage, { t: "hostStatus" }> {
  const message = parseJsonMessage(text);
  if (message.t !== "hostStatus") {
    throw new Error(`expected hostStatus, got ${message.t}`);
  }
  return message;
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

describe("D4 session, host-state and reconnect messages (D4-PROTO-01)", () => {
  test("[A9] hostStatus carries active/paused/lost to controllers", () => {
    const states: HostStatusState[] = ["active", "paused", "lost"];
    for (const state of states) {
      const message = { t: "hostStatus", state } as const;
      expect(parseJsonMessage(JSON.stringify(message))).toEqual(message);
      expect(parseJsonMessage(stringifyJsonMessage(message))).toEqual(message);
    }

    // A9 is server -> controller only: neither client guard accepts it.
    const hostStatus: JsonControlMessage = { t: "hostStatus", state: "paused" };
    expect(isClientToServerMessage(hostStatus)).toBe(false);
    expect(isHostToServerMessage(hostStatus)).toBe(false);

    // Unknown top-level fields are dropped, like every other control message.
    expect(
      parseJsonMessage('{"t":"hostStatus","state":"active","extra":true,"slot":3}'),
    ).toEqual({ t: "hostStatus", state: "active" });
  });

  test("[A9] unknown hostStatus state fails with badType", () => {
    expectProtocolError(
      () => parseJsonMessage('{"t":"hostStatus","state":"idle"}'),
      "badType",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"hostStatus","state":"Active"}'),
      "badType",
    );
    expectProtocolError(() => parseJsonMessage('{"t":"hostStatus"}'), "badType");
    expectProtocolError(() => parseJsonMessage('{"t":"hostStatus","state":1}'), "badType");
    expectProtocolError(() => parseJsonMessage('{"t":"hostStatus","state":null}'), "badType");
    expectProtocolError(
      () => parseJsonMessage('{"t":"hostStatus","state":["active"]}'),
      "badType",
    );
  });

  test("[FR-7.16] hostStatus lost is representable on the wire", () => {
    expect(parseJsonMessage('{"t":"hostStatus","state":"lost"}')).toEqual({
      t: "hostStatus",
      state: "lost",
    });
    expect(expectHostStatus('{"t":"hostStatus","state":"lost","reason":"host lost"}')).toEqual({
      t: "hostStatus",
      state: "lost",
    });

    // Host pause/resume frames the broker turns into paused/active, plus the
    // two kick reasons D4-SRV-02/03 use for expiry and unrecovered host loss.
    expect(parseJsonMessage('{"t":"hostPause"}')).toEqual({ t: "hostPause" });
    expect(parseJsonMessage('{"t":"hostResume"}')).toEqual({ t: "hostResume" });
    expect(isHostToServerMessage({ t: "hostPause" })).toBe(true);
    expect(isHostToServerMessage({ t: "hostResume" })).toBe(true);
    expect(isClientToServerMessage({ t: "hostPause" })).toBe(false);
    expect(isClientToServerMessage({ t: "hostResume" })).toBe(false);

    expect(parseJsonMessage('{"t":"kick","reason":"hostLost"}')).toEqual({
      t: "kick",
      reason: "hostLost",
    });
    expect(parseJsonMessage('{"t":"kick","reason":"expired"}')).toEqual({
      t: "kick",
      reason: "expired",
    });
    expectProtocolError(() => parseJsonMessage('{"t":"kick"}'), "badType");
    expectProtocolError(() => parseJsonMessage('{"t":"kick","reason":7}'), "badType");
  });

  test("[FR-5.4] join accepts session alone or token[+pin]; session never combines", () => {
    const session = "s".repeat(22);
    const token = "t".repeat(22);

    expect(
      parseJsonMessage(JSON.stringify({ t: "join", v: 1, code: "ABCD", session })),
    ).toEqual({ t: "join", v: 1, code: "ABCD", session });
    expect(
      parseJsonMessage(JSON.stringify({ t: "join", v: 1, code: "ABCD", token })),
    ).toEqual({ t: "join", v: 1, code: "ABCD", token });
    expect(parseJsonMessage('{"t":"join","v":1,"code":"ABCD","pin":"1234"}')).toEqual({
      t: "join",
      v: 1,
      code: "ABCD",
      pin: "1234",
    });

    // A11 QR PIN mode: token + pin is structurally valid; the broker decides
    // whether the room requires the PIN.
    expect(
      parseJsonMessage(
        JSON.stringify({ t: "join", v: 1, code: "ABCD", token, pin: "1234" }),
      ),
    ).toEqual({ t: "join", v: 1, code: "ABCD", token, pin: "1234" });

    // A session is never combined with the room token or the PIN.
    expectProtocolError(
      () =>
        parseJsonMessage(JSON.stringify({ t: "join", v: 1, code: "ABCD", session, token })),
      "badValue",
    );
    expectProtocolError(
      () =>
        parseJsonMessage(
          JSON.stringify({ t: "join", v: 1, code: "ABCD", session, pin: "1234" }),
        ),
      "badValue",
    );
    expectProtocolError(
      () =>
        parseJsonMessage(
          JSON.stringify({
            t: "join",
            v: 1,
            code: "ABCD",
            session,
            token,
            pin: "1234",
          }),
        ),
      "badValue",
    );

    // No credential at all is malformed, and an empty session is not a token.
    expectProtocolError(
      () => parseJsonMessage('{"t":"join","v":1,"code":"ABCD"}'),
      "badValue",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"join","v":1,"code":"ABCD","session":""}'),
      "badValue",
    );

    // Suspend/leave are field-free controller messages; extra data is dropped.
    expect(parseJsonMessage('{"t":"suspend","slot":3,"reason":"hidden"}')).toEqual({
      t: "suspend",
    });
    expect(parseJsonMessage('{"t":"leave","slot":3}')).toEqual({ t: "leave" });
    expect(isClientToServerMessage({ t: "suspend" })).toBe(true);
    expect(isClientToServerMessage({ t: "leave" })).toBe(true);
  });

  test("[FR-5.3] roomFull and the 1..8 slot bound are representable", () => {
    // The ninth controller is refused with roomFull (server-owned decision).
    expect(parseJsonMessage('{"t":"joinError","reason":"roomFull"}')).toEqual({
      t: "joinError",
      reason: "roomFull",
    });

    // Slot-carrying messages accept exactly P1..P8.
    expect(
      parseJsonMessage('{"t":"joined","slot":8,"session":"s","serverTime":0}'),
    ).toEqual({ t: "joined", slot: 8, session: "s", serverTime: 0 });
    expectProtocolError(
      () => parseJsonMessage('{"t":"joined","slot":9,"session":"s","serverTime":0}'),
      "badValue",
    );
    expect(parseJsonMessage(JSON.stringify({ t: "playerJoined", slot: 8 }))).toEqual({
      t: "playerJoined",
      slot: 8,
    });
    expectProtocolError(
      () => parseJsonMessage(JSON.stringify({ t: "playerJoined", slot: MAX_CONTROLLERS + 1 })),
      "badValue",
    );
    expectProtocolError(
      () => parseJsonMessage(JSON.stringify({ t: "playerLeft", slot: 0 })),
      "badValue",
    );
  });

  test("[FR-5.5] an expired reservation is representable as joinError expired", () => {
    expect(parseJsonMessage('{"t":"joinError","reason":"expired"}')).toEqual({
      t: "joinError",
      reason: "expired",
    });

    // A reservation is opened by playerSuspended and closed by playerResumed
    // (rejoin) or playerLeft (sweep/explicit leave).
    for (const t of ["playerSuspended", "playerResumed", "playerLeft"] as const) {
      expect(parseJsonMessage(JSON.stringify({ t, slot: 3 }))).toEqual({ t, slot: 3 });
      expectProtocolError(() => parseJsonMessage(JSON.stringify({ t })), "badType");
      expectProtocolError(
        () => parseJsonMessage(JSON.stringify({ t, slot: 9 })),
        "badValue",
      );
    }
  });

  test("[SR-6] stats over 8 slots is rejected", () => {
    const eight = Array.from({ length: MAX_CONTROLLERS }, (_, index) => validStat(index + 1));
    expect(parseJsonMessage(JSON.stringify({ t: "stats", slots: eight }))).toEqual({
      t: "stats",
      slots: eight,
    });
    expect(parseJsonMessage('{"t":"stats","slots":[]}')).toEqual({ t: "stats", slots: [] });

    const nine = Array.from({ length: MAX_CONTROLLERS + 1 }, (_, index) => validStat(index + 1));
    expectProtocolError(
      () => parseJsonMessage(JSON.stringify({ t: "stats", slots: nine })),
      "badValue",
    );

    // Each entry still has to be finite and non-negative.
    expectProtocolError(
      () =>
        parseJsonMessage(
          JSON.stringify({ t: "stats", slots: [{ ...validStat(1), rttMs: -1 }] }),
        ),
      "badValue",
    );
    expectProtocolError(
      () =>
        parseJsonMessage(
          JSON.stringify({ t: "stats", slots: [{ ...validStat(1), drops: Number.NaN }] }),
        ),
      "badType",
    );
  });

  test("[SR-6][A9] hostStatus obeys the D0 UTF-8 JSON frame cap", () => {
    const prefix = '{"t":"hostStatus","state":"active","pad":"';
    const suffix = '"}';
    const padding = MAX_JSON_FRAME_BYTES - prefix.length - suffix.length;

    const atLimit = prefix + "x".repeat(padding) + suffix;
    expect(atLimit.length).toBe(MAX_JSON_FRAME_BYTES);
    expect(expectHostStatus(atLimit)).toEqual({ t: "hostStatus", state: "active" });

    const overLimit = prefix + "x".repeat(padding + 1) + suffix;
    expect(overLimit.length).toBe(MAX_JSON_FRAME_BYTES + 1);
    expectProtocolError(() => parseJsonMessage(overLimit), "tooLarge");

    // Byte counting, not character counting: 4096 chars but 4097 UTF-8 bytes.
    const multibyte = prefix + "x".repeat(padding - 1) + "é" + suffix;
    expect(multibyte.length).toBe(MAX_JSON_FRAME_BYTES);
    expectProtocolError(() => parseJsonMessage(multibyte), "tooLarge");
  });

  test("[A10] badVersion is a representable join error reason", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(parseJsonMessage('{"t":"joinError","reason":"badVersion"}')).toEqual({
      t: "joinError",
      reason: "badVersion",
    });
    // The reason is closed: arbitrary strings remain rejected.
    expectProtocolError(
      () => parseJsonMessage('{"t":"joinError","reason":"version"}'),
      "badValue",
    );

    // hostJoin keeps the A2 shape: v is required, hostToken is a 22-char token.
    const hostToken = "h".repeat(22);
    expect(
      parseJsonMessage(
        JSON.stringify({ t: "hostJoin", v: PROTOCOL_VERSION, code: "ABCD", hostToken }),
      ),
    ).toEqual({ t: "hostJoin", v: PROTOCOL_VERSION, code: "ABCD", hostToken });
    expectProtocolError(
      () => parseJsonMessage('{"t":"hostJoin","v":1,"code":"ABCD","hostToken":"short"}'),
      "badLength",
    );
  });

  test("[SR-13] hostStatus is a closed enum with no free-text or UGC channel", () => {
    // Only the three host states are legal, so this session-control message
    // cannot be repurposed to carry user-generated text; extra fields dropped.
    expect(
      parseJsonMessage(
        '{"t":"hostStatus","state":"paused","text":"<script>alert(1)</script>","name":"player"}',
      ),
    ).toEqual({ t: "hostStatus", state: "paused" });
    expectProtocolError(
      () => parseJsonMessage('{"t":"hostStatus","state":"<script>"}'),
      "badType",
    );
  });
});
