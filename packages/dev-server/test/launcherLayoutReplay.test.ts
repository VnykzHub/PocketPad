/**
 * Launcher remote layout survives a controller reconnect (FR-8.2; spec 25 §2.7).
 *
 * Boots the real dev server (real broker, real WebSocket adapter, real `ws`
 * clients) and proves the path the host relies on after a phone drops: the
 * broker stores the last layout per controller slot and replays it right after
 * `joined`, so a rejoin restores `launcher-remote-v1` without a host resend.
 *
 * The layout document is read from the controller-owned fixture (test-only);
 * the host itself carries its mirror in `packages/runtime/src/host/launcherLayout.ts`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket, type RawData } from "ws";
import {
  PROTOCOL_VERSION,
  parseJsonMessage,
  stringifyJsonMessage,
  type ClientToServerMessage,
  type HostToServerMessage,
  type JsonControlMessage,
  type JsonValue,
} from "@lanpad/protocol";
import type { Logger } from "@lanpad/broker";
import { createDevServer, type DevServer, type StaticRoots } from "../src/index.js";

const silentLogger: Logger = { info() {} };

const LAUNCHER_LAYOUT = JSON.parse(
  readFileSync(
    new URL("../../controller/layouts/launcher-remote-v1.json", import.meta.url),
    "utf8",
  ),
) as JsonValue;

interface Credentials {
  code: string;
  pin: string;
  roomToken: string;
  hostToken: string;
  expiresAt: number;
  serverTime: number;
}

interface JoinedMessage {
  readonly slot: number;
  readonly session: string;
}

let app: DevServer | null = null;
let root = "";
const clients = new Set<WebSocket>();

afterEach(async () => {
  for (const client of clients) {
    client.terminate();
  }
  clients.clear();
  if (app !== null) {
    await app.close();
    app = null;
  }
  if (root !== "") {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

function makeStaticRoots(): StaticRoots {
  root = mkdtempSync(join(tmpdir(), "lanpad-launcher-layout-"));
  for (const directory of ["host", "controller", "games", "experiments"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(join(root, "host", "index.html"), "<!doctype html><title>HOST</title>");
  writeFileSync(
    join(root, "controller", "index.html"),
    "<!doctype html><title>CONTROLLER</title>",
  );
  return {
    host: join(root, "host"),
    controller: join(root, "controller"),
    games: join(root, "games"),
    experiments: join(root, "experiments"),
  };
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    const merged = Buffer.concat(data);
    return new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
  }
  if (data instanceof Buffer) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data);
}

function openClient(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    clients.add(client);
    client.once("open", () => {
      client.on("error", () => {});
      resolve(client);
    });
    client.once("error", reject);
  });
}

function closeClient(client: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    client.once("close", () => resolve());
    client.close();
  });
}

function nextJson(
  client: WebSocket,
  expectedType: string,
  timeoutMs = 5000,
): Promise<JsonControlMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("message", onMessage);
      reject(new Error(`timed out waiting for a ${expectedType} message`));
    }, timeoutMs);
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (isBinary) {
        return;
      }
      const message = parseJsonMessage(Buffer.from(toBytes(data)).toString("utf8"));
      if (message.t !== expectedType) {
        return;
      }
      clearTimeout(timer);
      client.off("message", onMessage);
      resolve(message);
    };
    client.on("message", onMessage);
  });
}

function sendJson(
  client: WebSocket,
  message: ClientToServerMessage | HostToServerMessage,
): void {
  client.send(stringifyJsonMessage(message));
}

describe("[FR-8.2] launcher layout reconnect replay", () => {
  test(
    "[FR-8.2][ER-25-04] a phone reconnect replays launcher-remote-v1 through the broker",
    async () => {
      app = createDevServer(
        { host: "127.0.0.1", port: 0, staticRoots: makeStaticRoots(), allowedOrigins: [] },
        { logger: silentLogger },
      );
      const { port } = await app.listen();
      const base = `http://127.0.0.1:${port}`;
      const wsUrl = `${base.replace(/^http:/, "ws:")}/ws`;

      const roomResponse = await fetch(`${base}/api/rooms`, { method: "POST" });
      expect(roomResponse.status).toBe(201);
      const credentials = (await roomResponse.json()) as Credentials;

      const host = await openClient(wsUrl);
      const hostJoined = nextJson(host, "hostJoined");
      sendJson(host, {
        t: "hostJoin",
        v: PROTOCOL_VERSION,
        code: credentials.code,
        hostToken: credentials.hostToken,
      });
      expect((await hostJoined).t).toBe("hostJoined");

      const controller = await openClient(wsUrl);
      const joined = nextJson(controller, "joined");
      sendJson(controller, {
        t: "join",
        v: PROTOCOL_VERSION,
        code: credentials.code,
        pin: credentials.pin,
      });
      const joinedMessage = (await joined) as unknown as JoinedMessage;
      expect(joinedMessage.slot).toBe(1);

      // The host broadcasts the launcher layout once the room is ready.
      const layoutFrame = nextJson(controller, "setLayout");
      sendJson(host, { t: "setLayout", slot: "all", layout: LAUNCHER_LAYOUT });
      const delivered = await layoutFrame;
      expect(delivered).toMatchObject({
        t: "setLayout",
        slot: "all",
        layout: LAUNCHER_LAYOUT,
      });

      // Drop the phone (slot reserved for 30 s), then rejoin with its session.
      await closeClient(controller);

      const reconnected = await openClient(wsUrl);
      const rejoined = nextJson(reconnected, "joined");
      const replay = nextJson(reconnected, "setLayout");
      sendJson(reconnected, {
        t: "join",
        v: PROTOCOL_VERSION,
        code: credentials.code,
        session: joinedMessage.session,
      });

      const rejoinMessage = (await rejoined) as unknown as JoinedMessage;
      expect(rejoinMessage.slot).toBe(1);
      expect(await replay).toMatchObject({
        t: "setLayout",
        slot: 1,
        layout: LAUNCHER_LAYOUT,
      });
    },
    15_000,
  );
});
