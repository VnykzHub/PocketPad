import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUTTON_BITS,
  MSG,
  PROTOCOL_VERSION,
  decodeInput,
  decodePing,
  encodePong,
} from "@lanpad/protocol";
import type { LayoutDocument } from "@lanpad/sdk";
import {
  ControllerClient,
  JOIN_ERROR_TEXT,
  connectionPillLabel,
  type ControllerSocket,
} from "../src/net/controllerClient.js";

const A_MASK = 1 << BUTTON_BITS.A;
const SURFACE_SIZE = { width: 800, height: 400 } as const;

/** Minimal fake socket; records exactly what the client writes. */
class FakeSocket implements ControllerSocket {
  readonly sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    // The client detaches handlers before closing; nothing to observe here.
  }

  open(): void {
    this.onopen?.();
  }

  /** Simulates the server closing the socket (no handlers detached by us). */
  serverClose(code = 1006, reason = "lost"): void {
    this.onclose?.({ code, reason });
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  deliverBinary(frame: Uint8Array): void {
    this.onmessage?.({ data: frame });
  }

  frames(): Uint8Array[] {
    return this.sent.filter((entry): entry is Uint8Array => entry instanceof Uint8Array);
  }

  inputs(): Uint8Array[] {
    return this.frames().filter((frame) => frame[0] === MSG.Input);
  }

  pings(): Uint8Array[] {
    return this.frames().filter((frame) => frame[0] === MSG.Ping);
  }

  texts(): string[] {
    return this.sent.filter((entry): entry is string => typeof entry === "string");
  }
}

/** D2 layout: one button, one d-pad and one fixed stick (FR-8.1). */
const LAYOUT: LayoutDocument = {
  id: "platformer-v1",
  orientation: "landscape",
  background: "#101014",
  controls: [
    {
      type: "button",
      id: "jump",
      label: "Jump",
      shape: "circle",
      x: "82%",
      y: "70%",
      r: "11%",
      bit: 0,
    },
    {
      type: "dpad",
      id: "move",
      x: "20%",
      y: "72%",
      size: "28%",
      bits: { up: 8, down: 9, left: 10, right: 11 },
    },
    {
      type: "stick",
      id: "aim",
      x: "50%",
      y: "50%",
      size: "24%",
      axis: "right",
      mode: "fixed",
    },
  ],
};

const SECOND_LAYOUT: LayoutDocument = {
  id: "second-v1",
  orientation: "landscape",
  controls: [
    {
      type: "button",
      id: "dash",
      label: "Dash",
      shape: "square",
      x: "50%",
      y: "50%",
      r: "10%",
      bit: 2,
    },
  ],
};

/** Two buttons placed far apart for sub-tick edge tests (FR-7.3, FR-8.7). */
const TAP_LAYOUT: LayoutDocument = {
  id: "tap-v1",
  orientation: "landscape",
  controls: [
    {
      type: "button",
      id: "left",
      label: "Left",
      shape: "circle",
      x: "25%",
      y: "50%",
      r: "10%",
      bit: 0,
    },
    {
      type: "button",
      id: "right",
      label: "Right",
      shape: "circle",
      x: "75%",
      y: "50%",
      r: "10%",
      bit: 1,
    },
  ],
};

/** A structurally valid layout containing a control type D2 cannot render. */
const MIXED_LAYOUT: LayoutDocument = {
  id: "mixed-v1",
  orientation: "landscape",
  controls: [
    {
      type: "button",
      id: "fire",
      label: "Fire",
      shape: "rounded",
      x: "50%",
      y: "80%",
      r: "12%",
      bit: 4,
    },
    {
      type: "panel",
      id: "score",
      x: "50%",
      y: "12%",
      w: "40%",
      h: "16%",
    },
  ],
};

let nowMs = 0;
let socket: FakeSocket;
let client: ControllerClient;
let surface: HTMLDivElement;
let socketsCreated = 0;

beforeEach(() => {
  vi.useFakeTimers();
  nowMs = 1_000;
  socket = new FakeSocket();
  socketsCreated = 0;
  surface = document.createElement("div");
  document.body.append(surface);
  client = new ControllerClient({
    origin: "http://localhost:8080",
    createSocket: () => {
      socketsCreated += 1;
      return socket;
    },
    now: () => nowMs,
    surface,
    surfaceSize: SURFACE_SIZE,
  });
});

