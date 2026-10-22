/**
 * D5-SRV-01 layout/panel routing: opaque bodies, panel privacy (SR-13),
 * `content:null` clearing and rejoin replay (FR-8.2). Registry-level: no
 * sockets and an injected clock.
 */
import { describe, expect, test } from "vitest";
import { MAX_LAYOUT_ID_CHARS, type JsonValue } from "@lanpad/protocol";
import { FakePeer, makeRoomHarness } from "./helpers.js";

function layoutOf(id: string): JsonValue {
  return { id, controls: [{ type: "button", id: "jump", event: "jump" }] };
}

describe("panel privacy", () => {
  test("[SR-13] a panel for slot 2 reaches only slot 2 and never the host", () => {
    const h = makeRoomHarness({ controllerCount: 2 });
    const content: JsonValue = { kind: "text", title: "Secret", text: "only slot 2" };

    expect(h.registry.setPanel(h.code, 2, content)).toBe(true);

    expect(h.controllers[1]?.jsonMessages()).toEqual([{ t: "panel", slot: 2, content }]);
    expect(h.controllers[0]?.jsonMessages().filter((message) => message.t === "panel")).toHaveLength(
      0,
    );
    expect(h.host.jsonMessages().filter((message) => message.t === "panel")).toHaveLength(0);
  });

  test("[FR-7.9] panel and layout bodies pass through without interpretation", () => {
    const h = makeRoomHarness();
    const content: JsonValue = {
      kind: "blocks",
      blocks: [{ type: "paragraph", text: "<script>alert(1)</script>" }],
      extra: { numbers: [1, 2, 3] },
    };
    const layout: JsonValue = {
      id: "L-1",
      custom: { deep: [true, null, 3.5] },
      "weird key": "✓",
    };

    expect(h.registry.setPanel(h.code, 1, content)).toBe(true);
    expect(h.registry.setLayout(h.code, 1, layout)).toBe(true);

    expect(h.controllers[0]?.jsonMessages()).toEqual([
      { t: "panel", slot: 1, content },
      { t: "setLayout", slot: 1, layout },
    ]);
  });

  test("[SR-13] content:null keeps a clear marker and forwards the clear", () => {
    const h = makeRoomHarness();
    const room = h.registry.getRoom(h.code);
    if (room === undefined) {
      throw new Error("room fixture disappeared");
    }

    expect(h.registry.setPanel(h.code, 1, { kind: "text", text: "hello" })).toBe(true);
    expect(room.panels.has(1)).toBe(true);

    expect(h.registry.setPanel(h.code, 1, null)).toBe(true);
    expect(room.panels.has(1)).toBe(true);
    expect(room.panels.get(1)).toBeNull();
    expect(h.controllers[0]?.jsonMessages().at(-1)).toEqual({
      t: "panel",
      slot: 1,
      content: null,
    });
  });

  test("[FR-8.2] a panel needs an existing controller slot", () => {
    const h = makeRoomHarness();
    expect(h.registry.setPanel(h.code, 3, { kind: "text", text: "nowhere" })).toBe(false);
    expect(h.host.jsonMessages().filter((message) => message.t === "panel")).toHaveLength(0);
    expect(h.registry.getRoom(h.code)?.panels.size).toBe(0);
  });
});

