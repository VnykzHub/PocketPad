import { describe, expect, test } from "vitest";
import type { GamePresentation } from "@lanpad/sdk";
import type { AssetProgress } from "../../src/assets/AssetLoader.js";
import {
  consoleGameFromEntry,
  createLauncher,
  isDebugSearch,
  type HostLauncher,
} from "../../src/host/launcher.js";
import type { GameEntry } from "../../src/game/registry.js";
import type {
  ConsoleConnection,
  ConsolePlayerInput,
} from "../../src/ui/console/types.js";
import {
  asDocument,
  asElement,
  FakeDocument,
  FakeElement,
  findAllByClass,
  textOf,
} from "./fakeDom.js";

function fake(value: unknown): FakeElement {
  return value as FakeElement;
}

function entry(
  slug: string,
  name: string,
  overrides: Partial<GameEntry> = {},
): GameEntry {
  return {
    slug,
    name,
    description: "",
    minPlayers: 1,
    maxPlayers: 4,
    needsGyro: false,
    manifestUrl: `/games/${slug}/game.manifest.json`,
    ...overrides,
  };
}

const GAMES: readonly GameEntry[] = [
  entry("party", "Party", { minPlayers: 2, maxPlayers: 8 }),
  entry("arena", "Arena"),
  entry("solo", "Solo"),
  entry("engine-cube", "Engine Cube"),
];

function progress(overrides: Partial<AssetProgress> = {}): AssetProgress {
  return {
    loadedBytes: 0,
    totalBytes: 0,
    determinate: false,
    fraction: null,
    loadedCount: 0,
    totalCount: 0,
    currentUrl: null,
    done: false,
    ...overrides,
  };
}

interface Harness {
  readonly doc: FakeDocument;
  readonly root: FakeElement;
  readonly launcher: HostLauncher;
  readonly launched: string[];
  scheduled(): number;
  cancelled(): number;
  unlocks(): number;
  setReady(value: boolean): void;
  setPath(value: string): void;
  setConnected(value: number): void;
}

interface SetupOptions {
  readonly games?: readonly GameEntry[];
  readonly debug?: boolean;
  readonly ready?: boolean;
  readonly path?: string;
  readonly connected?: number;
  readonly destroyOnLaunch?: boolean;
  readonly players?: () => readonly ConsolePlayerInput[] | undefined;
  readonly connection?: () => ConsoleConnection | undefined;
  readonly roomCode?: () => string | null;
  readonly roomPin?: () => string | null;
  readonly joinUrl?: () => string | null;
}

function setup(options: SetupOptions = {}): Harness {
  const doc = new FakeDocument();
  const root = new FakeElement("div");
  doc.body.append(root);
  const launched: string[] = [];
  let ready = options.ready ?? true;
  let path = options.path ?? "/";
  let connected = options.connected ?? 0;
  let scheduled = 0;
  let cancelled = 0;
  let unlocks = 0;

  const state: { launcher: HostLauncher | null } = { launcher: null };
  const launcher = createLauncher({
    doc: asDocument(doc),
    gameRoot: asElement(root),
    games: options.games ?? GAMES,
    connectedCount: () => connected,
    isRoomReady: () => ready,
    getPathname: () => path,
    onLaunch: (slug) => {
      launched.push(slug);
      if (options.destroyOnLaunch !== false) state.launcher?.destroy();
    },
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
    unlockAudio: () => {
      unlocks += 1;
      return Promise.resolve();
    },
    now: () => new Date(2026, 0, 2, 9, 5),
    scheduleClock: () => {
      scheduled += 1;
      return scheduled;
    },
    cancelClock: () => {
      cancelled += 1;
    },
    ...(options.players !== undefined ? { players: options.players } : {}),
    ...(options.connection !== undefined
      ? { connection: options.connection }
      : {}),
    ...(options.roomCode !== undefined ? { roomCode: options.roomCode } : {}),
    ...(options.roomPin !== undefined ? { roomPin: options.roomPin } : {}),
    ...(options.joinUrl !== undefined ? { joinUrl: options.joinUrl } : {}),
  });
  state.launcher = launcher;

  return {
    doc,
    root,
    launcher,
    launched,
    scheduled: () => scheduled,
    cancelled: () => cancelled,
    unlocks: () => unlocks,
    setReady: (value) => {
      ready = value;
    },
    setPath: (value) => {
      path = value;
    },
    setConnected: (value) => {
      connected = value;
    },
  };
}

