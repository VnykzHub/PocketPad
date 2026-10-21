/**
 * WebSocket adapter tests (D0-SRV-03). These use a real HTTP server on
 * 127.0.0.1 and real `ws` clients; clocks are injected into the registry so
 * heartbeat tests do not depend on wall time.
 */
import { createServer, type Server } from "node:http";
import { Socket, type AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  decodeInputFwd,
  decodePong,
  encodeInput,
  encodePing,
  parseJsonMessage,
  type InputState,
  type JsonControlMessage,
} from "@lanpad/protocol";
import {
  CLOSE,
  RoomRegistry,
  attachWebSocketServer,
  type WsServerConfig,
} from "../src/index.js";
import { assertNoSecretsLogged, createTestLogger, seededRandomBytes } from "./helpers.js";

type Client = InstanceType<typeof WebSocket>;

interface Harness {
  registry: RoomRegistry;
  server: Server;
  wss: WebSocketServer;
  url: string;
  origin: string;
  calls: ReturnType<typeof createTestLogger>["calls"];
  close: () => Promise<void>;
}

const active: Harness[] = [];

afterEach(async () => {
  const harnesses = active.splice(0);
  for (const harness of harnesses) {
    await harness.close();
  }
});

async function startHarness(overrides: Partial<WsServerConfig> = {}): Promise<Harness> {
  const { logger, calls } = createTestLogger();
  const registry = new RoomRegistry({
    now: () => Date.now(),
    randomBytes: seededRandomBytes(7),
    logger,
  });
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const config: WsServerConfig = {
    allowedOrigins: [origin],
    allowMissingOrigin: true,
    heartbeatMs: 60_000,
    deadAfterMs: 120_000,
    maxBufferedBytes: 262_144,
    ...overrides,
  };
  const wss = attachWebSocketServer(server, { registry, config, logger });
  const harness: Harness = {
    registry,
    server,
    wss,
    url: `ws://127.0.0.1:${port}/ws`,
    origin,
    calls,
    close: async () => {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 20));
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      if (server.listening) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    },
  };
  active.push(harness);
  return harness;
}

function input(overrides: Partial<InputState> = {}): InputState {
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

function wrongPin(pin: string): string {
  return pin === "0000" ? "0001" : "0000";
}

function openClient(
  url: string,
  options?: { origin?: string; autoPong?: boolean },
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url, options);
    client.once("open", () => resolve(client));
    client.once("error", reject);
  });
}

/** Resolves with the HTTP status when the upgrade is refused before `101`. */
function expectUpgradeRejected(url: string, options?: { origin?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url, options);
    client.on("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
      client.terminate();
    });
    client.once("open", () => {
      client.terminate();
      reject(new Error("expected the upgrade to be rejected"));
    });
    client.once("error", reject);
  });
}

function nextJson(
  client: Client,
  expectedType?: string,
  timeoutMs = 2000,
): Promise<JsonControlMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("message", onMessage);
      reject(new Error(`timed out waiting for ${expectedType ?? "a JSON message"}`));
    }, timeoutMs);
    const onMessage = (data: unknown, isBinary: boolean): void => {
      if (isBinary) {
        return;
      }
      const message = parseJsonMessage((data as Buffer).toString());
      if (expectedType !== undefined && message.t !== expectedType) {
        return;
      }
      clearTimeout(timer);
      client.off("message", onMessage);
      resolve(message);
    };
    client.on("message", onMessage);
  });
}

function nextBinary(client: Client, timeoutMs = 2000): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("message", onMessage);
      reject(new Error("timed out waiting for a binary frame"));
    }, timeoutMs);
    const onMessage = (data: unknown, isBinary: boolean): void => {
      if (!isBinary) {
        return;
      }
      clearTimeout(timer);
      client.off("message", onMessage);
      const buffer = data as Buffer;
      resolve(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
    };
    client.on("message", onMessage);
  });
}

function nextClose(client: Client, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    if (client.readyState === WebSocket.CLOSED) {
      resolve({ code: 0, reason: "" });
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for close"));
    }, timeoutMs);
    client.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