afterEach(() => {
  client.disconnect();
  surface.remove();
  vi.useRealTimers();
});

/** Advances the injected clock and the fake timers in lockstep. */
function advance(ms: number): void {
  nowMs += ms;
  vi.advanceTimersByTime(ms);
}

/** Connects, opens the socket and completes the join at serverTime 5000 ms. */
function join(slot = 1, layout?: LayoutDocument): void {
  client.connect("ABCD", "1234");
  socket.open();
  const joined: Record<string, unknown> = {
    t: "joined",
    slot,
    session: "session-1",
    serverTime: 5_000,
  };
  if (layout !== undefined) {
    joined["layout"] = layout;
  }
  socket.deliver(joined);
}

interface TouchPoint {
  identifier: number;
  clientX: number;
  clientY: number;
}

function touch(identifier: number, clientX: number, clientY: number): TouchPoint {
  return { identifier, clientX, clientY };
}

/** jsdom has no TouchEvent; the engine only reads `changedTouches`. */
function dispatchTouch(
  target: HTMLElement,
  type: string,
  points: TouchPoint[],
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "changedTouches", { value: points });
  Object.defineProperty(event, "touches", { value: points });
  target.dispatchEvent(event);
  return event;
}

describe("[FR-5.6] manual join over the same-origin socket", () => {
  it("[FR-5.6] sends join {v, code, pin} once the socket opens", () => {
    client.connect("ABCD", "1234");
    expect(socket.texts()).toHaveLength(0);

    socket.open();
    expect(socket.texts()).toHaveLength(1);
    expect(JSON.parse(socket.texts()[0] ?? "null")).toEqual({
      t: "join",
      v: PROTOCOL_VERSION,
      code: "ABCD",
      pin: "1234",
    });
  });

  it("[FR-5.6] joined shows the assigned slot in the connection pill", () => {
    join(2);

    expect(client.currentState).toEqual({ status: "connected", slot: 2, error: null });
    expect(connectionPillLabel(client.currentState)).toBe("Connected (P2)");
  });

  it("[FR-5.6] a join error is readable and returns to the editable form state", () => {
    client.connect("ABCD", "0000");
    socket.open();
    socket.deliver({ t: "joinError", reason: "badPin" });

    expect(client.currentState.status).toBe("disconnected");
    expect(client.currentState.error).toBe(JOIN_ERROR_TEXT.badPin);
    expect(client.currentState.error).toContain("PIN");
    expect(connectionPillLabel(client.currentState)).toBe("Disconnected");
  });
});

describe("[FR-8.5] connection pill reflects real socket state", () => {
  it("[FR-8.5] pill is Disconnected until joined, Connected after, and Disconnected on close", () => {
    expect(connectionPillLabel(client.currentState)).toBe("Disconnected");

    client.connect("ABCD", "1234");
    expect(connectionPillLabel(client.currentState)).toBe("Connecting");

    socket.open();
    expect(connectionPillLabel(client.currentState)).toBe("Connecting");

    socket.deliver({ t: "joined", slot: 3, session: "session-1", serverTime: 5_000 });
    expect(connectionPillLabel(client.currentState)).toBe("Connected (P3)");

    socket.serverClose();
    expect(connectionPillLabel(client.currentState)).toBe("Disconnected");
  });
});

