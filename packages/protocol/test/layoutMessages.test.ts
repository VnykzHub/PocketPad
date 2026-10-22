import { describe, expect, test } from "vitest";
import {
  MAX_JSON_FRAME_BYTES,
  MAX_LAYOUT_JSON_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  isClientToServerMessage,
  isEventSlotBoundTo,
  isHostToServerMessage,
  jsonByteLength,
  parseJsonMessage,
  stringifyJsonMessage,
  type EventMessage,
  type JsonControlMessage,
  type JsonValue,
  type LayoutAckForwardMessage,
  type LayoutAckMessage,
  type ServerToClientMessage,
  type StrokeEventData,
  type ValueEventData,
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

function expectEvent(text: string): EventMessage {
  const message = parseJsonMessage(text);
  if (message.t !== "event") {
    throw new Error(`expected event, got ${message.t}`);
  }
  return message;
}

function expectLayoutAck(text: string): LayoutAckMessage | LayoutAckForwardMessage {
  const message = parseJsonMessage(text);
  if (message.t !== "layoutAck") {
    throw new Error(`expected layoutAck, got ${message.t}`);
  }
  return message;
}

/** Builds an ASCII event frame whose serialized JSON is exactly `byteLength` bytes. */
const EVENT_PREFIX_LENGTH = JSON.stringify({
  t: "event",
  slot: 1,
  name: "x",
  data: "",
}).length;

function asciiEventFrame(byteLength: number): string {
  const padding = byteLength - EVENT_PREFIX_LENGTH;
  expect(padding).toBeGreaterThanOrEqual(0);
  return JSON.stringify({ t: "event", slot: 1, name: "x", data: "x".repeat(padding) });
}

const STROKE_DATA: StrokeEventData = {
  points: [
    { x: 0.125, y: 0.25, t: 0 },
    { x: 0.5, y: 0.75, t: 16 },
  ],
  color: "#ffffff",
  width: 6,
  phase: "start",
};

const VALUE_DATA: ValueEventData = { value: "hello" };

// Compile-time shape checks: the controller ack has no `slot`, the server
// forward has a required one, and event data stays an opaque JsonValue.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Expect<T extends true> = T;
type AckHasNoSlot = Expect<Equal<"slot" extends keyof LayoutAckMessage ? true : false, false>>;
type ForwardHasSlot = Expect<Equal<LayoutAckForwardMessage["slot"], number>>;
type EventDataIsJson = Expect<Equal<EventMessage["data"], JsonValue>>;
type StrokePhase = Expect<Equal<StrokeEventData["phase"], "start" | "move" | "end">>;

const ackHasNoSlot: AckHasNoSlot = true;
const forwardHasSlot: ForwardHasSlot = true;
const eventDataIsJson: EventDataIsJson = true;
const strokePhase: StrokePhase = true;

describe("D5 layout, panel and event messages (D5-PROTO-01)", () => {
  test("[FR-8.2] layoutAck carries the layout id and an optional server-filled slot", () => {
    expect(PROTOCOL_VERSION).toBe(1);

    const ack: LayoutAckMessage = { t: "layoutAck", layoutId: "platformer-v1" };
    expect(parseJsonMessage(JSON.stringify(ack))).toEqual(ack);
    expect(parseJsonMessage(stringifyJsonMessage(ack))).toEqual(ack);

    // The server forwards the same ack to the host with the authenticated slot
    // filled in (D5-SRV-01); every slot in 1..8 is representable.
    for (let slot = 1; slot <= 8; slot += 1) {
      const forward: LayoutAckForwardMessage = {
        t: "layoutAck",
        layoutId: "platformer-v1",
        slot,
      };
      expect(parseJsonMessage(JSON.stringify(forward))).toEqual(forward);
      const serverMessage: ServerToClientMessage = forward;
      expect(serverMessage.t).toBe("layoutAck");
    }

    // Unknown top-level fields are dropped, not copied through.
    expect(
      parseJsonMessage('{"t":"layoutAck","layoutId":"l1","extra":true,"slot":3}'),
    ).toEqual({ t: "layoutAck", layoutId: "l1", slot: 3 });

    // D5-PROTO-01 does not change the wire version.
    expect(ackHasNoSlot).toBe(true);
    expect(forwardHasSlot).toBe(true);
    expect(eventDataIsJson).toBe(true);
    expect(strokePhase).toBe(true);
  });

  test("[FR-8.2] layoutAck validates the id and the optional slot", () => {
    expectProtocolError(() => parseJsonMessage('{"t":"layoutAck"}'), "badType");
    expectProtocolError(() => parseJsonMessage('{"t":"layoutAck","layoutId":7}'), "badType");
    expectProtocolError(
      () => parseJsonMessage('{"t":"layoutAck","layoutId":null}'),
      "badType",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"layoutAck","layoutId":""}'),
      "badLength",
    );
    expectProtocolError(
      () => parseJsonMessage(JSON.stringify({ t: "layoutAck", layoutId: "l".repeat(65) })),
      "badLength",
    );

    // Exactly 64 characters is the layout id limit (D5 contract 1).
    const longest = "l".repeat(64);
    expect(parseJsonMessage(JSON.stringify({ t: "layoutAck", layoutId: longest }))).toEqual({
      t: "layoutAck",
      layoutId: longest,
    });

    // A server-filled slot is range-checked like every other slot.
    for (const slot of [0, 9, 1.5]) {
      expectProtocolError(
        () => parseJsonMessage(JSON.stringify({ t: "layoutAck", layoutId: "l1", slot })),
        "badValue",
      );
    }
    for (const slot of ["1", null, true, []] as const) {
      expectProtocolError(
        () => parseJsonMessage(JSON.stringify({ t: "layoutAck", layoutId: "l1", slot })),
        "badType",
      );
    }
  });

  test("[FR-7.8] event validates slot, safe name and opaque data", () => {
    const event: EventMessage = {
      t: "event",
      slot: 4,
      name: "goal",
      data: { points: 2, tags: ["a"] },
    };
    expect(parseJsonMessage(JSON.stringify(event))).toEqual(event);
    expect(parseJsonMessage(stringifyJsonMessage(event))).toEqual(event);

    // `data` is any JsonValue, including null and primitives.
    for (const data of [null, 0, -1.5, "text", true, [], [1, "two", null], {}] as const) {
      expect(parseJsonMessage(JSON.stringify({ t: "event", slot: 1, name: "x", data }))).toEqual(
        { t: "event", slot: 1, name: "x", data },
      );
    }

    // D5 contract 5: batched stroke data passes through untouched.
    expect(
      parseJsonMessage(
        JSON.stringify({ t: "event", slot: 2, name: "draw.stroke", data: STROKE_DATA }),
      ),
    ).toEqual({ t: "event", slot: 2, name: "draw.stroke", data: STROKE_DATA });

    // D5 contract 6: text and choice submissions are `{value}`.
    expect(
      parseJsonMessage(
        JSON.stringify({ t: "event", slot: 3, name: "answer", data: VALUE_DATA }),
      ),
    ).toEqual({ t: "event", slot: 3, name: "answer", data: VALUE_DATA });
    expect(
      parseJsonMessage(
        JSON.stringify({ t: "event", slot: 3, name: "vote", data: { value: "B" } }),
      ),
    ).toEqual({ t: "event", slot: 3, name: "vote", data: { value: "B" } });

    // Slot range.
    for (let slot = 1; slot <= 8; slot += 1) {
      expect(
        parseJsonMessage(JSON.stringify({ t: "event", slot, name: "x", data: null })),
      ).toEqual({ t: "event", slot, name: "x", data: null });
    }
    for (const slot of [0, 9, -1, 1.5]) {
      expectProtocolError(
        () => parseJsonMessage(JSON.stringify({ t: "event", slot, name: "x", data: null })),
        "badValue",
      );
    }
    expectProtocolError(() => parseJsonMessage('{"t":"event","name":"x","data":null}'), "badType");
    expectProtocolError(
      () => parseJsonMessage('{"t":"event","slot":"1","name":"x","data":null}'),
      "badType",
    );

    // Name length: 1..64 characters.
    expect(parseJsonMessage('{"t":"event","slot":1,"name":"A","data":null}')).toEqual({
      t: "event",
      slot: 1,
      name: "A",
      data: null,
    });
    const longestName = `a${"b".repeat(63)}`;
    expect(
      parseJsonMessage(JSON.stringify({ t: "event", slot: 1, name: longestName, data: null })),
    ).toEqual({ t: "event", slot: 1, name: longestName, data: null });
    expectProtocolError(
      () => parseJsonMessage('{"t":"event","slot":1,"name":"","data":null}'),
      "badLength",
    );
    expectProtocolError(
      () =>
        parseJsonMessage(
          JSON.stringify({ t: "event", slot: 1, name: `a${"b".repeat(64)}`, data: null }),
        ),
      "badLength",
    );
    expectProtocolError(
      () => parseJsonMessage('{"t":"event","slot":1,"name":7,"data":null}'),
      "badType",
    );

    // `data` is required, even when null.
    expectProtocolError(() => parseJsonMessage('{"t":"event","slot":1,"name":"x"}'), "badType");

    // Unknown top-level fields are dropped.
    expect(
      parseJsonMessage('{"t":"event","slot":1,"name":"x","data":null,"extra":"<b>"}'),
    ).toEqual({ t: "event", slot: 1, name: "x", data: null });
  });

  test("[FR-7.8] event slot binding never trusts the controller-supplied slot", () => {
    // The parser preserves whatever the controller claimed; the broker must
    // compare it with the slot assigned at join before forwarding.
    const claimed = expectEvent('{"t":"event","slot":3,"name":"x","data":null}');
    expect(claimed.slot).toBe(3);
    expect(isEventSlotBoundTo(claimed, 3)).toBe(true);
    for (const authenticatedSlot of [1, 2, 4, 5, 6, 7, 8]) {
      expect(isEventSlotBoundTo(claimed, authenticatedSlot)).toBe(false);
    }

    // Same check for a stroke event; the body is irrelevant to routing.
    const stroke = expectEvent(
      JSON.stringify({ t: "event", slot: 8, name: "draw.stroke", data: STROKE_DATA }),
    );
    expect(isEventSlotBoundTo(stroke, 8)).toBe(true);
    expect(isEventSlotBoundTo(stroke, 7)).toBe(false);
  });

  test("[SR-13] event names are identifiers, not markup", () => {
    const hostileNames = [
      "<script>alert(1)</script>",
      "\"><img src=x onerror=alert(1)>",
      "javascript:alert(1)",
      "data:text/html,<script>",
      "answer value",
      "1answer",
      "_answer",
      "answer:value",
      "answer/value",
      "answer\u0000",
      "éclair",
    ];
    for (const name of hostileNames) {
      expectProtocolError(
        () => parseJsonMessage(JSON.stringify({ t: "event", slot: 1, name, data: null })),
        "badValue",
      );
    }

    // The safe grammar from D5-SEC-01: letters start; letters, digits, `_`,
    // `.` and `-` may follow.
    for (const name of ["answer", "A", "draw.start", "choice_1-2", "vote-option.2"]) {
      expect(parseJsonMessage(JSON.stringify({ t: "event", slot: 1, name, data: null }))).toEqual(
        { t: "event", slot: 1, name, data: null },
      );
    }

    // Hostile payloads stay opaque data: the protocol never turns a string
    // into markup and never interprets `data` (FR-7.9, SR-13).
    const payload = "<img src=x onerror=alert(1)>";
    const parsed = expectEvent(
      JSON.stringify({ t: "event", slot: 1, name: "answer", data: { value: payload } }),
    );
    expect((parsed.data as { value: string }).value).toBe(payload);
    expect(typeof parsed.data).toBe("object");
  });

  test("[FR-7.9] setLayout, panel and event bodies pass through without interpretation", () => {
    const layout = {
      id: "bomb-defusal-v2",
      orientation: "landscape",
      background: "#101014",
      controls: [
        {
          type: "button",
          id: "cut-red",
          label: "Cut red",
          shape: "circle",
          x: "82%",
          y: "70%",
          r: "11%",
          bit: 0,
        },
        { type: "panel", id: "manual", x: "30%", y: "10%", w: "40%", h: "30%" },
      ],
      unknownFutureField: { nested: [1, 2, { deep: true }] },
    };
    expect(parseJsonMessage(JSON.stringify({ t: "setLayout", slot: "all", layout }))).toEqual({
      t: "setLayout",
      slot: "all",
      layout,
    });
    expect(
      parseJsonMessage(JSON.stringify({ t: "setLayout", slot: 3, layout })),
    ).toEqual({ t: "setLayout", slot: 3, layout });

    // Protocol validation is structural only: a body the SDK would reject is
    // still forwarded untouched (the controller rejects it and does not ack).
    const malformed = { id: "x", controls: "not-an-array", hostile: "<script>alert(1)</script>" };
    expect(parseJsonMessage(JSON.stringify({ t: "setLayout", slot: 1, layout: malformed }))).toEqual(
      { t: "setLayout", slot: 1, layout: malformed },
    );

    // The one field the server reads is `layout.id`; it must exist and fit.
    expectProtocolError(() => parseJsonMessage('{"t":"setLayout","slot":1}'), "badType");
    expectProtocolError(() => parseJsonMessage('{"t":"setLayout","slot":1,"layout":null}'), "badType");
    expectProtocolError(() => parseJsonMessage('{"t":"setLayout","slot":1,"layout":[]}'), "badType");
    expectProtocolError(() => parseJsonMessage('{"t":"setLayout","slot":1,"layout":"x"}'), "badType");
    expectProtocolError(() => parseJsonMessage('{"t":"setLayout","slot":1,"layout":{}}'), "badType");
    expectProtocolError(
      () => parseJsonMessage('{"t":"setLayout","slot":1,"layout":{"id":""}}'),
      "badLength",
    );
    expectProtocolError(
      () =>
        parseJsonMessage(
          JSON.stringify({ t: "setLayout", slot: 1, layout: { id: "l".repeat(65) } }),
        ),
      "badLength",
    );

    // Panel content is any JsonValue; null is the documented clear path.
    expect(parseJsonMessage('{"t":"panel","slot":2,"content":null}')).toEqual({
      t: "panel",
      slot: 2,
      content: null,
    });
    const content = {
      kind: "blocks",
      blocks: [
        { type: "heading", text: "Secret" },
        { type: "paragraph", text: "<script>alert(1)</script>" },
      ],
    };
    expect(parseJsonMessage(JSON.stringify({ t: "panel", slot: 2, content }))).toEqual({
      t: "panel",
      slot: 2,
      content,
    });
    expectProtocolError(() => parseJsonMessage('{"t":"panel","slot":2}'), "badType");
    expectProtocolError(() => parseJsonMessage('{"t":"panel","content":null}'), "badType");
    expectProtocolError(() => parseJsonMessage('{"t":"panel","slot":9,"content":null}'), "badValue");
  });

  test("[FR-7.2] button bit assignments survive the opaque layout body", () => {
    // Layout `button.bit` values map onto the FR-7.2 bitfield. The wire layer
    // must not renumber, clamp or reorder them; the SDK validates the ranges.
    const controls = Array.from({ length: 16 }, (_, bit) => ({
      type: "button",
      id: `button-${bit}`,
      label: `B${bit}`,
      shape: "circle",
      x: "50%",
      y: "50%",
      r: "5%",
      bit,
    }));
    const layout = { id: "bits-v1", orientation: "any", controls };

    const parsed = parseJsonMessage(JSON.stringify({ t: "setLayout", slot: 1, layout }));
    expect(parsed).toEqual({ t: "setLayout", slot: 1, layout });
    expect((parsed as Extract<JsonControlMessage, { t: "setLayout" }>).layout).toEqual(layout);

    // Event data may reference a button bit; it stays opaque data.
    const bitEvent = { t: "event", slot: 1, name: "button", data: { bit: 15 } };
    expect(parseJsonMessage(JSON.stringify(bitEvent))).toEqual(bitEvent);
  });

  test("[FR-7.9] layout, panel and event messages obey their direction", () => {
    const setLayout: JsonControlMessage = { t: "setLayout", slot: "all", layout: { id: "l1" } };
    const panel: JsonControlMessage = { t: "panel", slot: 1, content: null };
    const event: JsonControlMessage = { t: "event", slot: 1, name: "x", data: null };
    const ack: JsonControlMessage = { t: "layoutAck", layoutId: "l1" };

    expect(isClientToServerMessage(setLayout)).toBe(false);
    expect(isHostToServerMessage(setLayout)).toBe(true);
    expect(isClientToServerMessage(panel)).toBe(false);
    expect(isHostToServerMessage(panel)).toBe(true);

    expect(isClientToServerMessage(event)).toBe(true);
    expect(isHostToServerMessage(event)).toBe(false);
    expect(isClientToServerMessage(ack)).toBe(true);
    expect(isHostToServerMessage(ack)).toBe(false);

    // Both client-originated messages are representable on the server→host
    // leg after routing (event unchanged, ack with the peer slot filled).
    const forwardedEvent: ServerToClientMessage = {
      t: "event",
      slot: 1,
      name: "x",
      data: null,
    };
    const forwardedAck: ServerToClientMessage = {
      t: "layoutAck",
      layoutId: "l1",
      slot: 1,
    };
    expect(forwardedEvent.t).toBe("event");
    expect(forwardedAck.t).toBe("layoutAck");
  });

  test("[SR-6][FR-8.2][A13] event frames are capped at 4096; setLayout may reach 16 KB (A13)", () => {
    // Exactly 4096 ASCII bytes is accepted; 4097 is rejected before parsing.
    const atLimit = asciiEventFrame(MAX_JSON_FRAME_BYTES);
    expect(atLimit.length).toBe(MAX_JSON_FRAME_BYTES);
    expect(jsonByteLength(atLimit)).toBe(MAX_JSON_FRAME_BYTES);
    expectEvent(atLimit);

    const overLimit = asciiEventFrame(MAX_JSON_FRAME_BYTES + 1);
    expect(jsonByteLength(overLimit)).toBe(MAX_JSON_FRAME_BYTES + 1);
    expectProtocolError(() => parseJsonMessage(overLimit), "tooLarge");

    // Byte counting, not character counting: 4096 characters but 4097 bytes.
    const padding = MAX_JSON_FRAME_BYTES - EVENT_PREFIX_LENGTH;
    const multibyte = JSON.stringify({
      t: "event",
      slot: 1,
      name: "x",
      data: `${"x".repeat(padding - 1)}é`,
    });
    expect(multibyte.length).toBe(MAX_JSON_FRAME_BYTES);
    expect(jsonByteLength(multibyte)).toBe(MAX_JSON_FRAME_BYTES + 1);
    expectProtocolError(() => parseJsonMessage(multibyte), "tooLarge");

    // A13: setLayout is the one type that may exceed 4 KB because the SDK
    // validator accepts layouts up to 16 KB, but the 16 KB frame ceiling holds.
    const largeLayout = { id: "big-v1", blob: "x".repeat(MAX_JSON_FRAME_BYTES) };
    expect(
      jsonByteLength(stringifyJsonMessage({ t: "setLayout", slot: "all", layout: largeLayout })),
    ).toBeGreaterThan(MAX_JSON_FRAME_BYTES);
    const oversizedLayout = { id: "big-v1", blob: "x".repeat(MAX_LAYOUT_JSON_FRAME_BYTES) };
    expectProtocolError(
      () => stringifyJsonMessage({ t: "setLayout", slot: "all", layout: oversizedLayout }),
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

  test("[SR-6] parseJsonMessage rejects an oversized event before JSON parsing", () => {
    // The cap is checked first, so a huge malformed frame costs one byte
    // count and never reaches JSON.parse (SR-6).
    const hostile = "not json ".repeat(MAX_JSON_FRAME_BYTES);
    expectProtocolError(() => parseJsonMessage(hostile), "tooLarge");

    // A 4.1 KB valid event frame is rejected at the frame layer exactly like
    // an oversized panel frame; only setLayout gets the 16 KB cap (A13).
    expectProtocolError(
      () => parseJsonMessage(asciiEventFrame(MAX_JSON_FRAME_BYTES + 100)),
      "tooLarge",
    );

    // LayoutAck and small control messages stay well under the cap.
    expectLayoutAck('{"t":"layoutAck","layoutId":"l1"}');
  });
});
