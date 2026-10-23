/**
 * Launcher phone remote (spec 25 §2.7; ER-25-04, FR-7.8).
 *
 * While `launcher-remote-v1` is mounted, Select/Back/d-pad presses become
 * `{t:"event", name:"remote", data:"..."}` on press edges only. The launcher
 * bits never enter the wire input store, so a running game gets no duplicate
 * input. A layout-away swap suppresses the mapping, and a reconnect rejoin
 * keeps it (including replay of a press buffered during the gap).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutDocument } from "@lanpad/sdk";
import { LauncherRemoteInput } from "../src/controls/launcherRemoteInput.js";
import {
  LAUNCHER_REMOTE_BITS,
  LAUNCHER_REMOTE_LAYOUT,
  type LauncherRemoteButton,
} from "../src/layout/launcherRemote.js";
import { ControllerClient, type ControllerSocket } from "../src/net/controllerClient.js";

const SURFACE_SIZE = { width: 800, height: 400 } as const;

const SELECT = { x: 624, y: 288 } as const;
const BACK = { x: 624, y: 160 } as const;
const DPAD = {
  up: { x: 192, y: 224 },
  down: { x: 192, y: 304 },
  left: { x: 152, y: 264 },
  right: { x: 232, y: 264 },
} as const;
const GAME_BUTTON = { x: 400, y: 200 } as const;

const GAME_LAYOUT: LayoutDocument = {
  schemaVersion: 1,
  id: "game-v1",
  orientation: "any",
  controls: [
    {
      type: "button",
      id: "fire",
      label: "Fire",
      shape: "circle",
      x: "50%",
      y: "50%",
      r: "10%",
      bit: 0,
    },
  ],
};

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
    // Handlers are detached by the client before closing.
  }

  open(): void {
    this.onopen?.();
  }

  serverClose(): void {
    this.onclose?.({ code: 1006, reason: "lost" });
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  messages(): Record<string, unknown>[] {
    return this.sent
      .filter((entry): entry is string => typeof entry === "string")
      .map((text) => JSON.parse(text) as Record<string, unknown>);
  }
}

let nowMs = 0;
let socket: FakeSocket;
let client: ControllerClient;
let surface: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  nowMs = 1_000;
  socket = new FakeSocket();
  surface = document.createElement("div");
  document.body.append(surface);
  client = new ControllerClient({
    origin: "http://localhost:8080",
    createSocket: () => socket,
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

interface TouchPoint {
  identifier: number;
  clientX: number;
  clientY: number;
}

function dispatchTouch(
  target: HTMLElement,
  type: string,
  points: TouchPoint[],
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "changedTouches", { value: points });
  Object.defineProperty(event, "touches", { value: points });
  target.dispatchEvent(event);
}

function touch(identifier: number, point: { x: number; y: number }): TouchPoint {
  return { identifier, clientX: point.x, clientY: point.y };
}

function press(point: { x: number; y: number }, identifier = 1): void {
  dispatchTouch(surface, "touchstart", [touch(identifier, point)]);
}

function release(point: { x: number; y: number }, identifier = 1): void {
  dispatchTouch(surface, "touchend", [touch(identifier, point)]);
}

function tap(point: { x: number; y: number }, identifier = 1): void {
  press(point, identifier);
  release(point, identifier);
}

function join(layout: LayoutDocument = LAUNCHER_REMOTE_LAYOUT): void {
  client.connect("ABCD", "1234");
  socket.open();
  socket.deliver({
    t: "joined",
    slot: 1,
    session: "session-1",
    serverTime: 5_000,
    layout,
  });
}

function remoteMessages(): Record<string, unknown>[] {
  return socket
    .messages()
    .filter((message) => message["t"] === "event" && message["name"] === "remote");
}

function remoteButtons(): unknown[] {
  return remoteMessages().map((message) => message["data"]);
}

describe("[ER-25-04] launcher remote input adapter", () => {
  it("[ER-25-04] emits once per press edge and keeps bits out of the input store", () => {
    const emitted: LauncherRemoteButton[] = [];
    const input = new LauncherRemoteInput((button) => emitted.push(button));

    input.setButton(LAUNCHER_REMOTE_BITS.select, true);
    input.setButton(LAUNCHER_REMOTE_BITS.select, true);
    input.setButton(LAUNCHER_REMOTE_BITS.select, false);
    input.setButton(LAUNCHER_REMOTE_BITS.back, true);
    input.setButton(LAUNCHER_REMOTE_BITS.back, false);

    expect(emitted).toEqual(["ok", "back"]);
    expect(input.snapshot(0).buttons).toBe(0);
    expect(input.snapshot(0).edges).toBe(0);
  });

  it("[ER-25-04] maps every launcher bit and ignores unmapped bits", () => {
    const emitted: LauncherRemoteButton[] = [];
    const input = new LauncherRemoteInput((button) => emitted.push(button));
    const bits = [
      LAUNCHER_REMOTE_BITS.select,
      LAUNCHER_REMOTE_BITS.back,
      LAUNCHER_REMOTE_BITS.up,
      LAUNCHER_REMOTE_BITS.down,
      LAUNCHER_REMOTE_BITS.left,
      LAUNCHER_REMOTE_BITS.right,
    ];

    for (const bit of bits) {
      input.setButton(bit, true);
      input.setButton(bit, false);
    }

    expect(emitted).toEqual(["ok", "back", "up", "down", "left", "right"]);

    input.setButton(5, true);
    input.setButton(5, false);
    expect(emitted).toHaveLength(6);
    expect(input.snapshot(0).buttons).toBe(0);
  });

  it("[ER-25-04] reset drops a held level without emitting", () => {
    const emitted: LauncherRemoteButton[] = [];
    const input = new LauncherRemoteInput((button) => emitted.push(button));

    input.setButton(LAUNCHER_REMOTE_BITS.select, true);
    input.reset();
    input.setButton(LAUNCHER_REMOTE_BITS.select, true);

    expect(emitted).toEqual(["ok", "ok"]);
  });
});

describe("[ER-25-04][FR-7.8] phone remote drives the console", () => {
  it("[ER-25-04] Select and Back emit on press, never on release", () => {
    join();

    press(SELECT);
    expect(remoteButtons()).toEqual(["ok"]);
    release(SELECT);
    expect(remoteButtons()).toEqual(["ok"]);

    tap(BACK);
    expect(remoteButtons()).toEqual(["ok", "back"]);
    expect(remoteMessages()).toHaveLength(2);

    // No launcher bit reached the wire input store.
    expect(client.input.snapshot(0).buttons).toBe(0);
    expect(client.input.snapshot(0).edges).toBe(0);
  });

  it("[ER-25-04] d-pad directions map to up, down, left and right", () => {
    join();

    tap(DPAD.up);
    tap(DPAD.down);
    tap(DPAD.left);
    tap(DPAD.right);

    expect(remoteButtons()).toEqual(["up", "down", "left", "right"]);
    expect(client.input.snapshot(0).buttons).toBe(0);
  });

  it("[ER-25-04] a non-launcher layout suppresses the remote mapping", () => {
    join();
    socket.deliver({ t: "setLayout", slot: 1, layout: GAME_LAYOUT });
    expect(client.layout?.id).toBe("game-v1");

    press(GAME_BUTTON);
    expect(remoteButtons()).toEqual([]);
    expect(client.input.snapshot(0).buttons & (1 << 0)).not.toBe(0);

    release(GAME_BUTTON);
    expect(client.input.snapshot(0).buttons & (1 << 0)).toBe(0);
    expect(remoteButtons()).toEqual([]);
  });

  it("[ER-25-04] swapping away while held emits no remote release", () => {
    join();
    press(SELECT);
    expect(remoteButtons()).toEqual(["ok"]);

    socket.deliver({ t: "setLayout", slot: 1, layout: GAME_LAYOUT });
    release(SELECT);

    expect(remoteButtons()).toEqual(["ok"]);
    expect(client.input.snapshot(0).buttons).toBe(0);
  });

  it("[FR-7.8] reconnect replays a buffered remote press once and keeps the mapping", () => {
    join();
    tap(SELECT);
    expect(remoteButtons()).toEqual(["ok"]);

    socket.serverClose();
    expect(client.currentState.status).toBe("reconnecting");

    // Pressed while the socket is down: queued, not sent yet.
    tap(BACK);
    expect(remoteButtons()).toEqual(["ok"]);

    vi.advanceTimersByTime(300);
    nowMs += 300;
    socket.open();
    const sessionJoin = socket
      .messages()
      .filter((message) => message["t"] === "join")
      .at(-1);
    expect(sessionJoin).toMatchObject({ t: "join", session: "session-1" });

    socket.deliver({
      t: "joined",
      slot: 1,
      session: "session-1",
      serverTime: 5_300,
      layout: LAUNCHER_REMOTE_LAYOUT,
    });

    // The same-id layout replay is idempotent; the buffered Back is sent once.
    expect(remoteButtons()).toEqual(["ok", "back"]);
    expect(surface.querySelectorAll(".control")).toHaveLength(4);

    tap(SELECT);
    expect(remoteButtons()).toEqual(["ok", "back", "ok"]);
    expect(client.input.snapshot(0).buttons).toBe(0);
  });
});
