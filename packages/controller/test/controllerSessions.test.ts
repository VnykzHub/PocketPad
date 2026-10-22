/**
 * D4-CTRL-01/02 integration through `ControllerClient`: join precedence,
 * session reconnect, silence watchdog, suspend/resume + Wake Lock and the A9
 * host-status pill. Each piece has its own unit test; these tests prove the
 * client wires them together over a fake socket and fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUTTON_BITS,
  MSG,
  PROTOCOL_VERSION,
  decodeInput,
  encodePong,
} from "@lanpad/protocol";
import {
  ControllerClient,
  HOST_LOST_KICK_TEXT,
  JOIN_ERROR_TEXT,
  connectionPillLabel,
  createMemoryStorage,
  type ControllerClientOptions,
  type ControllerSocket,
} from "../src/net/controllerClient.js";
import { JOIN_FLOW_MESSAGES } from "../src/join/joinFlow.js";
import { createSessionStore, type SessionStore } from "../src/join/sessionStore.js";
import type { SuspendWakeLock, VisibilitySource } from "../src/lifecycle/suspend.js";

const A_MASK = 1 << BUTTON_BITS.A;
/** 22-char base64url, the room-token shape (SR-1). Synthetic. */
const ROOM_TOKEN = "rtokenAAAAAAAAAAAAAAAA";
const SESSION = "sessionBBBBBBBBBBBBBBB";