describe("panel rejoin replay", () => {
  test("[FR-8.2] [FR-5.4] a clear issued while the controller is offline is replayed on rejoin", () => {
    const h = makeRoomHarness();
    const room = h.registry.getRoom(h.code);
    if (room === undefined) {
      throw new Error("room fixture disappeared");
    }
    const original = room.controllers.get(1);
    if (original === undefined) {
      throw new Error("controller fixture disappeared");
    }
    const { session } = original;

    expect(h.registry.setPanel(h.code, 1, { kind: "text", text: "stale" })).toBe(true);
    expect(h.registry.detach(h.code, 1, h.clock.now())).toBe(true);
    expect(room.controllers.get(1)?.peer).toBeNull();

    // The host clears while the slot is reserved: the peer cannot receive the
    // frame, so the clear must be kept for the rejoin.
    const framesBeforeClear = h.controllers[0]?.sent.length ?? 0;
    expect(h.registry.setPanel(h.code, 1, null)).toBe(true);
    expect(h.controllers[0]?.sent.length).toBe(framesBeforeClear);
    expect(room.panels.get(1)).toBeNull();

    const rejoined = new FakePeer();
    const result = h.registry.join({ code: h.code, session }, rejoined);
    if (!result.ok) {
      throw new Error("rejoin failed");
    }
    expect(result.slot).toBe(1);

    expect(h.registry.replayChannelState(h.code, 1)).toBe(1);
    expect(rejoined.jsonMessages()).toEqual([{ t: "panel", slot: 1, content: null }]);
  });

  test("[FR-8.2] a slot that never had a panel receives no panel frame on rejoin", () => {
    const h = makeRoomHarness();
    const room = h.registry.getRoom(h.code);
    if (room === undefined) {
      throw new Error("room fixture disappeared");
    }
    const original = room.controllers.get(1);
    if (original === undefined) {
      throw new Error("controller fixture disappeared");
    }
    const { session } = original;

    // Clearing a slot with no stored panel is a no-op for rejoin state.
    expect(h.registry.setPanel(h.code, 1, null)).toBe(true);
    expect(room.panels.has(1)).toBe(false);
    expect(h.registry.detach(h.code, 1, h.clock.now())).toBe(true);

    const rejoined = new FakePeer();
    const result = h.registry.join({ code: h.code, session }, rejoined);
    if (!result.ok) {
      throw new Error("rejoin failed");
    }

    expect(h.registry.replayChannelState(h.code, 1)).toBe(0);
    expect(rejoined.jsonMessages()).toEqual([]);
  });

  test("[SR-13] a replayed clear for slot 2 reaches only slot 2", () => {
    const h = makeRoomHarness({ controllerCount: 2 });
    const room = h.registry.getRoom(h.code);
    if (room === undefined) {
      throw new Error("room fixture disappeared");
    }
    const second = room.controllers.get(2);
    if (second === undefined) {
      throw new Error("controller fixture disappeared");
    }
    const { session } = second;

    expect(h.registry.setPanel(h.code, 2, { kind: "text", text: "secret" })).toBe(true);
    expect(h.registry.detach(h.code, 2, h.clock.now())).toBe(true);
    expect(h.registry.setPanel(h.code, 2, null)).toBe(true);

    const rejoined = new FakePeer();
    const result = h.registry.join({ code: h.code, session }, rejoined);
    if (!result.ok) {
      throw new Error("rejoin failed");
    }

    expect(h.registry.replayChannelState(h.code, 2)).toBe(1);
    expect(rejoined.jsonMessages()).toEqual([{ t: "panel", slot: 2, content: null }]);
    expect(
      h.controllers[0]?.jsonMessages().filter((message) => message.t === "panel"),
    ).toHaveLength(0);
    expect(h.host.jsonMessages().filter((message) => message.t === "panel")).toHaveLength(0);
  });

  test("[SR-12] a cleared marker is dropped when the slot is freed", () => {
    const h = makeRoomHarness();
    const room = h.registry.getRoom(h.code);
    if (room === undefined) {
      throw new Error("room fixture disappeared");
    }

    expect(h.registry.setPanel(h.code, 1, { kind: "text", text: "p" })).toBe(true);
    expect(h.registry.setPanel(h.code, 1, null)).toBe(true);
    expect(room.panels.get(1)).toBeNull();

    expect(h.registry.leave(h.code, 1, h.clock.now())).toBe(true);
    expect(room.panels.has(1)).toBe(false);
  });
});