describe("[FR-7.1] controller send policy starts only after joined", () => {
  it("[FR-7.1] nothing is sent before joined; joined emits an empty packet and a Ping", () => {
    client.connect("ABCD", "1234");
    socket.open();
    advance(1_000);
    expect(socket.inputs()).toHaveLength(0);
    expect(socket.pings()).toHaveLength(0);

    socket.deliver({ t: "joined", slot: 1, session: "session-1", serverTime: 5_000 });

    const inputs = socket.inputs();
    expect(inputs).toHaveLength(1);
    const initial = decodeInput(inputs[0] as Uint8Array);
    // No Pong yet: ClockSync reports 0 rather than a fake timestamp (A3).
    expect(initial.tick).toBe(0);
    expect(initial.buttons).toBe(0);
    expect(initial.edges).toBe(0);
    expect(socket.pings()).toHaveLength(1);
  });

  it("[FR-7.1] idle keepalive runs at 10 Hz when no input is held", () => {
    join();

    advance(1_000);

    // One initial packet plus ten 100 ms keepalives.
    expect(socket.inputs()).toHaveLength(11);
  });

  it("[FR-7.1] a change is sent immediately when outside the 4 ms window", () => {
    join();
    advance(5);

    client.press();

    const inputs = socket.inputs();
    expect(inputs).toHaveLength(2);
    const press = decodeInput(inputs[1] as Uint8Array);
    expect(press.buttons).toBe(A_MASK);
    expect(press.edges).toBe(A_MASK);
  });

  it("[FR-7.1] held input runs at 60 Hz and returns to 10 Hz after release", () => {
    join();
    advance(5);
    client.press();
    const afterPress = socket.inputs().length;

    advance(1_000);
    const activePackets = socket.inputs().length - afterPress;
    expect(activePackets).toBeGreaterThanOrEqual(55);
    expect(activePackets).toBeLessThanOrEqual(62);
    for (const frame of socket.inputs().slice(afterPress)) {
      expect(decodeInput(frame).buttons).toBe(A_MASK);
      expect(decodeInput(frame).edges).toBe(0);
    }

    client.release();
    advance(4);
    const afterRelease = socket.inputs().length;
    expect(decodeInput(socket.inputs()[afterRelease - 1] as Uint8Array).buttons).toBe(0);

    advance(1_000);
    const idlePackets = socket.inputs().length - afterRelease;
    expect(idlePackets).toBeGreaterThanOrEqual(9);
    expect(idlePackets).toBeLessThanOrEqual(11);
  });

  it("[FR-7.1] press and idle are ignored before the join completes", () => {
    client.connect("ABCD", "1234");
    socket.open();

    client.press();
    advance(500);

    expect(socket.inputs()).toHaveLength(0);
  });
});

describe("[FR-7.3] edge preservation and timing", () => {
  it("[FR-7.3] a press and release inside one 4 ms window carries the edge", () => {
    join();
    // The initial packet was sent at t=1000; both changes land in its window.
    client.press();
    advance(1);
    client.release();

    advance(3);
    const inputs = socket.inputs();
    expect(inputs).toHaveLength(2);
    const last = decodeInput(inputs[1] as Uint8Array);
    expect(last.buttons).toBe(0);
    expect(last.edges).toBe(A_MASK);
  });

  it("[FR-7.3] release packets never repeat a previously sent edge", () => {
    join();
    advance(5);
    client.press();
    advance(4);
    client.release();
    advance(4);

    const release = decodeInput(socket.inputs().at(-1) as Uint8Array);
    expect(release.buttons).toBe(0);
    expect(release.edges).toBe(0);

    advance(200);
    for (const frame of socket.inputs().slice(-2)) {
      expect(decodeInput(frame).edges).toBe(0);
    }
  });

  it("[A3] tick is stamped from the synced clock once a Pong arrives", () => {
    join();
    socket.deliverBinary(encodePong(1_000, 5_010));
    nowMs += 5;

    client.press();

    const press = decodeInput(socket.inputs().at(-1) as Uint8Array);
    // rtt 0, offset 5010 - 1000 = 4010; tick at now 1005.
    expect(press.tick).toBe(5_015);
  });
});

