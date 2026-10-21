import { PROTOCOL_VERSION, encodeInputFwd, type InputState } from "@lanpad/protocol";
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