class FakeSocket implements ControllerSocket {
  readonly sent: (string | Uint8Array)[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  serverClose(): void {
    this.onclose?.({ code: 1006, reason: "" });
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  deliverBinary(frame: Uint8Array): void {
    this.onmessage?.({ data: frame });
  }

  json(): Record<string, unknown>[] {
    return this.sent
      .filter((entry): entry is string => typeof entry === "string")
      .map((text) => JSON.parse(text) as Record<string, unknown>);
  }

  inputs(): Uint8Array[] {
    return this.sent.filter(
      (entry): entry is Uint8Array => entry instanceof Uint8Array && entry[0] === MSG.Input,
    );
  }
}

class FakeVisibility implements VisibilitySource {
  visibilityState = "visible";
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  set(state: "hidden" | "visible"): void {
    this.visibilityState = state;
    for (const listener of this.listeners.get("visibilitychange") ?? []) {
      listener();
    }
  }

  get listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }
}

let nowMs: number;
let sockets: FakeSocket[];
let store: SessionStore;
let visibility: FakeVisibility;
let wakeLock: { request: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
let historyCalls: string[];
let order: string[];
let client: ControllerClient;

function makeClient(extra: Partial<ControllerClientOptions> = {}): ControllerClient {
  return new ControllerClient({
    origin: "http://localhost:8080",
    createSocket: () => {
      order.push("socket");
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    now: () => nowMs,
    sessionStore: store,
    history: {
      replaceState: (_data, _unused, url) => {
        order.push("replaceState");
        historyCalls.push(String(url));
      },
    },
    visibility,
    wakeLock: wakeLock as unknown as SuspendWakeLock,
    // 0.5 → zero jitter, so backoff delays are exact (250, 500, 1000, …).
    random: () => 0.5,
    ...extra,
  });
}

function latest(): FakeSocket {
  const socket = sockets.at(-1);
  if (socket === undefined) throw new Error("no socket was created");
  return socket;
}

function advance(ms: number): void {
  nowMs += ms;
  vi.advanceTimersByTime(ms);
}

function joined(slot: number, session = SESSION): Record<string, unknown> {
  return { t: "joined", slot, session, serverTime: 5_000 };
}

/** QR bootstrap `/c/ABCD#<token>`, then a successful token join. */
function joinByQr(slot = 3): FakeSocket {
  client.start({ pathname: "/c/ABCD", hash: `#${ROOM_TOKEN}`, search: "" });
  const socket = latest();
  socket.open();
  socket.deliver(joined(slot));
  return socket;
}

/** Manual code + PIN join (no room token held anywhere). */
function joinByPin(slot = 2): FakeSocket {
  client.connect("ABCD", "1234");
  const socket = latest();
  socket.open();
  socket.deliver(joined(slot));
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  nowMs = 1_000;
  sockets = [];
  historyCalls = [];
  order = [];
  store = createSessionStore({ sessionStorage: createMemoryStorage(), now: () => nowMs });
  visibility = new FakeVisibility();
  wakeLock = {
    request: vi.fn(() => Promise.resolve(true)),
    release: vi.fn(() => Promise.resolve()),
  };
  client = makeClient();
});

afterEach(() => {
  client.disconnect();
  vi.useRealTimers();
});

describe("[FR-5.1] QR bootstrap", () => {
  it("[FR-5.1] the fragment is cleared before the first socket and join {token} is sent", () => {
    client.start({ pathname: "/c/ABCD", hash: `#${ROOM_TOKEN}`, search: "?x=1" });

    expect(order).toEqual(["replaceState", "socket"]);
    expect(historyCalls).toEqual(["/c/ABCD?x=1"]);
    latest().open();
    expect(latest().json()).toEqual([
      { t: "join", v: PROTOCOL_VERSION, code: "ABCD", token: ROOM_TOKEN },
    ]);
  });

  it("[SR-2] neither the room token nor the session reaches the visible state", () => {
    joinByQr();
    const visible = JSON.stringify([client.currentState, client.joinState]);
    expect(visible).not.toContain(ROOM_TOKEN);
    expect(visible).not.toContain(SESSION);
    expect(connectionPillLabel(client.currentState)).toBe("Connected (P3)");
  });
});

describe("[FR-5.4] session rejoin precedence", () => {
  it("[FR-5.4] a stored session is sent before the room token on bootstrap", () => {
    store.set("ABCD", { session: SESSION, slot: 4, roomToken: ROOM_TOKEN });

    client.start({ pathname: "/c/ABCD", hash: `#${ROOM_TOKEN}`, search: "" });
    latest().open();

    expect(latest().json()).toEqual([
      { t: "join", v: PROTOCOL_VERSION, code: "ABCD", session: SESSION },
    ]);
  });

  it("[FR-5.4] [FR-7.15] a drop reconnects at 250 ms with join {session} and keeps the slot", () => {
    const first = joinByQr(3);
    expect(store.get("ABCD")?.session).toBe(SESSION);

    first.serverClose();
    expect(connectionPillLabel(client.currentState)).toBe("Reconnecting");

    advance(249);
    expect(sockets).toHaveLength(1);
    advance(1);
    expect(sockets).toHaveLength(2);

    const retry = latest();
    retry.open();
    const [rejoin] = retry.json();
    expect(rejoin).toEqual({ t: "join", v: PROTOCOL_VERSION, code: "ABCD", session: SESSION });
    expect(rejoin).not.toHaveProperty("token");

    retry.deliver(joined(3));
    expect(connectionPillLabel(client.currentState)).toBe("Connected (P3)");
  });

  it("[FR-5.4] a press made during the gap is delivered with its edge after the rejoin", () => {
    joinByQr(3).serverClose();

    client.press();
    client.release();
    advance(250);
    latest().open();
    latest().deliver(joined(3));

    const first = decodeInput(latest().inputs()[0] as Uint8Array);
    expect(first.edges & A_MASK).toBe(A_MASK);
  });

  it("[FR-7.15] failed attempts back off 250 → 500 → 1000 → 2000 → 4000 ms and cap at 4 s", () => {
    joinByQr().serverClose();

    const delays = [250, 500, 1_000, 2_000, 4_000, 4_000];
    for (const [index, delay] of delays.entries()) {
      advance(delay - 1);
      expect(sockets, `attempt ${index}`).toHaveLength(index + 1);
      advance(1);
      expect(sockets, `attempt ${index}`).toHaveLength(index + 2);
      // The retry socket closes before `joined`: a failed attempt.
      latest().serverClose();
    }
  });
});

describe("[FR-5.5] expired reservation falls back", () => {
  it("[FR-5.5] a QR player rejoins as a new player with the room token", () => {
    joinByQr(3).serverClose();
    advance(250);
    latest().open();
    latest().deliver({ t: "joinError", reason: "expired" });

    expect(store.get("ABCD")).toBeNull();
    const fresh = latest();
    expect(sockets).toHaveLength(3);
    fresh.open();
    expect(fresh.json()).toEqual([
      { t: "join", v: PROTOCOL_VERSION, code: "ABCD", token: ROOM_TOKEN },
    ]);
    fresh.deliver(joined(5, "sessionNEWNEWNEWNEWNEW"));
    expect(connectionPillLabel(client.currentState)).toBe("Connected (P5)");
  });

  it("[FR-5.5] a manual player returns to the form with the expired message", () => {
    joinByPin(2).serverClose();
    advance(250);
    latest().open();
    latest().deliver({ t: "joinError", reason: "expired" });

    expect(client.currentState.status).toBe("disconnected");
    expect(client.currentState.error).toBe(JOIN_FLOW_MESSAGES.expired);
    expect(client.joinState.status).toBe("manual");
    expect(vi.getTimerCount()).toBe(0);
    advance(10_000);
    expect(sockets).toHaveLength(2);
  });
});

describe("[FR-7.14] silent socket watchdog", () => {
  it("[FR-7.14] 7 s without any server frame closes the socket and reconnects", () => {
    const first = joinByQr();

    advance(6_999);
    expect(first.closed).toBe(false);
    advance(1);
    expect(first.closed).toBe(true);
    expect(connectionPillLabel(client.currentState)).toBe("Reconnecting");

    advance(250);
    expect(sockets).toHaveLength(2);
  });

  it("[FR-7.14] Pongs count as server activity and keep the socket", () => {
    const first = joinByQr();
    for (let second = 0; second < 20; second += 5) {
      advance(5_000);
      first.deliverBinary(encodePong(nowMs, nowMs + 4_000));
    }
    expect(first.closed).toBe(false);
    expect(sockets).toHaveLength(1);
  });
});

describe("[FR-8.8] suspend on hidden, rejoin on visible", () => {
  it("[FR-8.8] hidden sends suspend, releases the Wake Lock and stops sending", () => {
    const socket = joinByQr(3);
    expect(wakeLock.request).toHaveBeenCalled();
    const releasesBefore = wakeLock.release.mock.calls.length;

    visibility.set("hidden");

    expect(socket.json().at(-1)).toEqual({ t: "suspend" });
    expect(wakeLock.release.mock.calls.length).toBeGreaterThan(releasesBefore);
    const inputs = socket.inputs().length;
    advance(1_000);
    expect(socket.inputs()).toHaveLength(inputs);
    // Hidden is not a disconnect: no reconnect socket and no watchdog close.
    advance(10_000);
    expect(socket.closed).toBe(false);
    expect(sockets).toHaveLength(1);
  });

  it("[FR-8.8] visible inside 30 s rejoins by session on the same socket", () => {
    const socket = joinByQr(3);
    visibility.set("hidden");
    advance(10_000);
    const requests = wakeLock.request.mock.calls.length;

    visibility.set("visible");

    expect(wakeLock.request.mock.calls.length).toBe(requests + 1);
    expect(sockets).toHaveLength(1);
    expect(socket.json().at(-1)).toEqual({
      t: "join",
      v: PROTOCOL_VERSION,
      code: "ABCD",
      session: SESSION,
    });

    socket.deliver(joined(3));
    expect(connectionPillLabel(client.currentState)).toBe("Connected (P3)");
    const inputs = socket.inputs().length;
    advance(500);
    expect(socket.inputs().length).toBeGreaterThan(inputs);
  });

  it("[FR-8.8] a socket that died while hidden is reconnected when visible", () => {
    const socket = joinByQr(3);
    visibility.set("hidden");
    socket.serverClose();
    advance(5_000);
    // No reconnect while hidden; the reservation runs on the server.
    expect(sockets).toHaveLength(1);

    visibility.set("visible");
    advance(250);
    expect(sockets).toHaveLength(2);
    latest().open();
    expect(latest().json()).toEqual([
      { t: "join", v: PROTOCOL_VERSION, code: "ABCD", session: SESSION },
    ]);
  });

  it("[FR-5.5] visible after more than 30 s skips the doomed session join", () => {
    const socket = joinByQr(3);
    visibility.set("hidden");
    advance(31_000);

    visibility.set("visible");

    expect(socket.closed).toBe(true);
    expect(store.get("ABCD")).toBeNull();
    latest().open();
    expect(latest().json()).toEqual([
      { t: "join", v: PROTOCOL_VERSION, code: "ABCD", token: ROOM_TOKEN },
    ]);
  });

  it("[AR-3] a refused Wake Lock never blocks the join or input", () => {
    wakeLock.request.mockImplementation(() => Promise.reject(new Error("denied")));
    const socket = joinByQr(3);
    advance(5);
    client.press();
    expect(decodeInput(socket.inputs().at(-1) as Uint8Array).buttons).toBe(A_MASK);
  });
});

describe("[A9] host status and kicks", () => {
  it("[A9] hostStatus lost/paused/active drive the pill", () => {
    const socket = joinByQr(1);

    socket.deliver({ t: "hostStatus", state: "lost" });
    expect(connectionPillLabel(client.currentState)).toBe("Waiting for TV");
    socket.deliver({ t: "hostStatus", state: "paused" });
    expect(connectionPillLabel(client.currentState)).toBe("TV paused");
    socket.deliver({ t: "hostStatus", state: "active" });
    expect(connectionPillLabel(client.currentState)).toBe("Connected (P1)");
  });

  it("[FR-7.16] kick hostLost ends the session without reconnecting", () => {
    const socket = joinByQr(1);
    socket.deliver({ t: "hostStatus", state: "lost" });

    socket.deliver({ t: "kick", reason: "hostLost" });

    expect(client.currentState.status).toBe("disconnected");
    expect(client.currentState.error).toBe(HOST_LOST_KICK_TEXT);
    expect(store.get("ABCD")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    socket.serverClose();
    advance(10_000);
    expect(sockets).toHaveLength(1);
    expect(visibility.listenerCount).toBe(0);
  });

  it("[FR-5.2] kick expired shows the expired message", () => {
    joinByQr(1).deliver({ t: "kick", reason: "expired" });
    expect(client.currentState.error).toBe(JOIN_FLOW_MESSAGES.expired);
  });
});

describe("[FR-5.6] join refusals", () => {
  it("[A10] badVersion tells the player to reload", () => {
    client.connect("ABCD", "1234");
    latest().open();
    latest().deliver({ t: "joinError", reason: "badVersion" });

    expect(client.currentState.status).toBe("disconnected");
    expect(client.currentState.error).toBe(JOIN_ERROR_TEXT.badVersion);
    expect(client.currentState.error).toContain("Reload");
  });

  it("[FR-5.3] roomFull is distinct and retryJoin re-runs the token join", () => {
    client.start({ pathname: "/c/ABCD", hash: `#${ROOM_TOKEN}`, search: "" });
    latest().open();
    latest().deliver({ t: "joinError", reason: "roomFull" });
    expect(client.currentState.error).toBe(JOIN_FLOW_MESSAGES.roomFull);

    client.retryJoin();
    expect(latest().json().at(-1)).toEqual({
      t: "join",
      v: PROTOCOL_VERSION,
      code: "ABCD",
      token: ROOM_TOKEN,
    });
  });

  it("[SR-4] manual join sends only the PIN, never a token or session", () => {
    store.set("WXYZ", { session: SESSION, slot: 1, roomToken: ROOM_TOKEN });
    client.connect("ABCD", "1234");
    latest().open();
    expect(latest().json()).toEqual([
      { t: "join", v: PROTOCOL_VERSION, code: "ABCD", pin: "1234" },
    ]);
  });
});

describe("[FR-5.4] explicit leave", () => {
  it("[FR-5.4] disconnect sends leave, clears the session and leaves no timers", () => {
    const socket = joinByQr(2);

    client.disconnect();

    expect(socket.json().at(-1)).toEqual({ t: "leave" });
    expect(store.get("ABCD")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(visibility.listenerCount).toBe(0);
    advance(10_000);
    expect(sockets).toHaveLength(1);
  });
});
