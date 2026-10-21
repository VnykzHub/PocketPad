/**
 * D0-QA-02 — automated two-client echo acceptance run.
 *
 * Boots the real dev server (real broker, real WebSocket adapter, real `ws`
 * clients) on 127.0.0.1:0, creates a room through `POST /api/rooms`, joins a
 * host and controllers, and proves the D0 exit criterion: two clients echo
 * input to the host with slots 1 and 2, a 40 ms tap keeps its edge, and the
 * ninth controller gets `roomFull`.
 *
 * This harness is the regression base for D4's sessions/reconnect work.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket, type RawData } from "ws";
import {
  BUTTON_BITS,
  PROTOCOL_VERSION,
  decodeInputFwd,
  encodeInput,
  parseJsonMessage,
  stringifyJsonMessage,
  type ClientToServerMessage,
  type InputState,
  type JsonControlMessage,
} from "@lanpad/protocol";
import type { Logger } from "@lanpad/broker";
import { createDevServer, type DevServer, type StaticRoots } from "../src/index.js";

const silentLogger: Logger = { info() {} };
const A_MASK = 1 << BUTTON_BITS.A;

interface Credentials {
  code: string;
  pin: string;
  roomToken: string;
  hostToken: string;
  expiresAt: number;
  serverTime: number;
}

interface ReceivedFrame {
  frame: Uint8Array;
  receivedAt: number;
}

interface DecodedInputFrame {
  slot: number;
  state: InputState;
  receivedAt: number;
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
  root = mkdtempSync(join(tmpdir(), "lanpad-e2e-"));
  mkdirSync(join(root, "host", "assets"), { recursive: true });
  mkdirSync(join(root, "controller"), { recursive: true });
  mkdirSync(join(root, "games"), { recursive: true });
  mkdirSync(join(root, "experiments"), { recursive: true });
  writeFileSync(join(root, "host", "index.html"), "<!doctype html><title>HOST</title>");
  writeFileSync(join(root, "controller", "index.html"), "<!doctype html><title>CONTROLLER</title>");
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
      // A close after the test finishes must not surface as an unhandled error.
      client.on("error", () => {});
      resolve(client);
    });
    client.once("error", reject);
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

/** Collects the next `count` binary frames, timestamping each arrival. */
function collectBinary(
  client: WebSocket,
  count: number,
  timeoutMs = 5000,
): Promise<ReceivedFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: ReceivedFrame[] = [];
    const timer = setTimeout(() => {
      client.off("message", onMessage);
      reject(new Error(`timed out after ${frames.length}/${count} binary frames`));
    }, timeoutMs);
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (!isBinary) {
        return;
      }
      frames.push({ frame: toBytes(data), receivedAt: Date.now() });
      if (frames.length === count) {
        clearTimeout(timer);
        client.off("message", onMessage);
        resolve(frames);
      }
    };
    client.on("message", onMessage);
  });
}

function sendJson(client: WebSocket, message: ClientToServerMessage): void {
  client.send(stringifyJsonMessage(message));
}

