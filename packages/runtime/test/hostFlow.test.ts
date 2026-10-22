/**
 * W2 host flow (HP-03/HP-04/HP-06/HP-08).
 *
 * The host shell is importable without a DOM: the module only calls
 * `bootstrapHost()` when `#app` exists. These tests therefore exercise the
 * route and presentation decisions the real page uses, without booting a room,
 * a socket or a renderer.
 */
import { describe, expect, test } from "vitest";
import {
  RECONNECT_BANNER_TEXT,
  gamePathFor,
  isBackKey,
  playerCountLabel,
  resolveHostRoute,
  slotRosterStateFor,
} from "../src/main.js";

describe("[FR-10.3] host route selection", () => {
  test("root, controller, experiment and malformed paths stay on the launcher", () => {
    expect(resolveHostRoute("/")).toEqual({ kind: "launcher" });
    expect(resolveHostRoute("/index.html")).toEqual({ kind: "launcher" });
    expect(resolveHostRoute("/c/ABCD")).toEqual({ kind: "launcher" });
    expect(resolveHostRoute("/games/")).toEqual({ kind: "launcher" });
    expect(resolveHostRoute("/games/Bad_Slug/")).toEqual({ kind: "launcher" });
    expect(resolveHostRoute("/games/reaction-duel/extra")).toEqual({ kind: "launcher" });
    // The cube demo has no experiment route; `/` must never silently load it.
    expect(resolveHostRoute("/demo/cube-demo/")).toEqual({ kind: "launcher" });
    expect(resolveHostRoute("/x/e01")).toEqual({ kind: "launcher" });
  });

  test("a game path selects exactly one slug and navigates to its canonical form", () => {
    expect(resolveHostRoute("/games/reaction-duel/")).toEqual({
      kind: "game",
      slug: "reaction-duel",
    });
    expect(resolveHostRoute("/games/reaction-duel")).toEqual({
      kind: "game",
      slug: "reaction-duel",
    });
    expect(gamePathFor("reaction-duel")).toBe("/games/reaction-duel/");
    expect(gamePathFor("platformer")).toBe("/games/platformer/");
  });
});

describe("[AR-4] remote Back key", () => {
  test("Escape, browser Back and TV back codes all request the leave path", () => {
    expect(isBackKey("Escape")).toBe(true);
    expect(isBackKey("Esc")).toBe(true);
    expect(isBackKey("BrowserBack")).toBe(true);
    expect(isBackKey("GoBack")).toBe(true);
    expect(isBackKey("", 27)).toBe(true);
    expect(isBackKey("", 461)).toBe(true);
    expect(isBackKey("", 10009)).toBe(true);
  });

  test("ordinary navigation and activation keys are not Back", () => {
    expect(isBackKey("ArrowLeft")).toBe(false);
    expect(isBackKey("ArrowUp")).toBe(false);
    expect(isBackKey("Enter")).toBe(false);
    expect(isBackKey(" ")).toBe(false);
    expect(isBackKey("", 13)).toBe(false);
  });
});

describe("[FR-9.2] reconnect banner", () => {
  test("uses the HP-06 copy that names the paused game", () => {
    expect(RECONNECT_BANNER_TEXT).toBe(
      "Reconnecting to the room… The game is paused.",
    );
  });
});

describe("[FR-5.4] slot roster presence", () => {
  test("joined and resumed are connected; suspended keeps the slot reconnecting; left opens it", () => {
    expect(slotRosterStateFor("joined")).toBe("connected");
    expect(slotRosterStateFor("resumed")).toBe("connected");
    expect(slotRosterStateFor("suspended")).toBe("reconnecting");
    expect(slotRosterStateFor("left")).toBe("open");
  });

  test("player counts are whole, non-negative and pluralized", () => {
    expect(playerCountLabel(0)).toBe("0 players");
    expect(playerCountLabel(1)).toBe("1 player");
    expect(playerCountLabel(3)).toBe("3 players");
    expect(playerCountLabel(8)).toBe("8 players");
    expect(playerCountLabel(-2)).toBe("0 players");
    expect(playerCountLabel(2.9)).toBe("2 players");
    expect(playerCountLabel(Number.NaN)).toBe("0 players");
  });
});
