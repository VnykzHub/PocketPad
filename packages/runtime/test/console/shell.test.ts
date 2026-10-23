import { describe, expect, test } from "vitest";
import type { AssetProgress } from "../../src/assets/AssetLoader.js";
import {
  GAMEPAD_BUTTONS,
  type GamepadLike,
} from "../../src/ui/console/input.js";
import { HINT_GAMEPAD, HINT_REMOTE } from "../../src/ui/console/hintBar.js";
import { presentationAccent } from "../../src/ui/console/presentation.js";
import { ConsoleShell } from "../../src/ui/console/shell.js";
import type { ConsoleGame } from "../../src/ui/console/types.js";
import {
  asDocument,
  asElement,
  FakeDocument,
  FakeElement,
  totalListeners,
} from "./fakeDom.js";

function fake(value: unknown): FakeElement {
  return value as FakeElement;
}

function game(
  slug: string,
  name: string,
  overrides: Partial<ConsoleGame> = {},
): ConsoleGame {
  return { slug, name, minPlayers: 1, maxPlayers: 4, ...overrides };
}

const GAMES: readonly ConsoleGame[] = [
  game("party", "Party", {
    minPlayers: 2,
    maxPlayers: 8,
    presentation: { tagline: "Couch chaos", featured: true },
  }),
  game("arena", "Arena", {
    minPlayers: 2,
    maxPlayers: 4,
    presentation: {
      tagline: "Last one standing",
      accent: "#ff9f45",
      inputBadges: ["stick", "buttons"],
    },
  }),
  game("solo", "Solo", { minPlayers: 1, maxPlayers: 1 }),
];

function pad(
  options: {
    readonly buttons?: readonly number[];
    readonly axes?: readonly [number, number];
  } = {},
): GamepadLike {
  const pressed = new Set(options.buttons ?? []);
  const buttons = Array.from({ length: 16 }, (_, index) => ({
    pressed: pressed.has(index),
  }));
  return { axes: options.axes ?? [0, 0], buttons };
}

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
  readonly shell: ConsoleShell;
  readonly launches: string[];
  readonly cancelSlugs: string[];
  readonly scheduled: Array<() => void>;
  cancelCalls(): number;
  unlocks(): number;
  setNow(date: Date): void;
}

function setup(
  options: {
    readonly start?: "gate" | "home";
    readonly reduced?: boolean;
    readonly games?: readonly ConsoleGame[];
    readonly gamepads?: () => ReadonlyArray<GamepadLike | null | undefined>;
  } = {},
): Harness {
  const doc = new FakeDocument();
  const launches: string[] = [];
  const cancelSlugs: string[] = [];
  const scheduled: Array<() => void> = [];
  let cancelCalls = 0;
  let unlocks = 0;
  let now = new Date(2026, 0, 2, 9, 5);

  const shell = new ConsoleShell(asDocument(doc), {
    games: options.games ?? GAMES,
    onLaunch: (entry) => launches.push(entry.slug),
    onCancelLaunch: (entry) => cancelSlugs.push(entry.slug),
    unlockAudio: () => {
      unlocks += 1;
      return Promise.resolve();
    },
    skipStartGate: options.start === "home",
    ...(options.reduced === true ? { prefersReducedMotion: true } : {}),
    now: () => now,
    scheduleClock: (tick) => {
      scheduled.push(tick);
      return scheduled.length;
    },
    cancelClock: () => {
      cancelCalls += 1;
    },
    ...(options.gamepads !== undefined ? { gamepads: options.gamepads } : {}),
  });

  const root = new FakeElement("div");
  doc.body.append(root);
  shell.mount(asElement(root));

  return {
    doc,
    shell,
    launches,
    cancelSlugs,
    scheduled,
    cancelCalls: () => cancelCalls,
    unlocks: () => unlocks,
    setNow: (date) => {
      now = date;
    },
  };
}

function clockText(harness: Harness): string {
  return fake(harness.shell.topBar.clockEl).textContent;
}

