/**
 * Room creation, host session recovery and the host socket switch (D0/D4).
 *
 * Everything room-scoped lives here: the `HostClient`, the recovery state
 * machine, the broker message switch, slot presence and the 1 Hz server stats.
 * A stage teardown never reaches this module, which is what keeps phones
 * connected while a host moves between the launcher and a game.
 *
 * Secrets: `hostToken` is kept in host memory and `sessionStorage` only. The
 * room token is handed to the RoomPanel solely to draw the join QR and is
 * never written to text, attributes or logs (FR-5.1, SR-9).
 */
import type { ServerToClientMessage, SlotStats } from "@lanpad/protocol";
import { resolveServerOrigin } from "@lanpad/sdk";
import type { EventRouter } from "../game/EventRouter.js";
import type { LayoutApi } from "../game/LayoutApi.js";
import type { PanelApi } from "../game/PanelApi.js";
import type { InputMapper } from "../input/InputMapper.js";
import {
  HostClient,
  storeHostToken,
  type HostPhase,
  type RoomCredentials,
} from "../net/hostClient.js";
import {
  HostReconnect,
  type HostRecoveryState,
  type HostSession,
} from "../net/hostReconnect.js";
import type { RoomPanel } from "../ui/RoomPanel.js";
import type { HostChrome } from "./chrome.js";
import { CREATE_ROOM_LABEL, ROOM_ENDED_TITLE } from "./copy.js";
import type { HostNotices } from "./notices.js";
import type { HostRoster } from "./roster.js";
import { slotRosterStateFor } from "./routes.js";

/** Only the fields the host needs after creation. */
interface HostRoom {
  code: string;
  hostToken: string;
}

export interface RoomDeps {
  readonly window: Window;
  readonly client: HostClient;
  readonly mapper: InputMapper;
  readonly layouts: LayoutApi;
  readonly panels: PanelApi;
  readonly events: EventRouter;
  readonly roster: HostRoster;
  readonly chrome: HostChrome;
  readonly roomPanel: RoomPanel;
  readonly hintEl: HTMLElement;
  readonly notices: HostNotices;
  readonly syncPause: () => void;
  readonly maybeShowLauncher: () => void;
  readonly destroyLauncher: () => void;
  readonly resetRouteToLauncher: () => void;
}

export interface RoomController {
  createRoom(): Promise<void>;
  /** D4-HOST-02 boot: resume this tab's room before creating a new one. */
  bootHost(): Promise<void>;
  getPhase(): HostPhase;
  isNetworkLost(): boolean;
  getRoomCode(): string | null;
  getServerStats(): ReadonlyArray<SlotStats>;
  /** Visibility pause also tells the recovery machine not to retry. */
  pauseForVisibility(): void;
  resumeForVisibility(): void;
}