describe("[FR-7.10] clock sync over Ping/Pong", () => {
  it("[FR-7.10] pong samples update the controller clock and feed the debug stats", () => {
    join();
    expect(client.clock.samples).toBe(0);
    expect(client.clock.rttMs).toBe(Number.POSITIVE_INFINITY);

    nowMs += 10;
    socket.deliverBinary(encodePong(1_000, 5_010));

    expect(client.clock.samples).toBe(1);
    expect(client.clock.rttMs).toBe(10);
    expect(client.clock.offsetMs).toBe(4_005);
    expect(client.stats.rttMs).toBe(10);
    expect(client.stats.clockSamples).toBe(1);
    // rtt 10 → offset 5010 - (1000 + 5) = 4005.
    expect(client.clock.serverNow(1_010)).toBe(5_015);
  });

  it("[FR-7.10] Ping is sent every 5 s with the current client time", () => {
    join();
    expect(socket.pings()).toHaveLength(1);
    expect(decodePing(socket.pings()[0] as Uint8Array)).toEqual({ clientTimeMs: 1_000 });

    advance(5_000);
    expect(socket.pings()).toHaveLength(2);
    expect(decodePing(socket.pings()[1] as Uint8Array)).toEqual({ clientTimeMs: 6_000 });

    advance(5_000);
    expect(socket.pings()).toHaveLength(3);
    expect(decodePing(socket.pings()[2] as Uint8Array)).toEqual({ clientTimeMs: 11_000 });
  });

  it("[FR-7.10] malformed binary frames are ignored without closing the socket", () => {
    join();
    const before = socket.inputs().length;

    socket.deliverBinary(new Uint8Array([MSG.Pong, 0, 0]));
    socket.deliverBinary(new Uint8Array([0xff, 0, 0, 0, 0]));

    expect(client.clock.samples).toBe(0);
    expect(client.currentState.status).toBe("connected");
    advance(4);
    expect(socket.inputs().length).toBeGreaterThanOrEqual(before);
  });
});