describe("layout routing", () => {
  test("[FR-8.2] setLayout all reaches every slot; a numeric slot reaches only that slot", () => {
    const h = makeRoomHarness({ controllerCount: 3 });
    const shared = layoutOf("all-1");

    expect(h.registry.setLayout(h.code, "all", shared)).toBe(true);
    for (const peer of h.controllers) {
      expect(peer.jsonMessages().filter((message) => message.t === "setLayout")).toEqual([
        { t: "setLayout", slot: "all", layout: shared },
      ]);
    }

    const targeted = layoutOf("only-2");
    expect(h.registry.setLayout(h.code, 2, targeted)).toBe(true);
    expect(h.controllers[1]?.jsonMessages().filter((message) => message.t === "setLayout")).toEqual([
      { t: "setLayout", slot: "all", layout: shared },
      { t: "setLayout", slot: 2, layout: targeted },
    ]);
    expect(
      h.controllers[0]?.jsonMessages().filter((message) => message.t === "setLayout"),
    ).toHaveLength(1);
    expect(h.controllers[2]?.jsonMessages().filter((message) => message.t === "setLayout")).toHaveLength(
      1,
    );

    const room = h.registry.getRoom(h.code);
    expect(room?.layouts.get(1)).toEqual(shared);
    expect(room?.layouts.get(2)).toEqual(targeted);
    expect(room?.layouts.get(3)).toEqual(shared);
  });

  test("[FR-7.9] only objects with a 1..64 character string id are accepted", () => {
    const h = makeRoomHarness();

    expect(h.registry.setLayout(h.code, "all", null)).toBe(false);
    expect(h.registry.setLayout(h.code, "all", [])).toBe(false);
    expect(h.registry.setLayout(h.code, "all", { id: "" })).toBe(false);
    expect(h.registry.setLayout(h.code, "all", { id: 42 })).toBe(false);
    expect(h.registry.setLayout(h.code, "all", { noId: true })).toBe(false);
    expect(h.registry.setLayout(h.code, "all", { id: "x".repeat(MAX_LAYOUT_ID_CHARS + 1) })).toBe(
      false,
    );
    expect(h.registry.setLayout(h.code, 9, layoutOf("L"))).toBe(false);
    expect(h.registry.setLayout(h.code, 3, layoutOf("L"))).toBe(false);

    // The host never receives its own layout back.
    expect(h.host.jsonMessages().filter((message) => message.t === "setLayout")).toHaveLength(0);
    expect(h.registry.getRoom(h.code)?.layouts.size).toBe(0);
  });

  test("[FR-8.2] a reserved slot's layout and panel are replayed after rejoin", () => {
    const h = makeRoomHarness();
    const room = h.registry.getRoom(h.code);
    if (room === undefined) {
      throw new Error("room fixture disappeared");
    }
    const original = room.controllers.get(1);
    if (original === undefined) {
      throw new Error("controller fixture disappeared");
    }
    const { session } = original;
    const layout = layoutOf("L-rejoin");
    const panel: JsonValue = { kind: "text", text: "welcome back" };

    expect(h.registry.setLayout(h.code, 1, layout)).toBe(true);
    expect(h.registry.setPanel(h.code, 1, panel)).toBe(true);

    // A transport drop reserves the slot; both bodies survive for replay.
    expect(h.registry.detach(h.code, 1, h.clock.now())).toBe(true);
    expect(room.controllers.get(1)?.peer).toBeNull();
    expect(room.layouts.get(1)).toEqual(layout);
    expect(room.panels.get(1)).toEqual(panel);

    const rejoined = new FakePeer();
    const result = h.registry.join({ code: h.code, session }, rejoined);
    expect(result.ok).toBe(true);
    expect(h.registry.replayChannelState(h.code, 1)).toBe(2);
    expect(rejoined.jsonMessages()).toEqual([
      { t: "setLayout", slot: 1, layout },
      { t: "panel", slot: 1, content: panel },
    ]);
  });

  test("[SR-12] channel state is cleared on leave and on reservation expiry", () => {
    const h = makeRoomHarness({ controllerCount: 2 });
    expect(h.registry.setLayout(h.code, 1, layoutOf("L1"))).toBe(true);
    expect(h.registry.setPanel(h.code, 1, { kind: "text", text: "p1" })).toBe(true);
    expect(h.registry.setLayout(h.code, 2, layoutOf("L2"))).toBe(true);
    expect(h.registry.setPanel(h.code, 2, { kind: "text", text: "p2" })).toBe(true);

    expect(h.registry.leave(h.code, 1, h.clock.now())).toBe(true);
    const room = h.registry.getRoom(h.code);
    if (room === undefined) {
      throw new Error("room fixture disappeared");
    }
    expect(room.layouts.has(1)).toBe(false);
    expect(room.panels.has(1)).toBe(false);
    expect(room.layouts.get(2)).toEqual(layoutOf("L2"));

    expect(h.registry.detach(h.code, 2, h.clock.now())).toBe(true);
    h.clock.advance(30_001);
    h.registry.sweep(h.clock.now());
    expect(room.layouts.has(2)).toBe(false);
    expect(room.panels.has(2)).toBe(false);
  });

  test("[SR-12] room expiry clears every stored layout and panel", () => {
    const h = makeRoomHarness();
    expect(h.registry.setLayout(h.code, 1, layoutOf("L"))).toBe(true);
    expect(h.registry.setPanel(h.code, 1, { kind: "text", text: "p" })).toBe(true);
    const room = h.registry.getRoom(h.code);
    if (room === undefined) {
      throw new Error("room fixture disappeared");
    }

    h.clock.advance(4 * 60 * 60 * 1000 + 1);
    h.registry.sweep(h.clock.now());

    expect(h.registry.getRoom(h.code)).toBeUndefined();
    expect(room.layouts.size).toBe(0);
    expect(room.panels.size).toBe(0);
  });

  test("[SR-12] host-loss expiry clears stored channel state", () => {
    const h = makeRoomHarness();
    expect(h.registry.setLayout(h.code, 1, layoutOf("L"))).toBe(true);
    expect(h.registry.setPanel(h.code, 1, { kind: "text", text: "p" })).toBe(true);
    const room = h.registry.getRoom(h.code);
    if (room === undefined) {
      throw new Error("room fixture disappeared");
    }

    expect(h.registry.hostLeave(h.code, h.host)).toBe(true);
    h.clock.advance(30_001);
    h.registry.sweep(h.clock.now());

    expect(h.registry.getRoom(h.code)).toBeUndefined();
    expect(room.layouts.size).toBe(0);
    expect(room.panels.size).toBe(0);
  });
});
