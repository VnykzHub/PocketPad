import {
  PROTOCOL_VERSION,
  encodeInputFwd,
  type HostToServerMessage,
  type InputState,
  type SlotStats,
} from "@lanpad/protocol";
import { describe, expect, test } from "vitest";
import {
  HostClient,
  hostTokenStorageKey,
  parseRoomCredentials,
  shouldCreateRoomOnKey,
  storeHostToken,
  type RoomCredentials,
  type WebSocketCloseInfo,
  type WebSocketLike,
} from "../src/net/hostClient";

const ROOM_RESPONSE = {
  code: "ABCD",
  pin: "1234",
  roomToken: "A1b2C3d4E5f6G7h8I9j0Kl",
  hostToken: "Z9y8X7w6V5u4T3s2R1q0Po",
  expiresAt: 1_700_000_000_000,
  serverTime: 1_700_000_000_123,
} satisfies RoomCredentials;

class FakeSocket implements WebSocketLike {
  binaryType = "blob";
  readonly readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: WebSocketCloseInfo) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  readonly sent: (string | Uint8Array)[] = [];
  readonly url: string;
  closed = false;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }
}

function fakeClient(sockets: FakeSocket[]): HostClient {
  return new HostClient({
    createWebSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
}

describe("POST /api/rooms response parser (D0-RT-01)", () => {
  test("[A8] accepts the documented room credentials shape", () => {
    expect(parseRoomCredentials(ROOM_RESPONSE)).toEqual(ROOM_RESPONSE);
  });

  test("[A8] ignores unknown extra fields instead of passing them through", () => {
    const parsed = parseRoomCredentials({ ...ROOM_RESPONSE, debugFlag: true });
    expect(parsed).toEqual(ROOM_RESPONSE);
    expect("debugFlag" in parsed).toBe(false);
  });

  test("[A8] rejects malformed codes, PINs and tokens", () => {
    const invalid: unknown[] = [
      null,
      [],
      {},
      { ...ROOM_RESPONSE, code: "ABC" },
      { ...ROOM_RESPONSE, code: "ABCI" },
      { ...ROOM_RESPONSE, pin: "12a4" },
      { ...ROOM_RESPONSE, pin: "12345" },
      { ...ROOM_RESPONSE, roomToken: "too-short" },
      { ...ROOM_RESPONSE, hostToken: "not base64url ++++++" },
      { ...ROOM_RESPONSE, hostToken: "short" },
      { ...ROOM_RESPONSE, expiresAt: "soon" },
      { ...ROOM_RESPONSE, serverTime: Number.NaN },
    ];

    for (const value of invalid) {
      expect(() => parseRoomCredentials(value)).toThrow(/Invalid room creation response/);
    }
  });

  test("[SR-9] parser errors never echo a token value", () => {
    const leakyHostToken = "leaky-token-value";
    let message = "";
    try {
      parseRoomCredentials({ ...ROOM_RESPONSE, hostToken: leakyHostToken });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Invalid room creation response");
    expect(message).not.toContain(leakyHostToken);
    expect(message).not.toContain(ROOM_RESPONSE.hostToken);
  });
});

describe("host token storage and URLs (D0-RT-01)", () => {
  test("[FR-5.1] host token is stored in sessionStorage under lanpad.host.<code> and never in a URL", async () => {
    const stored = new Map<string, string>();
    storeHostToken(
      {
        setItem(key: string, value: string) {
          stored.set(key, value);
        },
      },
      ROOM_RESPONSE.code,
      ROOM_RESPONSE.hostToken,
    );

    expect(hostTokenStorageKey(ROOM_RESPONSE.code)).toBe("lanpad.host.ABCD");
    expect(stored.get("lanpad.host.ABCD")).toBe(ROOM_RESPONSE.hostToken);

    const requestedUrls: string[] = [];
    const client = new HostClient({
      fetch: async (url) => {
        requestedUrls.push(url);
        return { ok: true, status: 201, json: async () => ROOM_RESPONSE };
      },
    });
    const credentials = await client.createRoom("https://lanpad.example");

    expect(requestedUrls).toEqual(["https://lanpad.example/api/rooms"]);
    expect(requestedUrls[0]).not.toContain(credentials.roomToken);
    expect(requestedUrls[0]).not.toContain(credentials.hostToken);
  });
});

describe("HostClient socket wiring (D0-RT-01)", () => {
  test("[FR-4.3] socket URL derives from the configured origin, never a literal", () => {
    const sockets: FakeSocket[] = [];
    const client = fakeClient(sockets);

    client.connect("http://192.168.1.20:8080/");

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe("ws://192.168.1.20:8080/ws");
    expect(sockets[0]?.binaryType).toBe("arraybuffer");
  });

  test("[A2] hostJoin carries the protocol version, code and host token", () => {
    const sockets: FakeSocket[] = [];
    const client = fakeClient(sockets);
    client.connect("http://localhost:8080");
    const socket = sockets[0];
    if (socket === undefined) {
      throw new Error("connect() did not create a socket");
    }

    client.sendHostJoin(ROOM_RESPONSE.code, ROOM_RESPONSE.hostToken);

    expect(JSON.parse(String(socket.sent[0]))).toEqual({
      t: "hostJoin",
      v: PROTOCOL_VERSION,
      code: ROOM_RESPONSE.code,
      hostToken: ROOM_RESPONSE.hostToken,
    });
  });

  test("[FR-7.3] binary InputFwd frames reach input listeners with edges intact", () => {
    const sockets: FakeSocket[] = [];
    const client = fakeClient(sockets);
    const received: { slot: number; state: InputState }[] = [];
    client.onInput((slot, state) => {
      received.push({ slot, state });
    });
    client.connect("http://localhost:8080");
    const socket = sockets[0];
    if (socket === undefined) {
      throw new Error("connect() did not create a socket");
    }

    const state: InputState = {
      tick: 1234,
      buttons: 0,
      edges: 0x0001,
      lx: -32768,
      ly: 32767,
      rx: 0,
      ry: 0,
      gx: 0,
      gy: 0,
      gz: 0,
      lt: 255,
      rt: 0,
      flags: 0,
    };
    socket.onmessage?.({ data: encodeInputFwd(2, state) });

    expect(received).toHaveLength(1);
    expect(received[0]?.slot).toBe(2);
    expect(received[0]?.state).toEqual(state);
  });

  test("[A2] malformed or wrong-direction JSON is dropped without reaching listeners", () => {
    const sockets: FakeSocket[] = [];
    const client = fakeClient(sockets);
    const messages: string[] = [];
    client.onMessage((message) => {
      messages.push(message.t);
    });
    client.connect("http://localhost:8080");
    const socket = sockets[0];
    if (socket === undefined) {
      throw new Error("connect() did not create a socket");
    }

    socket.onmessage?.({ data: "{not json" });
    socket.onmessage?.({ data: JSON.stringify({ t: "join", v: 1, code: "ABCD", pin: "1234" }) });
    socket.onmessage?.({
      data: JSON.stringify({ t: "hostJoined", code: "ABCD", serverTime: 1_700_000_000_123 }),
    });

    expect(messages).toEqual(["hostJoined"]);
    expect(client.droppedMessageCount).toBe(2);
  });
});

describe("keyboard start path (D0-RT-01)", () => {
  test("[AR-4] Enter starts a room from idle and failed states only", () => {
    expect(shouldCreateRoomOnKey("Enter", "idle")).toBe(true);
    expect(shouldCreateRoomOnKey("Enter", "failed")).toBe(true);
    expect(shouldCreateRoomOnKey("Enter", "creating")).toBe(false);
    expect(shouldCreateRoomOnKey("Enter", "ready")).toBe(false);
    expect(shouldCreateRoomOnKey(" ", "idle")).toBe(false);
    expect(shouldCreateRoomOnKey("a", "failed")).toBe(false);
  });
});

/** Deterministic host clock for D3-RT-03 time and instrumentation tests. */
class FakeClock {
  private current: number;

  constructor(startMs: number) {
    this.current = startMs;
  }

  readonly now = (): number => this.current;

  advance(ms: number): void {
    this.current += ms;
  }
}

function fakeClientWithClock(sockets: FakeSocket[], clock: FakeClock): HostClient {
  return new HostClient({
    createWebSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    now: clock.now,
  });
}

function openSocket(sockets: FakeSocket[]): FakeSocket {
  const socket = sockets[0];
  if (socket === undefined) {
    throw new Error("connect() did not create a socket");
  }
  socket.onopen?.({});
  return socket;
}

function deliverJson(socket: FakeSocket, message: unknown): void {
  socket.onmessage?.({ data: JSON.stringify(message) });
}

function inputState(tick: number, edges = 0): InputState {
  return {
    tick,
    buttons: edges === 0 ? 0 : 0x0001,
    edges,
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
  };
}

async function connectedClient(
  sockets: FakeSocket[],
  clock: FakeClock,
): Promise<{ client: HostClient; socket: FakeSocket }> {
  const client = fakeClientWithClock(sockets, clock);
  const connected = client.connect("http://localhost:8080");
  const socket = openSocket(sockets);
  await connected;
  return { client, socket };
}

describe("host join and server time (D3-RT-03)", () => {
  test("[FR-7.10] hostJoined sets serverTimeOffset from the injected clock and serverNow tracks it", async () => {
    const sockets: FakeSocket[] = [];
    const clock = new FakeClock(5_000);
    const { client, socket } = await connectedClient(sockets, clock);

    expect(client.serverNow()).toBeNull();
    expect(client.serverTimeOffset).toBeNull();

    const joined = client.hostJoin(ROOM_RESPONSE.code, ROOM_RESPONSE.hostToken);
    deliverJson(socket, {
      t: "hostJoined",
      code: ROOM_RESPONSE.code,
      serverTime: 1_700_000_000_123,
    });

    await expect(joined).resolves.toEqual({ serverTime: 1_700_000_000_123 });
    expect(client.serverTimeOffset).toBe(1_700_000_000_123 - 5_000);
    expect(client.serverNow()).toBe(1_700_000_000_123);

    clock.advance(16.7);
    expect(client.serverNow()).toBeCloseTo(1_700_000_000_123 + 16.7, 6);
  });

  test("[A2] hostJoin sends the host token and resolves only on the matching hostJoined code", async () => {
    const sockets: FakeSocket[] = [];
    const clock = new FakeClock(1_000);
    const { client, socket } = await connectedClient(sockets, clock);

    const joined = client.hostJoin(ROOM_RESPONSE.code, ROOM_RESPONSE.hostToken);
    const joinFrame = JSON.parse(String(socket.sent[0])) as Record<string, unknown>;
    expect(joinFrame).toEqual({
      t: "hostJoin",
      v: PROTOCOL_VERSION,
      code: ROOM_RESPONSE.code,
      hostToken: ROOM_RESPONSE.hostToken,
    });
    expect(joinFrame).not.toHaveProperty("roomToken");
    expect(String(socket.sent[0])).not.toContain(ROOM_RESPONSE.roomToken);

    let settled = false;
    void joined.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    deliverJson(socket, { t: "hostJoined", code: "ZZZZ", serverTime: 1 });
    await Promise.resolve();
    expect(settled).toBe(false);

    deliverJson(socket, { t: "hostJoined", code: ROOM_RESPONSE.code, serverTime: 1 });
    await expect(joined).resolves.toEqual({ serverTime: 1 });
  });

  test("[A2] a joinError rejects the pending hostJoin without echoing the host token", async () => {
    const sockets: FakeSocket[] = [];
    const clock = new FakeClock(1_000);
    const { client, socket } = await connectedClient(sockets, clock);

    const joined = client.hostJoin(ROOM_RESPONSE.code, ROOM_RESPONSE.hostToken);
    deliverJson(socket, { t: "joinError", reason: "badHostToken" });

    let message = "";
    try {
      await joined;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("badHostToken");
    expect(message).not.toContain(ROOM_RESPONSE.hostToken);
  });

  test("[A2] hostJoin rejects before the socket is connected", async () => {
    const client = new HostClient();
    await expect(
      client.hostJoin(ROOM_RESPONSE.code, ROOM_RESPONSE.hostToken),
    ).rejects.toThrow(/connected host socket/);
  });

  test("[A2] createRoom stores the host token in per-room storage, never the room token", async () => {
    const stored = new Map<string, string>();
    const client = new HostClient({
      fetch: async () => ({ ok: true, status: 201, json: async () => ROOM_RESPONSE }),
      storage: {
        setItem(key: string, value: string) {
          stored.set(key, value);
        },
      },
    });

    const credentials = await client.createRoom("https://lanpad.example");

    expect(stored.get(hostTokenStorageKey(credentials.code))).toBe(credentials.hostToken);
    expect(stored.get(hostTokenStorageKey(credentials.code))).not.toBe(
      credentials.roomToken,
    );
  });
});

describe("InputFwd routing (D3-RT-03)", () => {
  test("[FR-7.11][PR-9.3] frames are delivered in arrival order into one reused packet", async () => {
    const sockets: FakeSocket[] = [];
    const clock = new FakeClock(1_000);
    const { client, socket } = await connectedClient(sockets, clock);

    const delivered: Array<{ slot: number; tick: number; edges: number }> = [];
    const states: InputState[] = [];
    client.onInput((slot, state) => {
      delivered.push({ slot, tick: state.tick, edges: state.edges });
      states.push(state);
    });

    socket.onmessage?.({ data: encodeInputFwd(2, inputState(100, 0x0001)) });
    socket.onmessage?.({ data: encodeInputFwd(2, inputState(90)) });
    socket.onmessage?.({ data: encodeInputFwd(5, inputState(101)) });

    expect(delivered).toEqual([
      { slot: 2, tick: 100, edges: 0x0001 },
      { slot: 2, tick: 90, edges: 0 },
      { slot: 5, tick: 101, edges: 0 },
    ]);
    expect(states).toHaveLength(3);
    expect(states[0]).toBe(states[1]);
    expect(states[1]).toBe(states[2]);
    expect(client.inputPacketCount).toBe(3);
  });

  test("[FR-7.11] slots 1..8 are routed independently", async () => {
    const sockets: FakeSocket[] = [];
    const clock = new FakeClock(1_000);
    const { client, socket } = await connectedClient(sockets, clock);

    const seenSlots: number[] = [];
    const seenTicks: number[] = [];
    client.onInput((slot, state) => {
      seenSlots.push(slot);
      seenTicks.push(state.tick);
    });

    for (let slot = 1; slot <= 8; slot += 1) {
      socket.onmessage?.({ data: encodeInputFwd(slot, inputState(slot * 10)) });
    }

    expect(seenSlots).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(seenTicks).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  test("[FR-7.17] input listeners receive decoded packets, never the socket", async () => {
    const sockets: FakeSocket[] = [];
    const clock = new FakeClock(1_000);
    const { client, socket } = await connectedClient(sockets, clock);

    const packets: Array<{ slot: number; state: InputState }> = [];
    client.onInput((slot, state) => {
      packets.push({ slot, state });
    });
    socket.onmessage?.({ data: encodeInputFwd(3, inputState(7)) });

    const packet = packets[0];
    if (packet === undefined) {
      throw new Error("InputFwd frame was not delivered");
    }
    expect(packet.slot).toBe(3);
    expect(packet.state).not.toBe(socket);
    expect("send" in packet.state).toBe(false);
    expect("close" in packet.state).toBe(false);
    expect(Object.keys(packet.state).sort()).toEqual(
      [
        "buttons",
        "edges",
        "flags",
        "gx",
        "gy",
        "gz",
        "lt",
        "lx",
        "ly",
        "rt",
        "rx",
        "ry",
        "tick",
      ].sort(),
    );
  });

  test("malformed InputFwd frames are counted and never delivered", async () => {
    const sockets: FakeSocket[] = [];
    const clock = new FakeClock(1_000);
    const { client, socket } = await connectedClient(sockets, clock);

    let delivered = 0;
    client.onInput(() => {
      delivered += 1;
    });

    const badSlot = encodeInputFwd(1, inputState(1));
    badSlot[1] = 9;
    socket.onmessage?.({ data: badSlot });

    expect(delivered).toBe(0);
    expect(client.malformedInputCount).toBe(1);
    expect(client.inputPacketCount).toBe(0);
  });
});

describe("connection lifecycle (D3-RT-03, D4 groundwork)", () => {
  test("[FR-7.16] an unexpected close sets state closed, notifies hooks and does not reconnect", async () => {
    const sockets: FakeSocket[] = [];
    const clock = new FakeClock(1_000);
    const { client, socket } = await connectedClient(sockets, clock);
    expect(client.state).toBe("connected");

    const closes: WebSocketCloseInfo[] = [];
    client.onClose((info) => closes.push(info));

    const droppedJoin = client.hostJoin(ROOM_RESPONSE.code, ROOM_RESPONSE.hostToken);
    const closeInfo: WebSocketCloseInfo = {
      code: 1006,
      reason: "host lost",
      wasClean: false,
    };
    socket.onclose?.(closeInfo);

    expect(client.state).toBe("closed");
    expect(client.lastClose).toEqual(closeInfo);
    expect(closes).toEqual([closeInfo]);
    expect(sockets).toHaveLength(1);
    await expect(droppedJoin).rejects.toThrow(/closed/);
  });

  test("[FR-7.16] close() marks the client closed and suppresses close listeners", async () => {
    const sockets: FakeSocket[] = [];
    const clock = new FakeClock(1_000);
    const { client, socket } = await connectedClient(sockets, clock);

    let closes = 0;
    client.onClose(() => {
      closes += 1;
    });
    client.close();

    expect(client.state).toBe("closed");
    expect(socket.closed).toBe(true);
    expect(closes).toBe(0);
  });
});

describe("host-only sends (D3-RT-03)", () => {
  test("[A2] send() refuses controller messages and sends host control", async () => {
    const sockets: FakeSocket[] = [];
    const clock = new FakeClock(1_000);
    const { client, socket } = await connectedClient(sockets, clock);

    const controllerJoin = {
      t: "join",
      v: PROTOCOL_VERSION,
      code: ROOM_RESPONSE.code,
      pin: ROOM_RESPONSE.pin,
    } as unknown as HostToServerMessage;

    expect(() => client.send(controllerJoin)).toThrow(/only accepts host messages/);
    expect(socket.sent).toHaveLength(0);

    client.send({ t: "hostPause" });
    expect(JSON.parse(String(socket.sent[0]))).toEqual({ t: "hostPause" });
  });
});

describe("server message dispatch (D3-RT-03)", () => {
  test("player events and stats reach their typed callbacks", async () => {
    const sockets: FakeSocket[] = [];
    const clock = new FakeClock(1_000);
    const { client, socket } = await connectedClient(sockets, clock);

    const players: Array<{ event: string; slot: number }> = [];
    client.onPlayer((event, slot) => players.push({ event, slot }));
    const stats: SlotStats[][] = [];
    client.onServerStats((slots) => stats.push(slots));

    deliverJson(socket, { t: "playerJoined", slot: 1 });
    deliverJson(socket, { t: "playerLeft", slot: 2 });
    deliverJson(socket, { t: "playerSuspended", slot: 3 });
    deliverJson(socket, { t: "playerResumed", slot: 3 });

    const slotStats: SlotStats = {
      slot: 1,
      rttMs: 12,
      jitterMs: 2,
      lastInputAgeMs: 16,
      packetsPerSecond: 60,
      drops: 0,
    };
    deliverJson(socket, { t: "stats", slots: [slotStats] });

    expect(players).toEqual([
      { event: "joined", slot: 1 },
      { event: "left", slot: 2 },
      { event: "suspended", slot: 3 },
      { event: "resumed", slot: 3 },
    ]);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toEqual([slotStats]);
  });
});

describe("input instrumentation (D3-RT-03)", () => {
  test("packet count, decode p95 and per-slot age use the injected clock", async () => {
    const sockets: FakeSocket[] = [];
    let nowMs = 0;
    const client = new HostClient({
      createWebSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      now: () => {
        nowMs += 1;
        return nowMs;
      },
    });
    const connected = client.connect("http://localhost:8080");
    const socket = openSocket(sockets);
    await connected;

    socket.onmessage?.({ data: encodeInputFwd(1, inputState(1)) });
    socket.onmessage?.({ data: encodeInputFwd(1, inputState(2)) });
    socket.onmessage?.({ data: encodeInputFwd(1, inputState(3)) });

    expect(client.inputPacketCount).toBe(3);
    expect(client.decodeP95Ms).toBe(1);
    expect(client.lastInputAgeMs(1)).toBeGreaterThanOrEqual(0);
    expect(client.lastInputAgeMs(8)).toBe(-1);
    expect(client.lastInputAgeMs(0)).toBe(-1);
  });
});