describe("console shell", () => {
  test("[ER-25-04] the start gate owns the first gesture, then the home screen is live", async () => {
    const harness = setup();
    expect(harness.shell.phase).toBe("start");
    expect(harness.shell.startGate).not.toBeNull();
    expect(fake(harness.shell.frame).hidden).toBe(true);
    expect(harness.scheduled).toHaveLength(1);
    expect(clockText(harness)).toBe("09:05");
    expect(harness.doc.defaultView.listenerCount("keydown")).toBe(1);

    await harness.shell.start("keyboard");
    expect(harness.shell.phase).toBe("home");
    expect(fake(harness.shell.frame).hidden).toBe(false);
    expect(harness.unlocks()).toBe(1);
    expect(harness.doc.defaultView.listenerCount("keydown")).toBe(1);

    harness.setNow(new Date(2026, 0, 2, 10, 7));
    harness.scheduled[0]?.();
    expect(clockText(harness)).toBe("10:07");
  });

  test("[ER-25-04] keyboard arrows move focus with wrap; Home and End jump", () => {
    const harness = setup({ start: "home" });
    harness.shell.focus();
    expect(harness.shell.row.focusedIndex).toBe(0);

    const send = (key: string): void => {
      harness.doc.defaultView.dispatch("keydown", { key });
    };

    send("ArrowRight");
    expect(harness.shell.row.focusedIndex).toBe(1);
    send("ArrowRight");
    expect(harness.shell.row.focusedIndex).toBe(2);
    send("ArrowRight");
    expect(harness.shell.row.focusedIndex).toBe(0);
    send("ArrowLeft");
    expect(harness.shell.row.focusedIndex).toBe(2);
    send("Home");
    expect(harness.shell.row.focusedIndex).toBe(0);
    send("End");
    expect(harness.shell.row.focusedIndex).toBe(2);
  });

  test("[ER-25-04] Enter and Space launch the focused tile; native buttons keep their key", () => {
    const harness = setup({ start: "home" });
    harness.shell.row.focusSlug("arena");

    const nativeButton = harness.doc.defaultView.dispatch("keydown", {
      key: "Enter",
      target: fake(harness.shell.topBar.qrToggle),
    });
    expect(nativeButton.defaultPrevented).toBe(false);
    expect(harness.launches).toEqual([]);

    const enter = harness.doc.defaultView.dispatch("keydown", { key: "Enter" });
    expect(enter.defaultPrevented).toBe(true);
    expect(harness.launches).toEqual(["arena"]);
    expect(harness.shell.phase).toBe("loading");
    expect(fake(harness.shell.loading.element).hidden).toBe(false);
    expect(fake(harness.shell.loading.titleEl).textContent).toBe("Arena");
    expect(fake(harness.shell.loading.titleEl).focused).toBe(true);
    expect(fake(harness.shell.backdrop.element).dataset["paused"]).toBe("true");

    harness.shell.returnFromGame();
    harness.shell.row.focusSlug("solo");
    const space = harness.doc.defaultView.dispatch("keydown", { key: " " });
    expect(space.defaultPrevented).toBe(true);
    expect(harness.launches).toEqual(["arena", "solo"]);
  });

  test("[ER-25-04] back closes the QR at home and cancels a launch with focus restored", () => {
    const home = setup({ start: "home" });
    home.shell.topBar.setQrOpen(true);
    home.doc.defaultView.dispatch("keydown", { key: "Escape" });
    expect(home.shell.topBar.isQrOpen).toBe(false);
    expect(home.shell.phase).toBe("home");
    expect(home.launches).toEqual([]);

    const launch = setup({ start: "home" });
    launch.shell.row.focusSlug("party");
    launch.shell.row.activateActive();
    expect(launch.shell.phase).toBe("loading");

    const escape = launch.doc.defaultView.dispatch("keydown", {
      key: "Escape",
    });
    expect(escape.defaultPrevented).toBe(true);
    expect(launch.cancelSlugs).toEqual(["party"]);
    expect(launch.shell.phase).toBe("home");
    expect(fake(launch.shell.loading.element).hidden).toBe(true);
    expect(fake(launch.shell.backdrop.element).dataset["paused"]).toBe("false");
    expect(launch.shell.row.focusedGame?.slug).toBe("party");
  });

  test("[ER-25-04] gamepads drive the same focus and launch path", () => {
    let pads: Array<GamepadLike | null> = [pad()];
    const harness = setup({ start: "home", gamepads: () => pads });

    pads = [pad({ buttons: [GAMEPAD_BUTTONS.confirm] })];
    expect(harness.shell.pollGamepad()).toEqual(["confirm"]);
    expect(harness.launches).toEqual(["party"]);
    expect(harness.shell.hints.inputMode).toBe("gamepad");
    expect(fake(harness.shell.hints.textEl).textContent).toBe(HINT_GAMEPAD);

    harness.shell.returnFromGame();
    pads = [pad()];
    expect(harness.shell.pollGamepad()).toEqual([]);
    pads = [pad({ buttons: [GAMEPAD_BUTTONS.right] })];
    expect(harness.shell.pollGamepad()).toEqual(["next"]);
    expect(harness.shell.row.focusedIndex).toBe(1);
  });

  test("[ER-25-04] phone remotes drive the same focus and launch path", () => {
    const harness = setup({ start: "home" });
    expect(harness.shell.handleRemote("down")).toBe(true);
    expect(harness.shell.row.focusedIndex).toBe(1);
    expect(harness.shell.hints.inputMode).toBe("remote");
    expect(fake(harness.shell.hints.textEl).textContent).toBe(HINT_REMOTE);

    expect(harness.shell.handleRemote("ok")).toBe(true);
    expect(harness.launches).toEqual(["arena"]);
    harness.shell.returnFromGame();
    expect(harness.shell.handleRemote("volume-up")).toBe(false);
  });

  test("[ER-25-05] the reduced tier passes the same sequence and ignores pointer parallax", () => {
    function run(reduced: boolean): {
      readonly launches: string[];
      readonly focus: number[];
      readonly phase: string;
      readonly motion: string;
    } {
      const harness = setup({ start: "home", reduced });
      harness.shell.focus();
      const focus: number[] = [harness.shell.row.focusedIndex];
      harness.doc.defaultView.dispatch("keydown", { key: "ArrowRight" });
      focus.push(harness.shell.row.focusedIndex);
      harness.doc.defaultView.dispatch("keydown", { key: "Enter" });
      harness.shell.returnFromGame();
      harness.doc.defaultView.dispatch("keydown", { key: "End" });
      focus.push(harness.shell.row.focusedIndex);
      harness.doc.defaultView.dispatch("keydown", { key: " " });
      harness.shell.returnFromGame();
      return {
        launches: harness.launches,
        focus,
        phase: harness.shell.phase,
        motion: fake(harness.shell.element).dataset["motion"] ?? "",
      };
    }

    const full = run(false);
    const reduced = run(true);
    expect(reduced.launches).toEqual(full.launches);
    expect(reduced.focus).toEqual(full.focus);
    expect(reduced.phase).toBe("home");
    expect(full.motion).toBe("full");
    expect(reduced.motion).toBe("reduced");

    const still = setup({ start: "home", reduced: true });
    fake(still.shell.row.element).rect = {
      left: 0,
      top: 0,
      width: 100,
      height: 100,
    };
    fake(still.shell.row.element).dispatch("pointermove", {
      clientX: 100,
      clientY: 50,
    });
    expect(still.shell.row.parallax).toEqual({ x: 0, y: 0 });

    const moving = setup({ start: "home" });
    fake(moving.shell.row.element).rect = {
      left: 0,
      top: 0,
      width: 100,
      height: 100,
    };
    fake(moving.shell.row.element).dispatch("pointermove", {
      clientX: 100,
      clientY: 50,
    });
    expect(moving.shell.row.parallax).toEqual({ x: 8, y: 0 });
  });

  test("[ER-25-07] the backdrop follows focus and is paused, then resumed, around a launch", () => {
    const harness = setup({ start: "home" });
    const first = harness.shell.row.gameList[0];
    if (first === undefined) throw new Error("missing first game");
    expect(harness.shell.backdrop.theme?.accent).toBe(
      presentationAccent(first),
    );

    harness.shell.row.focusSlug("arena");
    expect(harness.shell.backdrop.theme?.accent).toBe("#ff9f45");
    expect(fake(harness.shell.backdrop.element).dataset["accent"]).toBe(
      "#ff9f45",
    );
    expect(
      harness.shell.backdrop.layers.filter(
        (layer) => fake(layer).dataset["visible"] === "true",
      ),
    ).toHaveLength(1);

    harness.shell.row.activateActive();
    expect(harness.shell.backdrop.paused).toBe(true);
    harness.shell.backdrop.show({
      accent: "#00ff00",
      gradient: "linear-gradient(#000000, #000000)",
    });
    expect(harness.shell.backdrop.theme?.accent).toBe("#00ff00");
    expect(fake(harness.shell.backdrop.element).dataset["accent"]).toBe(
      "#ff9f45",
    );

    harness.shell.backdrop.resume();
    expect(harness.shell.backdrop.paused).toBe(false);
    expect(fake(harness.shell.backdrop.element).dataset["accent"]).toBe(
      "#00ff00",
    );

    harness.shell.returnFromGame();
    expect(harness.shell.backdrop.paused).toBe(false);
    expect(harness.shell.backdrop.theme?.accent).toBe("#ff9f45");
  });

  test("[ER-25-04] the loading screen forwards real byte progress", () => {
    const harness = setup({ start: "home" });
    harness.shell.row.focusSlug("arena");
    harness.shell.row.activateActive();

    harness.shell.setLoadingProgress(
      progress({
        loadedBytes: 1536,
        totalBytes: 4096,
        determinate: true,
        fraction: 0.375,
        loadedCount: 1,
        totalCount: 3,
        currentUrl: "/assets/a.png",
      }),
    );
    expect(
      fake(harness.shell.loading.bar).getAttribute("aria-valuenow"),
    ).toBe("38");
    expect(fake(harness.shell.loading.percentEl).textContent).toBe("38%");
    expect(fake(harness.shell.loading.bytesEl).textContent).toBe(
      "1.5 KB of 4 KB",
    );
    expect(
      fake(harness.shell.loading.fill).style.getPropertyValue("transform"),
    ).toBe("scaleX(0.375)");

    harness.shell.setLoadingProgress(
      progress({ loadedBytes: 512, determinate: false, fraction: null }),
    );
    expect(fake(harness.shell.loading.element).dataset["determinate"]).toBe(
      "false",
    );
    expect(
      fake(harness.shell.loading.bar).getAttribute("aria-valuenow"),
    ).toBeNull();
    expect(fake(harness.shell.loading.percentEl).textContent).toBe("");
    expect(fake(harness.shell.loading.bytesEl).textContent).toBe(
      "512 B fetched",
    );

    harness.shell.returnFromGame();
    harness.shell.setLoadingProgress(progress({ fraction: 1 }));
    expect(fake(harness.shell.loading.percentEl).textContent).toBe("");
  });

  test("[ER-25-06] 20 launch/return cycles leak no listener, timer, audio node or GPU", async () => {
    const harness = setup({ start: "gate" });
    await harness.shell.start("keyboard");

    const windowListeners = harness.doc.defaultView.listenerCount();
    const treeListeners = totalListeners(fake(harness.shell.element));

    for (let cycle = 0; cycle < 20; cycle += 1) {
      const slug = cycle % 2 === 0 ? "arena" : "solo";
      harness.shell.row.focusSlug(slug);
      harness.shell.row.activateActive();
      expect(harness.shell.phase).toBe("loading");
      expect(harness.shell.backdrop.paused).toBe(true);

      harness.shell.returnFromGame();
      expect(harness.shell.phase).toBe("home");
      expect(harness.shell.row.focusedGame?.slug).toBe(slug);
      expect(fake(harness.shell.loading.element).hidden).toBe(true);
    }

    expect(harness.launches).toHaveLength(20);
    expect(harness.unlocks()).toBe(1);
    expect(harness.scheduled).toHaveLength(1);
    expect(harness.cancelCalls()).toBe(0);
    expect(harness.doc.defaultView.listenerCount()).toBe(windowListeners);
    expect(totalListeners(fake(harness.shell.element))).toBe(treeListeners);
    expect(harness.doc.defaultView.gpuReads).toBe(0);

    harness.shell.destroy();
    expect(harness.cancelCalls()).toBe(1);
    expect(harness.doc.defaultView.listenerCount()).toBe(0);
    expect(totalListeners(fake(harness.shell.element))).toBe(0);
  });
});
