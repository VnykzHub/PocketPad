/**
 * G3 — four-bot end-to-end run through the real stack.
 *
 * Boots the real dev server (real broker + WebSocket adapter) on 127.0.0.1:0,
 * creates a room through `POST /api/rooms`, joins a host, and starts four
 * `@lanpad/input-bot` controllers against the same socket endpoint a phone
 * uses. Each bot presses A; the host must receive four InputFwd frames with
 * distinct slots 1..4 and the press edge intact (FR-7.3), while `/healthz`
 * stays a cheap room count (FR-5.2).
 *
 * The test never sleeps on a fixed schedule: it waits for the exact binary
 * frames and messages it asserts on. Game resolution happens host-side in DOM
 * code and is covered by the runtime suite; this run proves the wire path.
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
  parseJsonMessage,
  stringifyJsonMessage,
  type ClientToServerMessage,
  type InputState,
} from "@lanpad/protocol";
import type { Logger } from "@lanpad/broker";
import { createBots, type Bot } from "../../../tools/input-bot/src/bot.js";
import type { MacroAction } from "../../../tools/input-bot/src/macros.js";
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

interface Health {
  ok: boolean;
  now: number;
  rooms: number;
}

let app: DevServer | null = null;
let root = "";
let bots: Bot[] = [];
const clients = new Set<WebSocket>();

afterEach(async () => {
  for (const bot of bots) {
    bot.stop();
  }
  bots = [];
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
  root = mkdtempSync(join(tmpdir(), "lanpad-e2e-bots-"));
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
      client.on("error", () => {});
      resolve(client);
    });
    client.once("error", reject);
  });
}

function nextJson(client: WebSocket, expectedType: string, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("message", onMessage);
      reject(new Error(`timed out waiting for a ${expectedType} message`));
    }, timeoutMs);
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (isBinary) return;
      const message = parseJsonMessage(Buffer.from(toBytes(data)).toString("utf8"));
      if (message.t !== expectedType) return;
      clearTimeout(timer);
      client.off("message", onMessage);
      resolve(message);
    };
    client.on("message", onMessage);
  });
}

function sendJson(client: WebSocket, message: ClientToServerMessage): void {
  client.send(stringifyJsonMessage(message));
}

/**
 * Resolves once the host has forwarded an A press for every expected slot.
 * Frames for other slots or without the button held are ignored, so the wait
 * is on the exact evidence the test asserts on, never on elapsed time.
 */
function waitForSlotPresses(
  host: WebSocket,
  slots: readonly number[],
  timeoutMs = 10_000,
): Promise<Map<number, InputState>> {
  return new Promise((resolve, reject) => {
    const pending = new Set(slots);
    const seen = new Map<number, InputState>();
    const timer = setTimeout(() => {
      host.off("message", onMessage);
      reject(new Error(`timed out waiting for a press from slot(s) ${[...pending].join(", ")}`));
    }, timeoutMs);
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (!isBinary) return;
      const decoded = decodeInputFwd(toBytes(data));
      if (!pending.has(decoded.slot)) return;
      if ((decoded.state.buttons & A_MASK) !== A_MASK) return;
      seen.set(decoded.slot, decoded.state);
      pending.delete(decoded.slot);
      if (pending.size === 0) {
        clearTimeout(timer);
        host.off("message", onMessage);
        resolve(seen);
      }
    };
    host.on("message", onMessage);
  });
}

describe("G3 four-bot acceptance", () => {
  test(
    "[FR-5.2][FR-5.3][FR-7.3] four input-bots join through the real dev server and reach the host",
    async () => {
      const staticRoots = makeStaticRoots();
      app = createDevServer(
        { host: "127.0.0.1", port: 0, staticRoots, allowedOrigins: [] },
        { logger: silentLogger },
      );
      const { port } = await app.listen();
      const base = `http://127.0.0.1:${port}`;
      const wsUrl = `${base.replace(/^http:/, "ws:")}/ws`;

      // --- Room creation over the real HTTP route --------------------------
      const roomResponse = await fetch(`${base}/api/rooms`, { method: "POST" });
      expect(roomResponse.status).toBe(201);
      const credentials = (await roomResponse.json()) as Credentials;
      expect(credentials.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(credentials.pin).toMatch(/^\d{4}$/);

      // --- Host WebSocket auth ---------------------------------------------
      const host = await openClient(wsUrl);
      const hostJoined = nextJson(host, "hostJoined");
      sendJson(host, {
        t: "hostJoin",
        v: PROTOCOL_VERSION,
        code: credentials.code,
        hostToken: credentials.hostToken,
      });
      await hostJoined;

      // Attach the frame waiter before any bot exists so no press is missed.
      const presses = waitForSlotPresses(host, [1, 2, 3, 4]);

      // Every bot presses A from its first active tick and holds it.
      const pressA: MacroAction[] = [{ atMs: 0, type: "press", buttons: ["A"] }];
      bots = createBots(
        {
          server: base,
          code: credentials.code,
          pin: credentials.pin,
          macros: pressA,
          pingIntervalMs: 1000,
        },
        4,
      );
      for (const bot of bots) bot.start();

      const seen = await presses;

      // --- Every bot reached the host on its own slot, edge intact ---------
      expect([...seen.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
      for (const state of seen.values()) {
        expect(state.buttons & A_MASK).toBe(A_MASK);
        expect(state.edges & A_MASK).toBe(A_MASK);
      }

      // --- Bots agree on their assigned slots and their own contracts ------
      expect(bots.map((bot) => bot.summary().slot)).toEqual([1, 2, 3, 4]);
      for (const bot of bots) {
        expect(bot.joined).toBe(true);
        expect(bot.failureDetails).toEqual([]);
        const summary = bot.summary();
        expect(summary.failures).toBe(0);
        expect(summary.sent).toBeGreaterThan(0);
      }

      // --- /healthz stays a cheap room count -------------------------------
      const healthResponse = await fetch(`${base}/healthz`);
      expect(healthResponse.status).toBe(200);
      const health = (await healthResponse.json()) as Health;
      expect(health.ok).toBe(true);
      expect(health.rooms).toBe(1);
      expect(typeof health.now).toBe("number");
      // It reports counts, never room credentials.
      const healthText = JSON.stringify(health);
      expect(healthText.includes(credentials.roomToken)).toBe(false);
      expect(healthText.includes(credentials.hostToken)).toBe(false);
      expect(healthText.includes(credentials.code)).toBe(false);
    },
    20_000,
  );
});
