// @vitest-environment jsdom
// @req ER-25-04, FR-8.2
/**
 * Host launcher remote layout (spec 25 §2.7; streams E/G).
 *
 * Proves three seams without a browser or a socket:
 *
 * - the runtime-owned document is an exact mirror of the controller fixture
 *   (read here as a test-only fixture; no runtime -> controller import);
 * - the real `LayoutApi` sends/restores it around a game and never overrides
 *   a running game's layout;
 * - navigation reports "launcher shown" on `/`, including a failed launch.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostToServerMessage } from "@lanpad/protocol";
import { validateLayout, type LayoutDocument } from "@lanpad/sdk";
import { describe, expect, test, vi } from "vitest";
import { LayoutApi } from "../src/game/LayoutApi.js";
import {
  createLauncherLayoutSync,
  LAUNCHER_REMOTE_LAYOUT,
  LAUNCHER_REMOTE_LAYOUT_ID,
} from "../src/host/launcherLayout.js";
import { createNavigation, type NavigationDeps } from "../src/host/navigation.js";

/**
 * Test-only read of the controller-owned wire fixture (FR-10.2 stays). jsdom
 * reports `import.meta.url` as an http URL, so resolve from the test cwd.
 */
function controllerFixturePath(): string {
  const candidates = [
    join(process.cwd(), "packages/controller/layouts/launcher-remote-v1.json"),
    join(process.cwd(), "../controller/layouts/launcher-remote-v1.json"),
    join(process.cwd(), "../../controller/layouts/launcher-remote-v1.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("controller launcher layout fixture not found");
}

const CONTROLLER_FIXTURE = JSON.parse(
  readFileSync(controllerFixturePath(), "utf8"),
) as LayoutDocument;

const GAME_LAYOUT: LayoutDocument = {
  id: "probe-v1",
  orientation: "portrait",
  controls: [
    {
      type: "button",
      id: "jump",
      label: "Jump",
      shape: "circle",
      x: "50%",
      y: "80%",
      r: "10%",
      bit: 2,
    },
  ],
};

class RecordingSender {
  readonly sent: HostToServerMessage[] = [];

  send(message: HostToServerMessage): void {
    this.sent.push(message);
  }
}

interface LayoutFrame {
  readonly slot: number | "all";
  readonly id: string | undefined;
}

function layoutFrames(sender: RecordingSender): LayoutFrame[] {
  return sender.sent.flatMap((message) =>
    message.t === "setLayout"
      ? [
          {
            slot: message.slot,
            id: (message.layout as { id?: string }).id,
          },
        ]
      : [],
  );
}

function createSyncHarness() {
  const sender = new RecordingSender();
  const api = new LayoutApi({ sender });
  const gates = { roomReady: true, launcherShown: true, gameRunning: false };
  const sync = createLauncherLayoutSync({
    layouts: api,
    isRoomReady: () => gates.roomReady,
    isLauncherShown: () => gates.launcherShown,
    isGameRunning: () => gates.gameRunning,
  });
  return { sender, api, gates, sync };
}

describe("[ER-25-04] launcher remote layout document", () => {
  test("[FR-8.2][ER-25-04] the runtime document matches the controller fixture control for control", () => {
    expect(LAUNCHER_REMOTE_LAYOUT).toEqual(CONTROLLER_FIXTURE);
    expect(validateLayout(LAUNCHER_REMOTE_LAYOUT).ok).toBe(true);
    expect(validateLayout(CONTROLLER_FIXTURE).ok).toBe(true);

    const byId = new Map(
      LAUNCHER_REMOTE_LAYOUT.controls.map((control) => [control.id, control]),
    );
    expect(byId.get("status")?.type).toBe("panel");
    const nav = byId.get("nav");
    expect(nav?.type).toBe("dpad");
    if (nav?.type === "dpad") {
      expect(nav.bits).toEqual({ up: 8, down: 9, left: 10, right: 11 });
    }
    const back = byId.get("back");
    expect(back?.type === "button" ? [back.label, back.bit, back.haptic] : null).toEqual([
      "Back",
      1,
      [18],
    ]);
    const select = byId.get("select");
    expect(
      select?.type === "button" ? [select.label, select.bit, select.haptic] : null,
    ).toEqual(["Select", 0, [18]]);
  });
});

describe("[ER-25-04] launcher layout sync", () => {
  test("[ER-25-04] a ready room with the console home visible broadcasts launcher-remote-v1 once", () => {
    const first = createSyncHarness();
    first.gates.roomReady = false;
    first.sync.sync();
    expect(layoutFrames(first.sender)).toEqual([]);

    first.gates.roomReady = true;
    first.sync.sync();
    expect(layoutFrames(first.sender)).toEqual([
      { slot: "all", id: LAUNCHER_REMOTE_LAYOUT_ID },
    ]);

    // Connection events can call sync repeatedly; idempotence costs no frame.
    first.sync.sync();
    expect(layoutFrames(first.sender)).toHaveLength(1);

    // A hidden console (game route, teardown) never sends the launcher layout.
    const hidden = createSyncHarness();
    hidden.gates.launcherShown = false;
    hidden.sync.sync();
    expect(layoutFrames(hidden.sender)).toEqual([]);
  });

  test("[ER-25-04] a launch replaces the launcher layout and the guard never overrides it", () => {
    const h = createSyncHarness();
    h.sync.sync();

    h.gates.gameRunning = true;
    h.api.set("all", GAME_LAYOUT);
    // Room/recovery events still fire while the game runs (Engine Cube uses
    // the same stage and guard); none may replace the game's layout.
    h.sync.sync();
    h.sync.sync();

    expect(layoutFrames(h.sender)).toEqual([
      { slot: "all", id: LAUNCHER_REMOTE_LAYOUT_ID },
      { slot: "all", id: GAME_LAYOUT.id },
    ]);
    expect(h.api.current(1)?.id).toBe(GAME_LAYOUT.id);
  });

  test("[ER-25-04] returning to / restores the launcher layout after a game", () => {
    const h = createSyncHarness();
    h.sync.sync();
    h.gates.gameRunning = true;
    h.api.set("all", GAME_LAYOUT);

    h.gates.gameRunning = false;
    h.sync.sync();

    expect(layoutFrames(h.sender).map((frame) => frame.id)).toEqual([
      LAUNCHER_REMOTE_LAYOUT_ID,
      GAME_LAYOUT.id,
      LAUNCHER_REMOTE_LAYOUT_ID,
    ]);
  });

  test("[ER-25-04] late joins and host reconnect replay the launcher layout", () => {
    const h = createSyncHarness();
    h.sync.sync();

    // A phone joining after the broadcast missed the broker's stored copy;
    // LayoutApi.handleJoined fills the slot in.
    h.api.handleJoined(2);
    expect(layoutFrames(h.sender).at(-1)).toEqual({
      slot: 2,
      id: LAUNCHER_REMOTE_LAYOUT_ID,
    });

    // Host reconnect: room.ts calls resendAll for every occupied slot.
    h.api.resendAll();
    expect(layoutFrames(h.sender).at(-1)).toEqual({
      slot: 2,
      id: LAUNCHER_REMOTE_LAYOUT_ID,
    });

    // Room loss clears host state; the ready transition broadcasts again.
    h.api.clearAll();
    h.gates.roomReady = false;
    h.sync.sync();
    h.gates.roomReady = true;
    h.sync.sync();
    expect(
      layoutFrames(h.sender).filter(
        (frame) => frame.slot === "all" && frame.id === LAUNCHER_REMOTE_LAYOUT_ID,
      ),
    ).toHaveLength(2);
  });
});

describe("[ER-25-04] navigation reports the console home", () => {
  function createNavigationHarness(options: { stageActive: boolean }) {
    window.history.replaceState({}, "", "/games/probe/");
    const calls = {
      returnToLauncher: [] as (string | null | undefined)[],
      onLauncherShown: 0,
      teardown: 0,
      cleared: 0,
    };
    const notices = { clear: vi.fn() } as unknown as NavigationDeps["notices"];
    const launcher = {
      beginLaunch: vi.fn(),
      returnToLauncher: (slug?: string | null) => {
        calls.returnToLauncher.push(slug);
      },
    } as unknown as NavigationDeps["launcher"];
    const stage = {
      getCurrentSlug: () => "probe",
      isStageActive: () => options.stageActive,
      teardownGame: () => {
        calls.teardown += 1;
      },
      clearCurrentSlug: () => {
        calls.cleared += 1;
      },
      openGame: async () => {},
      unlockAudio: async () => {},
    } as unknown as NavigationDeps["stage"];
    const modals = { closeAll: vi.fn() } as unknown as NavigationDeps["modals"];
    const navigation = createNavigation({
      window,
      doc: document,
      notices,
      launcher,
      stage,
      modals,
      onLauncherShown: () => {
        calls.onLauncherShown += 1;
      },
    });
    return { navigation, calls };
  }

  test("[ER-25-04] returnToLauncher goes to / and reports the launcher shown", () => {
    const h = createNavigationHarness({ stageActive: true });
    h.navigation.returnToLauncher();

    expect(window.location.pathname).toBe("/");
    expect(h.calls.teardown).toBe(1);
    expect(h.calls.cleared).toBe(1);
    expect(h.calls.returnToLauncher).toEqual(["probe"]);
    expect(h.calls.onLauncherShown).toBe(1);
  });

  test("[ER-25-04] a failed launch returns home and reports the launcher shown", async () => {
    const h = createNavigationHarness({ stageActive: false });
    h.navigation.navigateToGame("probe");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.pathname).toBe("/");
    expect(h.calls.onLauncherShown).toBe(1);
  });

  test("[ER-25-04] a successful launch does not report the launcher shown", async () => {
    const h = createNavigationHarness({ stageActive: true });
    h.navigation.navigateToGame("probe");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.calls.onLauncherShown).toBe(0);
  });
});
