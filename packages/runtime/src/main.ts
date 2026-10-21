/**
 * Host page shell (D0-RT-01).
 *
 * Boot flow: create a room with `POST /api/rooms`, show code + PIN, connect the
 * same-origin WebSocket, send `hostJoin`, then update the debug slot table from
 * `playerJoined/Left` and binary `InputFwd` frames.
 *
 * D3 replaces the body of `#game-root` with the runtime; this shell keeps the
 * keyboard start path (AR-4), the connection pill and the debug table.
 *
 * Secrets: `roomToken` is discarded immediately. `hostToken` is kept in host
 * memory and `sessionStorage` only; it never reaches the DOM, a URL or a log
 * (FR-5.1, SR-9). Displaying the room PIN is intentional; the persistent
 * "anyone with this code can join" notice lands with D4 (SR-10).
 */
import type { ServerToClientMessage } from "@lanpad/protocol";
import { resolveServerOrigin } from "@lanpad/sdk";
import { InputTable } from "./debug/inputTable.js";
import {
  HostClient,
  shouldCreateRoomOnKey,
  storeHostToken,
  type HostPhase,
  type RoomCredentials,
} from "./net/hostClient.js";
import "./style.css";

/** Only the fields the host needs after creation; the room token is dropped. */
interface HostRoom {
  code: string;
  hostToken: string;
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`Host shell is missing #${id}.`);
  }
  return found;
}

const connectionEl = element("connection");
const codeEl = element("room-code");
const pinEl = element("room-pin");
const hintEl = element("room-hint");
const slotsEl = element("slots");

const debug = new URLSearchParams(window.location.search).get("debug") === "1";
const table = new InputTable(slotsEl, { showTick: debug });
const client = new HostClient();

let phase: HostPhase = "idle";
let room: HostRoom | null = null;

function setConnection(text: string, tone: "pending" | "ok" | "bad"): void {
  connectionEl.textContent = text;
  connectionEl.dataset["state"] = tone;
}

function renderTable(): void {
  table.render(performance.now());
}

client.onOpen(() => {
  const current = room;
  if (current === null) {
    return;
  }
  setConnection("Joining room…", "pending");
  client.sendHostJoin(current.code, current.hostToken);
});

client.onClose((info) => {
  phase = "failed";
  const code = info.code;
  setConnection(
    code === undefined || code === 1000 ? "Disconnected" : `Disconnected (${code})`,
    "bad",
  );
  hintEl.textContent = "Press Enter to start a new room.";
});

client.onError(() => {
  setConnection("Connection error", "bad");
});

client.onMessage((message: ServerToClientMessage) => {
  switch (message.t) {
    case "hostJoined":
      phase = "ready";
      setConnection(`Connected — room ${message.code}`, "ok");
      hintEl.textContent = "";
      break;
    case "joinError":
      phase = "failed";
      setConnection(`Host join failed: ${message.reason}`, "bad");
      hintEl.textContent = "Press Enter to start a new room.";
      break;
    case "playerJoined":
      table.setPlayerJoined(message.slot);
      renderTable();
      break;
    case "playerLeft":
      table.setPlayerLeft(message.slot);
      renderTable();
      break;
    case "kick":
      phase = "failed";
      setConnection(`Removed from the room: ${message.reason}`, "bad");
      break;
    default:
      // setLayout, panel, stats and player suspend/resume belong to later stages.
      break;
  }
});

client.onInput((slot, state) => {
  table.setInput(slot, state, performance.now());
  renderTable();
});

async function createRoom(): Promise<void> {
  if (phase === "creating") {
    return;
  }
  phase = "creating";
  setConnection("Creating room…", "pending");

  const origin = resolveServerOrigin();
  let credentials: RoomCredentials;
  try {
    credentials = await client.createRoom(origin);
  } catch {
    phase = "failed";
    setConnection("Could not create a room", "bad");
    hintEl.textContent = "Press Enter to retry.";
    return;
  }

  room = { code: credentials.code, hostToken: credentials.hostToken };
  codeEl.textContent = credentials.code;
  pinEl.textContent = `PIN ${credentials.pin}`;
  hintEl.textContent = "";

  try {
    storeHostToken(window.sessionStorage, credentials.code, credentials.hostToken);
  } catch {
    // Per-tab storage can be unavailable (private mode); the token stays in memory.
  }

  setConnection("Connecting…", "pending");
  try {
    client.connect(origin);
  } catch {
    phase = "failed";
    setConnection("Could not open the host socket", "bad");
    hintEl.textContent = "Press Enter to start a new room.";
  }
}

window.addEventListener("keydown", (event) => {
  if (!shouldCreateRoomOnKey(event.key, phase)) {
    return;
  }
  event.preventDefault();
  void createRoom();
});

// Refresh only the age column; input packets already render on arrival.
window.setInterval(renderTable, 250);

// Opening `/` creates a room immediately (D0 acceptance). Enter is the
// keyboard path for a retry or for a future idle start screen (AR-4).
void createRoom();