describe("WebSocket upgrade policy", () => {
  test("[SR-11] disallowed origins are rejected and missing origins follow the switch", async () => {
    const strict = await startHarness({ allowMissingOrigin: false });
    expect(await expectUpgradeRejected(strict.url, { origin: "http://evil.example" })).toBe(403);
    expect(await expectUpgradeRejected(strict.url)).toBe(403);

    const listed = await openClient(strict.url, { origin: strict.origin });
    expect(listed.readyState).toBe(WebSocket.OPEN);
    listed.close();

    const dev = await startHarness({ allowMissingOrigin: true });
    const devMissing = await openClient(dev.url);
    expect(devMissing.readyState).toBe(WebSocket.OPEN);
    devMissing.close();
    const devListed = await openClient(dev.url, { origin: dev.origin });
    expect(devListed.readyState).toBe(WebSocket.OPEN);
    devListed.close();
  });

  test("[FR-4.4] upgrades are accepted only on /ws", async () => {
    const harness = await startHarness();
    const other = harness.url.replace("/ws", "/other");
    expect(await expectUpgradeRejected(other, { origin: harness.origin })).toBe(404);

    const withQuery = await openClient(`${harness.url}?room=ABCD`, { origin: harness.origin });
    expect(withQuery.readyState).toBe(WebSocket.OPEN);
    withQuery.close();
  });
});

describe("WebSocket frame limits", () => {
  test("[SR-6] binary frames over 64 bytes close with 1009", async () => {
    const harness = await startHarness();
    const client = await openClient(harness.url);
    const closed = nextClose(client);
    client.send(Buffer.alloc(65));
    expect((await closed).code).toBe(CLOSE.tooLarge);
  });

  test("[SR-6] text frames over 4096 bytes close with 1009", async () => {
    const harness = await startHarness();
    const client = await openClient(harness.url);
    const closed = nextClose(client);
    client.send("x".repeat(4097));
    expect((await closed).code).toBe(CLOSE.tooLarge);
  });

  test("[FR-4.4] invalid text closes 1008 and unknown binary types close 1002", async () => {
    const harness = await startHarness();

    const jsonClient = await openClient(harness.url);
    const jsonClosed = nextClose(jsonClient);
    jsonClient.send("{not json");
    expect((await jsonClosed).code).toBe(CLOSE.policy);

    const binaryClient = await openClient(harness.url);
    const binaryClosed = nextClose(binaryClient);
    binaryClient.send(Buffer.from([0x42, 0x00]));
    expect((await binaryClosed).code).toBe(CLOSE.protocol);
  });
});

describe("WebSocket roles and heartbeat", () => {
  test("[FR-4.4] messages in the wrong direction close with 1008", async () => {
    const harness = await startHarness();
    const room = harness.registry.createRoom();

    const controller = await openClient(harness.url);
    const joined = nextJson(controller, "joined");
    controller.send(JSON.stringify({ t: "join", v: 1, code: room.code, pin: room.pin }));
    await joined;
    const controllerClosed = nextClose(controller);
    controller.send(JSON.stringify({ t: "hostPause" }));
    expect((await controllerClosed).code).toBe(CLOSE.policy);

    const host = await openClient(harness.url);
    const hostJoined = nextJson(host, "hostJoined");
    host.send(
      JSON.stringify({ t: "hostJoin", v: 1, code: room.code, hostToken: room.hostToken }),
    );
    await hostJoined;
    const hostClosed = nextClose(host);
    host.send(JSON.stringify({ t: "join", v: 1, code: room.code, pin: room.pin }));
    expect((await hostClosed).code).toBe(CLOSE.policy);
  });

  test("[PR-6.1] accepted sockets disable Nagle", async () => {
    const spy = vi.spyOn(Socket.prototype, "setNoDelay");
    try {
      const harness = await startHarness();
      const client = await openClient(harness.url);
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 50));
      expect(spy).toHaveBeenCalledWith(true);
      client.close();
    } finally {
      spy.mockRestore();
    }
  });

  test("[FR-7.14] a silent socket is terminated after the dead window", async () => {
    const harness = await startHarness({ heartbeatMs: 20, deadAfterMs: 80 });
    const silent = await openClient(harness.url, { autoPong: false });
    const closed = nextClose(silent, 4000);
    expect((await closed).code).toBe(1006);

    const live = await openClient(harness.url);
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 200));
    expect(live.readyState).toBe(WebSocket.OPEN);
    live.close();
  });
});