function sendJoin(client: WebSocket, code: string, pin: string): void {
  sendJson(client, { t: "join", v: PROTOCOL_VERSION, code, pin });
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

function decodeFrames(frames: readonly ReceivedFrame[]): DecodedInputFrame[] {
  return frames.map(({ frame, receivedAt }) => {
    const decoded = decodeInputFwd(frame);
    return { slot: decoded.slot, state: decoded.state, receivedAt };
  });
}

function stateForSlot(frames: readonly DecodedInputFrame[], slot: number, label: string): InputState {
  const found = frames.find((entry) => entry.slot === slot);
  if (found === undefined) {
    throw new Error(`host never received ${label} for slot ${slot}`);
  }
  return found.state;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Opens a socket, joins with code+PIN, and returns the assigned slot. */
async function joinController(
  url: string,
  credentials: Credentials,
): Promise<{ client: WebSocket; slot: number }> {
  const client = await openClient(url);
  const joined = nextJson(client, "joined");
  sendJoin(client, credentials.code, credentials.pin);
  const message = await joined;
  if (message.t !== "joined") {
    throw new Error(`expected joined, got ${message.t}`);
  }
  return { client, slot: message.slot };
}

describe("D0 two-client echo acceptance", () => {
  test(
    "[G4][FR-7.3][FR-5.3][G2][A1] two clients join and echo input through the real dev server",
    async () => {
      const staticRoots = makeStaticRoots();
      app = createDevServer(
        { host: "127.0.0.1", port: 0, staticRoots, allowedOrigins: [] },
        { logger: silentLogger },
      );
      const { port } = await app.listen();
      const base = `http://127.0.0.1:${port}`;
      const wsUrl = `${base.replace(/^http:/, "ws:")}/ws`;

      // --- Room creation through the real HTTP route (A8) -------------------
      const roomResponse = await fetch(`${base}/api/rooms`, { method: "POST" });
      expect(roomResponse.status).toBe(201);
      const credentials = (await roomResponse.json()) as Credentials;
      expect(credentials.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(credentials.pin).toMatch(/^\d{4}$/);

      // --- Host WebSocket auth (A2) -----------------------------------------
      const host = await openClient(wsUrl);
      const hostJoined = nextJson(host, "hostJoined");
      sendJson(host, {
        t: "hostJoin",
        v: PROTOCOL_VERSION,
        code: credentials.code,
        hostToken: credentials.hostToken,
      });
      const hostMessage = await hostJoined;
      expect(hostMessage.t).toBe("hostJoined");

      // --- Two controllers join and get slots 1 and 2 (G4) ------------------
      const first = await joinController(wsUrl, credentials);
      const second = await joinController(wsUrl, credentials);
      expect(first.slot).toBe(1);
      expect(second.slot).toBe(2);

      // --- A 40 ms tap: press edge then release (FR-7.3, G2) ----------------
      const pressWaiter = collectBinary(host, 2);
      const tapStartedAt = Date.now();
      const tick = tapStartedAt >>> 0;
      first.client.send(encodeInput(input({ tick, buttons: A_MASK, edges: A_MASK })));
      second.client.send(encodeInput(input({ tick, buttons: A_MASK, edges: A_MASK })));

      const pressFrames = decodeFrames(await pressWaiter);
      for (const frame of pressFrames) {
        // Not a latency proof (E5 owns that); the harness must forward in-turn.
        expect(frame.receivedAt - tapStartedAt).toBeLessThan(100);
      }
      const firstPress = stateForSlot(pressFrames, 1, "a press frame");
      const secondPress = stateForSlot(pressFrames, 2, "a press frame");
      expect(firstPress.buttons).toBe(A_MASK);
      expect(firstPress.edges).toBe(A_MASK);
      expect(secondPress.buttons).toBe(A_MASK);
      expect(secondPress.edges).toBe(A_MASK);

      // Hold the tap for 40 ms, then release both controllers.
      const elapsed = Date.now() - tapStartedAt;
      if (elapsed < 40) {
        await delay(40 - elapsed);
      }
      const releaseWaiter = collectBinary(host, 2);
      first.client.send(encodeInput(input({ tick: (tick + 40) >>> 0 })));
      second.client.send(encodeInput(input({ tick: (tick + 40) >>> 0 })));
      const releaseFrames = decodeFrames(await releaseWaiter);
      for (const slot of [1, 2]) {
        const release = stateForSlot(releaseFrames, slot, "a release frame");
        expect(release.buttons).toBe(0);
        expect(release.edges).toBe(0);
      }

      // --- Slots 3..8 fill, then the ninth controller is refused (FR-5.3) ---
      for (let expectedSlot = 3; expectedSlot <= 8; expectedSlot += 1) {
        const extra = await joinController(wsUrl, credentials);
        expect(extra.slot).toBe(expectedSlot);
      }

      const ninth = await openClient(wsUrl);
      const refused = nextJson(ninth, "joinError");
      sendJoin(ninth, credentials.code, credentials.pin);
      expect(await refused).toEqual({ t: "joinError", reason: "roomFull" });
    },
    20_000,
  );
});