describe("[FR-7.15 groundwork] closing stops every timer and never auto-reconnects", () => {
  it("[FR-7.15] socket close stops the send loop, the Ping cadence and the touch engine", () => {
    join(1, LAYOUT);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    socket.serverClose(1006, "lost");

    expect(client.currentState.status).toBe("disconnected");
    expect(client.currentState.error).toBe("Connection lost.");
    expect(client.isJoined).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    // D2 has no reconnect loop (D4-CTRL-02); the factory was called once.
    expect(socketsCreated).toBe(1);

    const inputsAfterClose = socket.inputs().length;
    const pingsAfterClose = socket.pings().length;
    advance(2_000);
    expect(socket.inputs()).toHaveLength(inputsAfterClose);
    expect(socket.pings()).toHaveLength(pingsAfterClose);
    expect(socketsCreated).toBe(1);
  });

  it("[FR-7.15] a manual reconnect after close starts fresh timers and state", () => {
    join();
    socket.serverClose();

    advance(250);
    join(2);

    expect(client.currentState).toEqual({ status: "connected", slot: 2, error: null });
    expect(socket.inputs()).toHaveLength(2);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it("[FR-7.15] joinError and kick also stop timers and clear the layout", () => {
    join(1, LAYOUT);
    expect(client.layout?.id).toBe("platformer-v1");

    socket.deliver({ t: "kick", reason: "host" });

    expect(client.layout).toBeNull();
    expect(surface.querySelectorAll(".control")).toHaveLength(0);
    expect(client.currentState.error).toContain("host removed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("[FR-7.1] disconnect stops the timers", () => {
    join();
    client.disconnect();
    const afterDisconnect = socket.inputs().length;

    advance(500);

    expect(socket.inputs()).toHaveLength(afterDisconnect);
    expect(client.currentState.status).toBe("disconnected");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("[G1] join-to-first-input instrumentation", () => {
  it("[G1] reports the delay between connect() and the first Input packet", () => {
    client.connect("ABCD", "1234");
    advance(50);
    socket.open();
    socket.deliver({ t: "joined", slot: 1, session: "session-1", serverTime: 5_000 });

    expect(client.stats.joinToFirstInputMs).toBe(50);
  });
});

describe("[FR-8.1] layout render and touch mapping", () => {
  it("[FR-8.1] button, dpad and stick render from layout data", () => {
    join(1, LAYOUT);

    expect(client.layout?.id).toBe("platformer-v1");
    expect(client.layoutError).toBeNull();
    expect(surface.querySelectorAll(".control")).toHaveLength(3);

    const jump = surface.querySelector<HTMLElement>('[data-control-id="jump"]');
    expect(jump?.dataset["controlType"]).toBe("button");
    // 800x400 surface: r 11% of 400 = 44 → 88 px circle at (656, 280).
    expect(jump?.style.left).toBe("612px");
    expect(jump?.style.top).toBe("236px");
    expect(jump?.style.width).toBe("88px");

    const dpad = surface.querySelector<HTMLElement>('[data-control-id="move"]');
    expect(dpad?.dataset["controlType"]).toBe("dpad");
    expect(dpad?.style.left).toBe("104px");
    expect(dpad?.style.top).toBe("232px");
    expect(dpad?.style.width).toBe("112px");

    const stick = surface.querySelector<HTMLElement>('[data-control-id="aim"]');
    expect(stick?.dataset["controlType"]).toBe("stick");
    expect(stick?.style.left).toBe("352px");
    expect(stick?.style.top).toBe("152px");
    expect(stick?.style.width).toBe("96px");
  });

  it("[FR-8.1] a button touch sets its bit and sends one coalesced packet", () => {
    join(1, LAYOUT);
    const jump = surface.querySelector<HTMLElement>('[data-control-id="jump"]');

    const startEvent = dispatchTouch(surface, "touchstart", [touch(1, 656, 280)]);
    expect(startEvent.defaultPrevented).toBe(true);
    expect(jump?.classList.contains("is-pressed")).toBe(true);
    expect(client.input.snapshot(0).buttons).toBe(1 << 0);

    // The join packet was sent this same millisecond (4 ms policy).
    advance(4);
    const inputs = socket.inputs();
    expect(inputs).toHaveLength(2);
    const press = decodeInput(inputs[1] as Uint8Array);
    expect(press.buttons).toBe(1 << 0);
    expect(press.edges).toBe(1 << 0);

    dispatchTouch(surface, "touchend", [touch(1, 656, 280)]);
    expect(jump?.classList.contains("is-pressed")).toBe(false);
    expect(client.input.snapshot(0).buttons).toBe(0);
  });

  it("[FR-8.1] dpad presses a direction bit and stick deflection writes an axis", () => {
    join(1, LAYOUT);

    // d-pad center (160, 288); 38 px above center is the "up" sector.
    dispatchTouch(surface, "touchstart", [touch(1, 160, 250)]);
    expect(client.input.snapshot(0).buttons).toBe(1 << 8);

    const dpad = surface.querySelector<HTMLElement>('[data-control-id="move"]');
    expect(dpad?.classList.contains("is-pressed")).toBe(true);

    // Fixed stick at (400, 200), radius 48: start at center then move right.
    dispatchTouch(surface, "touchstart", [touch(2, 400, 200)]);
    dispatchTouch(surface, "touchmove", [touch(2, 448, 200)]);
    const deflected = client.input.snapshot(0);
    expect(deflected.buttons).toBe(1 << 8);
    expect(deflected.rx).toBeGreaterThan(30_000);
    expect(deflected.ry).toBe(0);

    dispatchTouch(surface, "touchend", [
      touch(1, 160, 250),
      touch(2, 448, 200),
    ]);
    expect(client.input.snapshot(0).buttons).toBe(0);
    expect(client.input.snapshot(0).rx).toBe(0);
  });

  it("[FR-8.1] valid control types without a D2 renderer are skipped", () => {
    join(1, MIXED_LAYOUT);

    expect(client.layout?.controls).toHaveLength(2);
    expect(surface.querySelectorAll(".control")).toHaveLength(1);
    expect(surface.querySelector('[data-control-id="score"]')).toBeNull();
    expect(surface.querySelector('[data-control-id="fire"]')).not.toBeNull();
  });

  it("[FR-8.7] pressed state is painted synchronously in the touch handler", () => {
    join(1, LAYOUT);
    const jump = surface.querySelector<HTMLElement>('[data-control-id="jump"]');

    dispatchTouch(surface, "touchstart", [touch(1, 656, 280)]);
    // No timer or frame advanced: the class is already there.
    expect(jump?.classList.contains("is-pressed")).toBe(true);

    dispatchTouch(surface, "touchend", [touch(1, 656, 280)]);
    expect(jump?.classList.contains("is-pressed")).toBe(false);
  });

  it("[FR-8.7] a layout tap shorter than one tick reaches the socket through edges", () => {
    join(1, TAP_LAYOUT);
    const left = surface.querySelector<HTMLElement>('[data-control-id="left"]');
    const right = surface.querySelector<HTMLElement>('[data-control-id="right"]');

    // t=1000: hold left; the press coalesces with the join packet's 4 ms window.
    dispatchTouch(surface, "touchstart", [touch(1, 200, 200)]);
    expect(left?.classList.contains("is-pressed")).toBe(true);
    advance(4);
    expect(decodeInput(socket.inputs().at(-1) as Uint8Array).edges).toBe(1 << 0);

    // t=1004: tap right entirely inside the next 4 ms window.
    dispatchTouch(surface, "touchstart", [touch(2, 600, 200)]);
    expect(right?.classList.contains("is-pressed")).toBe(true);
    dispatchTouch(surface, "touchend", [touch(2, 600, 200)]);
    expect(right?.classList.contains("is-pressed")).toBe(false);

    advance(4);
    const tap = decodeInput(socket.inputs().at(-1) as Uint8Array);
    expect(tap.buttons).toBe(1 << 0);
    expect(tap.edges).toBe(1 << 1);
  });
});

describe("[FR-8.2] first layout mounts without a reload", () => {
  it("[FR-8.2] a joined layout mounts; later setLayout messages do not hot-swap", () => {
    join(1, LAYOUT);
    expect(client.layout?.id).toBe("platformer-v1");

    socket.deliver({ t: "setLayout", slot: "all", layout: SECOND_LAYOUT });

    expect(client.layout?.id).toBe("platformer-v1");
    expect(surface.querySelectorAll(".control")).toHaveLength(3);
  });

  it("[FR-8.2] without a joined layout, the first matching setLayout mounts it", () => {
    join();
    expect(client.layout).toBeNull();
    expect(surface.querySelectorAll(".control")).toHaveLength(0);

    // Wrong slot first: ignored while the slot has no layout.
    socket.deliver({ t: "setLayout", slot: 2, layout: SECOND_LAYOUT });
    expect(client.layout).toBeNull();

    socket.deliver({ t: "setLayout", slot: "all", layout: LAYOUT });
    expect(client.layout?.id).toBe("platformer-v1");
    expect(surface.querySelectorAll(".control")).toHaveLength(3);

    socket.deliver({ t: "setLayout", slot: 1, layout: SECOND_LAYOUT });
    expect(client.layout?.id).toBe("platformer-v1");
  });

  it("[FR-8.2] closing the socket clears the mounted layout for the next join", () => {
    join(1, LAYOUT);
    socket.serverClose();
    expect(client.layout).toBeNull();
    expect(surface.querySelectorAll(".control")).toHaveLength(0);

    join(1, SECOND_LAYOUT);
    expect(client.layout?.id).toBe("second-v1");
    expect(surface.querySelectorAll(".control")).toHaveLength(1);
  });
});

describe("[FR-8.4] invalid layouts never break the Test button path", () => {
  it("[FR-8.4] a rejected joined layout leaves the D0 Test path working", () => {
    join(1, {
      id: "broken-v1",
      orientation: "landscape",
      controls: [
        {
          type: "button",
          id: "bad",
          label: "Bad",
          shape: "circle",
          x: "10%",
          y: "10%",
          r: "10%",
          bit: 99,
        },
      ],
    } as unknown as LayoutDocument);

    expect(client.layout).toBeNull();
    expect(client.layoutError).toContain("bit");
    expect(surface.querySelectorAll(".control")).toHaveLength(0);

    advance(5);
    client.press();
    const inputs = socket.inputs();
    expect(inputs).toHaveLength(2);
    expect(decodeInput(inputs[1] as Uint8Array).buttons).toBe(A_MASK);
  });

  it("[FR-8.4] a rejected setLayout is reported and keeps the fallback UI", () => {
    join();
    socket.deliver({ t: "setLayout", slot: "all", layout: { id: "nope" } });

    expect(client.layout).toBeNull();
    expect(client.layoutError).not.toBeNull();
    expect(client.layoutError).not.toBe("");
  });
});