describe("WebSocket message flow", () => {
  test("[FR-7.3] a joined controller's InputFwd reaches the host intact", async () => {
    const harness = await startHarness();
    const room = harness.registry.createRoom();

    const host = await openClient(harness.url);
    const hostJoined = nextJson(host, "hostJoined");
    host.send(
      JSON.stringify({ t: "hostJoin", v: 1, code: room.code, hostToken: room.hostToken }),
    );
    await hostJoined;

    const controller = await openClient(harness.url);
    const joined = nextJson(controller, "joined");
    controller.send(JSON.stringify({ t: "join", v: 1, code: room.code, pin: room.pin }));
    expect(await joined).toMatchObject({ t: "joined", slot: 1 });

    const forwarded = nextBinary(host);
    const sent = input({ tick: 4242, buttons: 0b101, edges: 0b100 });
    controller.send(encodeInput(sent));
    const decoded = decodeInputFwd(await forwarded);
    expect(decoded.slot).toBe(1);
    expect(decoded.state).toEqual(sent);
  });

  test("[FR-5.6] a bad join returns joinError and keeps the socket open", async () => {
    const harness = await startHarness();
    const room = harness.registry.createRoom();
    const client = await openClient(harness.url);

    const refused = nextJson(client, "joinError");
    client.send(JSON.stringify({ t: "join", v: 1, code: room.code, pin: wrongPin(room.pin) }));
    expect(await refused).toEqual({ t: "joinError", reason: "badPin" });
    expect(client.readyState).toBe(WebSocket.OPEN);

    const joined = nextJson(client, "joined");
    client.send(JSON.stringify({ t: "join", v: 1, code: room.code, pin: room.pin }));
    expect((await joined).t).toBe("joined");
  });

  test("[A2] a bad host token returns joinError and keeps the socket open", async () => {
    const harness = await startHarness();
    const room = harness.registry.createRoom();
    const host = await openClient(harness.url);

    const refused = nextJson(host, "joinError");
    host.send(JSON.stringify({ t: "hostJoin", v: 1, code: room.code, hostToken: "A".repeat(22) }));
    expect(await refused).toEqual({ t: "joinError", reason: "badHostToken" });
    expect(host.readyState).toBe(WebSocket.OPEN);

    const accepted = nextJson(host, "hostJoined");
    host.send(
      JSON.stringify({ t: "hostJoin", v: 1, code: room.code, hostToken: room.hostToken }),
    );
    const message = await accepted;
    expect(message.t).toBe("hostJoined");
    if (message.t === "hostJoined") {
      expect(message.code).toBe(room.code);
    }
  });

  test("[FR-7.14] binary Ping is answered with Pong echoing the client time", async () => {
    const harness = await startHarness();
    const client = await openClient(harness.url);

    const pong = nextBinary(client);
    client.send(encodePing(123456));
    const decoded = decodePong(await pong);
    expect(decoded.clientTimeMs).toBe(123456);
    expect(decoded.serverTimeMs).toBeGreaterThan(0);
  });

  test("[SR-9] websocket logs never contain tokens, sessions or PINs", async () => {
    const harness = await startHarness();
    const room = harness.registry.createRoom();

    const host = await openClient(harness.url);
    const hostJoined = nextJson(host, "hostJoined");
    host.send(
      JSON.stringify({ t: "hostJoin", v: 1, code: room.code, hostToken: room.hostToken }),
    );
    await hostJoined;

    const controller = await openClient(harness.url, { origin: harness.origin });
    const joined = nextJson(controller, "joined");
    controller.send(JSON.stringify({ t: "join", v: 1, code: room.code, pin: room.pin }));
    const joinedMessage = await joined;
    const session = joinedMessage.t === "joined" ? joinedMessage.session : "";
    expect(session).not.toBe("");

    const forwarded = nextBinary(host);
    controller.send(encodeInput(input({ tick: 1 })));
    await forwarded;

    controller.close();
    host.close();
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 50));

    assertNoSecretsLogged(harness.calls, [room.pin, room.roomToken, room.hostToken, session]);
  });
});
