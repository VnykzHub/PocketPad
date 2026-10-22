/**
 * D7 route selection: `/games/<slug>/` launches a bundled game; `/` keeps the
 * cube demo. The dev server serves the same host page at both paths.
 */
import { describe, expect, test } from "vitest";
import { gameSlugFromPath } from "../src/game/gameRoute.js";

describe("[FR-10.3] direct game route", () => {
  test("accepts exactly one lowercase slug, with or without a trailing slash", () => {
    expect(gameSlugFromPath("/games/reaction-duel/")).toBe("reaction-duel");
    expect(gameSlugFromPath("/games/reaction-duel")).toBe("reaction-duel");
    expect(gameSlugFromPath("/games/cube2/")).toBe("cube2");
  });

  test("keeps the root, controller and malformed paths out of the game route", () => {
    expect(gameSlugFromPath("/")).toBeNull();
    expect(gameSlugFromPath("/index.html")).toBeNull();
    expect(gameSlugFromPath("/c/ABCD")).toBeNull();
    expect(gameSlugFromPath("/games/")).toBeNull();
    expect(gameSlugFromPath("/games/Bad_Slug/")).toBeNull();
    expect(gameSlugFromPath("/games/reaction-duel/extra")).toBeNull();
    expect(gameSlugFromPath("/demo/cube-demo/")).toBeNull();
  });
});
