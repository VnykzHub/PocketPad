/**
 * Host-side launcher remote layout (spec 25 §2.7; D4/E contract).
 *
 * While the console home is shown, phones must render the launcher d-pad,
 * Select and Back instead of a game layout. The controller package owns the
 * wire fixture (`packages/controller/layouts/launcher-remote-v1.json`); the
 * host cannot import controller code (FR-10.2), so this module carries the
 * runtime-owned copy. `launcherRemoteLayout.test.ts` reads the controller JSON
 * as a test-only fixture and fails if the two documents drift.
 *
 * Bits are frozen: Select = 0, Back = 1, d-pad = 8..11. The controller turns
 * those bit edges into `{t:"event", name:"remote"}` frames, which `room.ts`
 * forwards to the console shell.
 */
import { MAX_CONTROLLERS } from "@lanpad/protocol";
import type { LayoutDocument } from "@lanpad/sdk";

/** Stable layout id; the launcher can hot-swap by this id. */
export const LAUNCHER_REMOTE_LAYOUT_ID = "launcher-remote-v1";

/** Exact mirror of the controller's committed launcher layout fixture. */
export const LAUNCHER_REMOTE_LAYOUT: LayoutDocument = {
  schemaVersion: 1,
  id: LAUNCHER_REMOTE_LAYOUT_ID,
  orientation: "any",
  background: "#000000",
  controls: [
    {
      type: "panel",
      id: "status",
      x: "50%",
      y: "10%",
      w: "88%",
      h: "12%",
      z: 10,
    },
    {
      type: "dpad",
      id: "nav",
      x: "24%",
      y: "66%",
      size: "34%",
      bits: { up: 8, down: 9, left: 10, right: 11 },
    },
    {
      type: "button",
      id: "back",
      label: "Back",
      shape: "circle",
      x: "78%",
      y: "40%",
      r: "9%",
      bit: 1,
      haptic: [18],
    },
    {
      type: "button",
      id: "select",
      label: "Select",
      shape: "circle",
      x: "78%",
      y: "72%",
      r: "12%",
      bit: 0,
      haptic: [18],
    },
  ],
};

/** The subset of `LayoutApi` the launcher needs. */
export interface LauncherLayoutSender {
  set(target: "all", layout: LayoutDocument): void;
  current(slot: number): LayoutDocument | null;
}

export interface LauncherLayoutSyncDeps {
  readonly layouts: LauncherLayoutSender;
  /** Host socket is joined and ready for control frames. */
  readonly isRoomReady: () => boolean;
  /** Console home (start gate or home phase) is on screen. */
  readonly isLauncherShown: () => boolean;
  /** A game owns the phones; never replace its layout. */
  readonly isGameRunning: () => boolean;
}

export interface LauncherLayoutSync {
  /** Broadcasts `launcher-remote-v1` when the gates allow; idempotent. */
  sync(): void;
}

/**
 * Sends the launcher layout to every phone whenever the console home becomes
 * visible: first room-ready transition, return from a game, and host/room
 * recovery. `LayoutApi.set` keeps repeated calls with the same id a no-op, so
 * connection-event spam costs no frames.
 *
 * A send failure means the socket closed between the gate and the call. Room
 * recovery re-runs `sync`, so the failure is recorded rather than thrown into
 * the broker message dispatch.
 */
export function createLauncherLayoutSync(
  deps: LauncherLayoutSyncDeps,
): LauncherLayoutSync {
  /**
   * True when every slot's stored layout is already the launcher document.
   * `LayoutApi.set` only treats a repeated id as a no-op for occupied or
   * ack-pending slots, so an empty room would otherwise rebroadcast on every
   * connection event. Reading the stored documents also notices a game layout
   * that replaced ours, which is exactly when the return-to-`/` sync must act.
   */
  function launcherLayoutIsCurrent(): boolean {
    for (let slot = 1; slot <= MAX_CONTROLLERS; slot += 1) {
      if (deps.layouts.current(slot)?.id !== LAUNCHER_REMOTE_LAYOUT_ID) {
        return false;
      }
    }
    return true;
  }

  return {
    sync(): void {
      if (!deps.isRoomReady() || !deps.isLauncherShown() || deps.isGameRunning()) {
        return;
      }
      if (launcherLayoutIsCurrent()) {
        return;
      }
      try {
        deps.layouts.set("all", LAUNCHER_REMOTE_LAYOUT);
      } catch {
        // Closing sockets surface as a throw from HostClient.send; the next
        // room-ready transition retries with the same document.
      }
    },
  };
}