export function createRoomController(deps: RoomDeps): RoomController {
  let phase: HostPhase = "idle";
  let room: HostRoom | null = null;
  /** Latest 1 Hz server slot stats; the overlay prefers these for RTT/jitter. */
  let serverStats: SlotStats[] = [];
  /** Set when the host socket drops; cleared on the next hostJoined. */
  let networkLost = false;

  /** Per-tab storage can throw (private mode); recovery then keeps memory only. */
  function sessionStorageOrNull(): Storage | null {
    try {
      return deps.window.sessionStorage;
    } catch {
      return null;
    }
  }

  function handleRecoveryState(state: HostRecoveryState): void {
    switch (state) {
      case "reconnecting":
        deps.roomPanel.setHostStatus("reconnecting");
        deps.chrome.setConnection("Reconnecting…", "pending");
        deps.chrome.showReconnectBanner(true);
        break;
      case "connected":
        deps.roomPanel.setHostStatus("connected");
        deps.chrome.showReconnectBanner(false);
        break;
      case "lost":
        deps.roomPanel.setHostStatus("lost");
        deps.chrome.showReconnectBanner(false);
        break;
      default:
        break;
    }
  }

  function handleHostResumed(session: HostSession): void {
    room = { code: session.code, hostToken: session.hostToken };
    networkLost = false;
    phase = "ready";
    deps.syncPause();
    deps.roomPanel.setHostJoined(true);
    deps.chrome.setConnection("Connected", "ok");
    deps.hintEl.textContent = "Room resumed.";
    deps.chrome.showReconnectBanner(false);
    deps.roster.updateStageBar();
    deps.layouts.resendAll();
    deps.panels.resendAll();
    deps.maybeShowLauncher();
  }

  function handleHostLost(): void {
    clearRoomState();
    networkLost = true;
    phase = "idle";
    deps.syncPause();
    deps.roomPanel.setHostStatus("lost");
    deps.chrome.setConnection("Room lost — starting a new room…", "bad");
    deps.hintEl.textContent = "Room lost. Creating a new room…";
    deps.chrome.showReconnectBanner(false);
    // Same recovery contract as D4: a lost room starts a fresh one.
    void createRoom();
  }

  const recovery = new HostReconnect({
    client: deps.client,
    storage: sessionStorageOrNull(),
    onStateChange: handleRecoveryState,
    onResumed: handleHostResumed,
    onLost: handleHostLost,
  });

  /** Clears room-scoped game/UI state; leaves phase and socket handling alone. */
  function clearRoomState(): void {
    deps.layouts.clearAll();
    deps.panels.clearAll();
    serverStats = [];
    deps.mapper.reset();
    deps.roster.markAllPlayersLeft();
    room = null;
    deps.roster.resetSlots();
    deps.roster.renderTable();
    deps.roomPanel.setRoom(null);
  }

  async function createRoom(): Promise<void> {
    if (phase === "creating") {
      return;
    }
    phase = "creating";
    // A new room replaces any pending recovery timer/session.
    recovery.forget();
    deps.destroyLauncher();
    deps.chrome.setConnection("Creating room…", "pending");
    deps.chrome.showReconnectBanner(false);

    let origin: string;
    let credentials: RoomCredentials;
    try {
      origin = resolveServerOrigin();
      credentials = await deps.client.createRoom(origin);
    } catch {
      phase = "failed";
      deps.chrome.setConnection("Could not create a room", "bad");
      deps.hintEl.textContent = "Press Enter to retry.";
      return;
    }

    const current: HostRoom = {
      code: credentials.code,
      hostToken: credentials.hostToken,
    };
    // Never leak the previous room's private panels/layouts into a new room.
    clearRoomState();
    deps.notices.clear();
    room = current;
    deps.roomPanel.setRoom({
      code: credentials.code,
      pin: credentials.pin,
      roomToken: credentials.roomToken,
    });
    deps.roomPanel.setHostJoined(false);
    deps.roster.updateStageBar();
    // The lobby hero is the only place the code/PIN are rendered (HP-02).
    deps.maybeShowLauncher();

    try {
      storeHostToken(
        deps.window.sessionStorage,
        credentials.code,
        credentials.hostToken,
      );
    } catch {
      // Per-tab storage can be unavailable (private mode); the token stays in memory.
    }

    deps.chrome.setConnection("Connecting…", "pending");
    try {
      // HostReconnect owns connect + hostJoin, stores the resumable session and
      // reports the recovery state used by the status line.
      await recovery.join(current);
    } catch {
      recovery.forget();
      // joinError / close handlers usually explain the failure already.
      phase = "failed";
      deps.chrome.setConnection("Host join failed", "bad");
      deps.hintEl.textContent = "Press Enter to start a new room.";
    }
  }

  /**
   * D4-HOST-02 boot: resume this tab's room before creating a new one. A
   * terminal token failure (expired/badHostToken) has already cleared the
   * stored session, so the shell starts fresh instead of retrying a dead room.
   */
  async function bootHost(): Promise<void> {
    const result = await recovery.resumeStored();
    if (result === "none") {
      await createRoom();
      return;
    }
    if (result === "terminal") {
      deps.hintEl.textContent = "The previous room ended. Starting a new room.";
      await createRoom();
      return;
    }

    const session = recovery.session;
    if (session === null) {
      await createRoom();
      return;
    }

    room = { code: session.code, hostToken: session.hostToken };
    phase = "ready";
    networkLost = result !== "resumed";
    deps.syncPause();
    // Only `{code, hostToken}` survives a reload, so there is no room token or
    // PIN for a fresh QR. Already-connected phones keep their 30 s reservation.
    deps.roomPanel.setResumedRoom(session.code);
    deps.roster.updateStageBar();
    if (result === "recovering") {
      deps.roomPanel.setHostStatus("reconnecting");
      deps.chrome.setConnection("Reconnecting…", "pending");
      deps.hintEl.textContent = "Waiting for the room connection to recover…";
      deps.chrome.showReconnectBanner(true);
    } else {
      deps.chrome.setConnection("Connected", "ok");
      deps.hintEl.textContent = "Room resumed.";
      deps.chrome.showReconnectBanner(false);
    }
    deps.maybeShowLauncher();
  }

  // -------------------------------------------------------------------------
  // Host socket (D0 shell, D3 input routing)
  // -------------------------------------------------------------------------

  deps.client.onClose((info) => {
    if (
      recovery.session !== null &&
      recovery.state !== "lost" &&
      phase === "ready"
    ) {
      // D4-HOST-02: the broker keeps the slots reserved for 30 s; retry with
      // 250 ms → 4 s backoff instead of dropping the room immediately.
      recovery.handleClose();
      networkLost = true;
      deps.syncPause();
      deps.roomPanel.setHostStatus("reconnecting");
      deps.chrome.setConnection("Reconnecting…", "pending");
      deps.hintEl.textContent = "Waiting for the room connection to recover…";
      deps.chrome.showReconnectBanner(true);
      return;
    }
    phase = "failed";
    networkLost = true;
    deps.syncPause();
    deps.roomPanel.setHostJoined(false);
    deps.chrome.showReconnectBanner(false);
    const code = info.code;
    deps.chrome.setConnection(
      code === undefined || code === 1000 ? "Disconnected" : `Disconnected (${code})`,
      "bad",
    );
    deps.hintEl.textContent = "Press Enter to start a new room.";
  });

  deps.client.onError(() => {
    if (recovery.state === "reconnecting") {
      return;
    }
    deps.chrome.setConnection("Connection error", "bad");
  });

  deps.client.onMessage((message: ServerToClientMessage) => {
    switch (message.t) {
      case "hostJoined":
        phase = "ready";
        networkLost = false;
        deps.syncPause();
        deps.roomPanel.setHostJoined(true);
        deps.chrome.setConnection("Connected", "ok");
        deps.hintEl.textContent = "";
        deps.chrome.showReconnectBanner(false);
        break;
      case "joinError":
        if (recovery.state === "reconnecting") {
          deps.hintEl.textContent = "Reconnecting to the room…";
        } else {
          phase = "failed";
          deps.chrome.setConnection(`Host join failed: ${message.reason}`, "bad");
          deps.hintEl.textContent = "Press Enter to start a new room.";
        }
        break;
      case "playerJoined":
        deps.layouts.handleJoined(message.slot);
        deps.panels.handleJoined(message.slot);
        deps.roster.setPlayerJoined(
          message.slot,
          slotRosterStateFor("joined"),
        );
        break;
      case "playerLeft":
        deps.mapper.reset(message.slot);
        deps.layouts.handleLeft(message.slot);
        deps.panels.handleLeft(message.slot);
        deps.roster.setPlayerLeft(message.slot, slotRosterStateFor("left"));
        break;
      case "playerSuspended":
        // The reserved slot keeps its layout; only live input is dropped.
        deps.mapper.reset(message.slot);
        deps.roster.setPlayerSuspended(
          message.slot,
          slotRosterStateFor("suspended"),
        );
        break;
      case "playerResumed":
        // Broker reservation returned: resend the host's layout and panel.
        deps.mapper.reset(message.slot);
        deps.roster.setPlayerResumed(
          message.slot,
          slotRosterStateFor("resumed"),
        );
        deps.layouts.handleResumed(message.slot);
        deps.panels.handleResumed(message.slot);
        break;
      case "event":
        deps.events.receive(message.slot, message.name, message.data);
        break;
      case "layoutAck":
        deps.layouts.handleAck(message.slot, message.layoutId);
        break;
      case "stats":
        serverStats = message.slots;
        break;
      case "kick":
        recovery.forget();
        clearRoomState();
        networkLost = true;
        phase = "failed";
        deps.syncPause();
        deps.roomPanel.setHostJoined(false);
        deps.chrome.setConnection(`Removed from the room: ${message.reason}`, "bad");
        deps.hintEl.textContent = "Press Enter to start a new room.";
        deps.chrome.showReconnectBanner(false);
        deps.resetRouteToLauncher();
        deps.notices.show({
          title: ROOM_ENDED_TITLE,
          message: `Removed from the room: ${message.reason}`,
          hints: ["Press Enter to start a new room."],
          actionLabel: CREATE_ROOM_LABEL,
          onAction: () => {
            deps.notices.clear();
            void createRoom();
          },
          tone: "error",
        });
        break;
      default:
        break;
    }
  });

  deps.client.onInput((slot, state) => {
    const receivedAt = performance.now();
    deps.mapper.apply(slot, state, receivedAt);
    deps.roster.setInput(slot, state, receivedAt);
  });

  return {
    createRoom,
    bootHost,
    getPhase: () => phase,
    isNetworkLost: () => networkLost,
    getRoomCode: () => room?.code ?? null,
    getServerStats: () => serverStats,
    pauseForVisibility: () => recovery.pauseForVisibility(),
    resumeForVisibility: () => recovery.resumeForVisibility(),
  };
}