function shellOf(harness: Harness): NonNullable<HostLauncher["shell"]> {
  const shell = harness.launcher.shell;
  if (shell === null) throw new Error("expected a mounted console shell");
  return shell;
}

describe("console host launcher", () => {
  test("[ER-25-09] ?debug=1 is matched exactly, never as a prefix", () => {
    expect(isDebugSearch("?debug=1")).toBe(true);
    expect(isDebugSearch("?debug=1&x=2")).toBe(true);
    expect(isDebugSearch("?x=2&debug=1")).toBe(true);
    expect(isDebugSearch("?debug=10")).toBe(false);
    expect(isDebugSearch("?xdebug=1")).toBe(false);
    expect(isDebugSearch("?debug=true")).toBe(false);
    expect(isDebugSearch("")).toBe(false);
  });

  test("[ER-25-03] registry entries become console games with no per-game code", () => {
    const presentation: GamePresentation = { tagline: "Hit" };
    const mapped = consoleGameFromEntry(
      entry("arena", "Arena", { description: "Hit things" }),
      (slug) => (slug === "arena" ? presentation : undefined),
    );
    expect(mapped).toEqual({
      slug: "arena",
      name: "Arena",
      description: "Hit things",
      minPlayers: 1,
      maxPlayers: 4,
      presentation,
    });

    const bare = consoleGameFromEntry(entry("solo", "Solo"));
    expect("presentation" in bare).toBe(false);
    expect("description" in bare).toBe(false);
    expect("debugOnly" in bare).toBe(false);

    expect(
      consoleGameFromEntry(entry("engine-cube", "Engine Cube")),
    ).toMatchObject({ slug: "engine-cube", debugOnly: true });
  });

  test("[ER-25-06] the launcher waits for a live room and the launcher route", () => {
    const harness = setup({ ready: false, path: "/" });
    harness.launcher.maybeShow();
    expect(harness.launcher.shell).toBeNull();

    harness.setReady(true);
    harness.setPath("/games/party/");
    harness.launcher.maybeShow();
    expect(harness.launcher.shell).toBeNull();

    harness.setPath("/");
    harness.launcher.maybeShow();
    const shell = shellOf(harness);
    expect(shell.phase).toBe("start");
    expect(harness.scheduled()).toBe(1);
    expect(harness.unlocks()).toBe(0);
  });

  test("[ER-25-06] a returned launcher skips the gate and restores the launched tile", async () => {
    const harness = setup({ games: GAMES.slice(0, 3) });
    harness.launcher.maybeShow();
    const first = shellOf(harness);
    expect(first.phase).toBe("start");

    await first.start("keyboard");
    first.row.focusSlug("arena");
    first.row.activateActive();
    expect(harness.launched).toEqual(["arena"]);
    expect(harness.launcher.shell).toBeNull();
    expect(harness.cancelled()).toBe(1);

    harness.launcher.maybeShow();
    const second = shellOf(harness);
    expect(second).not.toBe(first);
    expect(second.phase).toBe("home");
    expect(second.startGate).toBeNull();
    expect(second.row.focusedGame?.slug).toBe("arena");
    expect(harness.unlocks()).toBe(1);
  });

  test("[ER-25-04] beginLaunch, byte progress and returnToLauncher restore focus", async () => {
    const harness = setup({ destroyOnLaunch: false });
    harness.launcher.maybeShow();
    await shellOf(harness).start("keyboard");
    shellOf(harness).row.focusSlug("solo");

    harness.launcher.beginLaunch();
    expect(harness.launched).toEqual(["solo"]);
    expect(shellOf(harness).phase).toBe("loading");

    harness.launcher.setLoadingProgress(
      progress({
        loadedBytes: 2048,
        totalBytes: 4096,
        determinate: true,
        fraction: 0.5,
      }),
    );
    expect(fake(shellOf(harness).loading.percentEl).textContent).toBe("50%");

    harness.launcher.returnToLauncher();
    expect(shellOf(harness).phase).toBe("home");
    expect(shellOf(harness).row.focusedGame?.slug).toBe("solo");
    expect(fake(shellOf(harness).loading.element).hidden).toBe(true);

    harness.launcher.beginLaunch();
    harness.launcher.returnToLauncher("arena");
    expect(harness.launched).toEqual(["solo", "solo"]);
    expect(shellOf(harness).row.focusedGame?.slug).toBe("arena");
  });

  test("[ER-25-03] syncCounts and update* mirror host data without a rebuild", () => {
    const harness = setup({
      destroyOnLaunch: false,
      connected: 3,
      roomCode: () => "ABCD",
      roomPin: () => "4321",
      joinUrl: () => "http://host/c/ABCD#token",
    });
    harness.launcher.maybeShow();
    const shell = shellOf(harness);
    expect(shell.topBar.codeEl.textContent).toBe("ABCD");
    expect(shell.topBar.pinEl.textContent).toBe("PIN 4321");
    expect(shell.lobby.connectedCount).toBe(3);
    expect(
      findAllByClass(fake(shell.topBar.chipsEl), "console-chip"),
    ).toHaveLength(3);
    expect(textOf(fake(shell.topBar.chipsEl), "console-chip__label")).toBe("P1");

    harness.setConnected(1);
    harness.launcher.syncCounts();
    expect(
      findAllByClass(fake(shell.topBar.chipsEl), "console-chip"),
    ).toHaveLength(1);
    expect(shell.lobby.connectedCount).toBe(1);

    harness.setConnected(0);
    harness.launcher.syncCounts();
    expect(
      findAllByClass(fake(shell.topBar.chipsEl), "console-chip"),
    ).toHaveLength(0);
    expect(fake(shell.lobby.list).hidden).toBe(true);
    expect(fake(shell.lobby.emptyState).hidden).toBe(false);

    harness.launcher.updatePlayers([
      { slot: 4, label: "Rex", color: "#123456", state: "connected" },
    ]);
    expect(shell.lobby.connectedCount).toBe(1);
    expect(textOf(fake(shell.topBar.chipsEl), "console-chip__label")).toBe(
      "Rex",
    );

    harness.launcher.updateConnection({ text: "Reconnecting", tone: "pending" });
    expect(textOf(fake(shell.topBar.element), "console-status__text")).toBe(
      "Reconnecting",
    );
    expect(fake(shell.topBar.connectionEl).dataset["tone"]).toBe("pending");

    harness.launcher.updateRoom({ code: "ZZZZ", pin: "9999" });
    expect(shell.topBar.codeEl.textContent).toBe("ZZZZ");
    expect(shell.topBar.pinEl.textContent).toBe("PIN 9999");
  });

  test("[ER-25-09] Engine Cube is hidden unless ?debug=1, and an explicit flag wins", () => {
    const games = [entry("party", "Party"), entry("engine-cube", "Engine Cube")];

    const normal = setup({ games });
    normal.launcher.maybeShow();
    expect(shellOf(normal).row.gameList.map((game) => game.slug)).toEqual([
      "party",
    ]);

    normal.launcher.destroy();
    normal.doc.defaultView.location.search = "?debug=1";
    normal.launcher.maybeShow();
    expect(shellOf(normal).row.gameList.map((game) => game.slug)).toEqual([
      "engine-cube",
      "party",
    ]);

    const forcedOff = setup({ games, debug: false });
    forcedOff.doc.defaultView.location.search = "?debug=1";
    forcedOff.launcher.maybeShow();
    expect(shellOf(forcedOff).row.gameList.map((game) => game.slug)).toEqual([
      "party",
    ]);
  });

  test("[ER-25-06] 20 host destroy/recreate cycles leak no listener, timer, audio or GPU", async () => {
    const harness = setup({ games: GAMES.slice(0, 3) });
    harness.launcher.maybeShow();
    await shellOf(harness).start("keyboard");
    const windowListeners = harness.doc.defaultView.listenerCount("keydown");

    for (let cycle = 0; cycle < 20; cycle += 1) {
      const slug = cycle % 2 === 0 ? "arena" : "solo";
      const shell = shellOf(harness);
      shell.row.focusSlug(slug);
      shell.row.activateActive();
      expect(harness.launcher.shell).toBeNull();

      harness.launcher.maybeShow();
      const next = shellOf(harness);
      expect(fake(next.element).dataset["phase"]).toBe("home");
      expect(next.row.focusedGame?.slug).toBe(slug);
      expect(harness.doc.defaultView.listenerCount("keydown")).toBe(
        windowListeners,
      );
    }

    expect(harness.launched).toHaveLength(20);
    expect(harness.unlocks()).toBe(1);
    expect(harness.scheduled()).toBe(21);
    expect(harness.cancelled()).toBe(20);
    expect(harness.doc.defaultView.gpuReads).toBe(0);

    harness.launcher.destroy();
    expect(harness.cancelled()).toBe(21);
    expect(harness.doc.defaultView.listenerCount("keydown")).toBe(0);
  });
});
