/**
 * Draw and Guess host acceptance (GAME-DG-HOST-01..06, GAME-DG-TEST-01..04/07).
 *
 * Every test drives the real adapter through the fixed 50 ms tick with a
 * recording context: panels show exactly what each phone would receive, the
 * layout recorder shows role hot-swaps, and the flat renderer shows the ink
 * the TV was asked to draw.
 */
import { describe, expect, test } from "vitest";
import {
  DG_DRAWER_LAYOUT_ID,
  DG_GUESSER_LAYOUT_ID,
  DG_RESULTS_LAYOUT_ID,
} from "../src/config.js";
import { createFakePlayer, createHarness, type Harness } from "./harness.js";

function roster(...slots: number[]): ReturnType<typeof createFakePlayer>[] {
  return slots.map((slot) => createFakePlayer(slot));
}

function guesserFor(drawer: number): number {
  return drawer === 2 ? 3 : 2;
}

/** Emits the round's word from a non-drawer slot and returns that slot. */
function solveRound(h: Harness): number {
  const guesser = guesserFor(h.game.drawerSlot);
  h.emitText(guesser, h.game.currentWord);
  return guesser;
}

describe("Draw and Guess host", () => {
  test("[GAME-DG-HOST-01] a solo phone never starts a match; two players do", () => {
    const h = createHarness({ players: roster(1) });
    h.tick(10);
    expect(h.game.phase).toBe("lobby");
    expect(h.game.roundNumber).toBe(0);

    h.setPlayers(roster(1, 2));
    h.advanceToPlaying();
    expect(h.game.roster).toEqual([1, 2]);
    expect(h.game.drawerSlot).toBe(1);
    expect(h.game.roundNumber).toBe(1);
  });

  test("[GAME-DG-HOST-02][GAME-DG-TEST-01][SR-13] the word reaches only the drawer's panel and never the TV", () => {
    const h = createHarness({ game: { words: ["lighthouse"] } });
    h.advanceToPlaying();
    const drawer = h.game.drawerSlot;
    const word = h.game.currentWord;
    expect(drawer).toBe(1);
    expect(word).toBe("lighthouse");

    for (const slot of [1, 2, 3]) {
      const texts = h.panelTextsFor(slot);
      if (slot === drawer) {
        expect(texts.some((text) => text.includes(`Your word: ${word}`))).toBe(true);
      } else {
        expect(texts.some((text) => text.includes(word))).toBe(false);
      }
    }

    h.game.render(0);
    expect(h.renderer.texts.some((text) => text.includes(word))).toBe(false);
    expect(h.layouts.lastFor(drawer)).toBe(DG_DRAWER_LAYOUT_ID);
    expect(h.layouts.lastFor(2)).toBe(DG_GUESSER_LAYOUT_ID);
    expect(h.layouts.lastFor(3)).toBe(DG_GUESSER_LAYOUT_ID);
  });

  test("[GAME-DG-TEST-04][GAME-DG-HOST-05] three rounds rotate the drawer, never repeat a word and crown one winner", () => {
    const h = createHarness();
    const drawers: number[] = [];
    const words: string[] = [];

    for (let round = 1; round <= 3; round += 1) {
      h.advanceToPlaying();
      expect(h.game.roundNumber).toBe(round);
      drawers.push(h.game.drawerSlot);
      words.push(h.game.currentWord);
      const guesser = solveRound(h);
      expect(h.game.phase).toBe("results");
      expect(h.game.firstCorrectSlot).toBe(guesser);
      h.tick();
    }

    expect(drawers).toEqual([1, 2, 3]);
    expect(new Set(words).size).toBe(3);
    expect(h.game.phase).toBe("results");
    expect(h.game.finalResults).toBe(true);
    expect(h.game.results[0]?.label).toBe("P2");
    expect(h.game.results[0]?.score).toBe(3);
    expect(h.game.results[0]?.winner).toBe(true);
    expect(h.game.scores.slice(0, 3)).toEqual([1, 3, 2]);
  });

  test("[GAME-DG-HOST-04][GAME-DG-TEST-03] a trimmed, case-folded, accent-folded guess scores first", () => {
    const h = createHarness({ game: { words: ["cafe"] } });
    h.advanceToPlaying();
    const drawer = h.game.drawerSlot;
    expect(drawer).toBe(1);

    // The drawer cannot guess their own word.
    h.emitText(drawer, "cafe");
    expect(h.game.guessCount).toBe(0);
    expect(h.game.phase).toBe("playing");

    h.emitText(2, "  CAFÉ ");
    expect(h.game.guessCount).toBe(1);
    expect(h.game.phase).toBe("results");
    expect(h.game.firstCorrectSlot).toBe(2);
    h.tick();
    expect(h.game.scores.slice(0, 3)).toEqual([1, 1, 0]);

    // A later correct guess cannot steal the score.
    h.emitText(3, "cafe");
    expect(h.game.firstCorrectSlot).toBe(2);
    h.tick();
    expect(h.game.scores.slice(0, 3)).toEqual([1, 1, 0]);
  });

  test("[GAME-DG-HOST-04][GAME-DG-TEST-03] duplicate guesses per slot are ignored and matching is exact", () => {
    const h = createHarness({ game: { words: ["apple"] } });
    h.advanceToPlaying();

    h.emitText(2, "wrong");
    h.emitText(2, " WRONG ");
    h.emitText(3, "Wrong");
    expect(h.game.guessCount).toBe(2);
    h.tick();
    expect(h.game.phase).toBe("playing");

    h.emitText(2, "APPLES");
    expect(h.game.guessCount).toBe(3);
    expect(h.game.phase).toBe("playing");

    h.emitText(2, "Apple");
    expect(h.game.phase).toBe("results");
    expect(h.game.firstCorrectSlot).toBe(2);
    h.tick();
    expect(h.game.scores.slice(0, 3)).toEqual([1, 1, 0]);
  });

  test("[GAME-DG-HOST-04][GAME-DG-DATA-02] the 20th unresolved guess ends the round without a score", () => {
    const h = createHarness({ game: { words: ["apple"] } });
    h.advanceToPlaying();

    for (let index = 0; index < 20; index += 1) {
      h.emitText(2, `guess-${index}`);
    }
    expect(h.game.guessCount).toBe(20);
    expect(h.game.phase).toBe("results");
    expect(h.game.firstCorrectSlot).toBeNull();
    h.tick();

    expect(h.game.phase).toBe("results");
    expect(h.game.results.every((row) => !row.winner)).toBe(true);
    expect(h.game.scores.slice(0, 3)).toEqual([0, 0, 0]);
  });

  test("[GAME-DG-HOST-06][GAME-DG-HOST-03][GAME-DG-TEST-02] a drawer who reconnects inside the grace keeps the word and ink", () => {
    const h = createHarness({ game: { words: ["apple"], reconnectPauseMs: 1000 } });
    h.advanceToPlaying();
    const drawer = h.game.drawerSlot;
    const word = h.game.currentWord;
    expect(drawer).toBe(1);

    h.emitCanvas(drawer, [{ x: 0.1, y: 0.1, t: 0 }], "start");
    h.emitCanvas(drawer, [{ x: 0.2, y: 0.2, t: 10 }], "move");
    h.emitCanvas(drawer, [{ x: 0.3, y: 0.3, t: 20 }], "end");
    h.tick();
    expect(h.game.strokeCount).toBe(1);
    expect(h.game.strokePointCount).toBe(3);

    h.setPlayers(roster(2, 3));
    h.tick(4);
    expect(h.game.phase).toBe("playing");
    expect(h.game.drawerPauseRemainingMs).toBeGreaterThan(0);
    expect(h.layouts.clears).toContain(drawer);
    expect(h.game.currentWord).toBe(word);

    h.setPlayers(roster(1, 2, 3));
    h.tick();
    expect(h.game.drawerPauseRemainingMs).toBe(0);
    expect(h.game.currentWord).toBe(word);
    expect(h.game.strokeCount).toBe(1);

    h.emitCanvas(1, [{ x: 0.4, y: 0.4, t: 30 }], "start");
    h.tick();
    expect(h.game.strokeCount).toBe(2);
    h.game.render(0);
    expect(h.renderer.polylines).toHaveLength(2);
  });

  test("[GAME-DG-HOST-06] a drawer who stays away past the grace skips the round and the match recovers", () => {
    const h = createHarness({ game: { words: ["apple"], reconnectPauseMs: 1000 } });
    h.advanceToPlaying();
    expect(h.game.drawerSlot).toBe(1);

    h.setPlayers(roster(2, 3));
    h.tick(19);
    expect(h.game.phase).toBe("playing");
    expect(h.game.drawerPauseRemainingMs).toBe(50);

    h.tick();
    expect(h.game.phase).toBe("lobby");
    expect(h.game.scores.slice(0, 3)).toEqual([0, 0, 0]);

    h.advanceToPlaying();
    expect(h.game.roster).toEqual([2, 3]);
    expect(h.game.drawerSlot).toBe(2);
    expect(h.game.roundNumber).toBe(1);
  });

  test("[GAME-DG-HOST-06][GAME-DG-TEST-03] a guesser who drops can rejoin and win the round", () => {
    const h = createHarness({ game: { words: ["apple"] } });
    h.advanceToPlaying();

    h.setPlayers(roster(1, 3));
    h.tick();
    expect(h.game.phase).toBe("playing");
    expect(h.game.connectedMask).toBe(0b1010);
    expect(h.layouts.clears).toContain(2);

    h.setPlayers(roster(1, 2, 3));
    h.tick();
    expect(h.game.connectedMask).toBe(0b1110);
    expect(h.layouts.lastFor(2)).toBe(DG_GUESSER_LAYOUT_ID);

    h.emitText(2, "APPLE");
    h.tick();
    expect(h.game.phase).toBe("results");
    expect(h.game.firstCorrectSlot).toBe(2);
    expect(h.game.scores.slice(0, 3)).toEqual([1, 1, 0]);
  });

  test("[GAME-DG-CTRL-05][FR-8.2] a role change swaps layouts for the affected slots only", () => {
    const h = createHarness();
    h.advanceToPlaying();
    expect(h.game.drawerSlot).toBe(1);
    h.emitText(2, h.game.currentWord);
    h.tick();

    expect(h.layouts.lastFor(1)).toBe(DG_DRAWER_LAYOUT_ID);
    expect(h.layouts.lastFor(2)).toBe(DG_GUESSER_LAYOUT_ID);
    expect(h.layouts.lastFor(3)).toBe(DG_GUESSER_LAYOUT_ID);

    const marker = h.layouts.sets.length;
    h.advanceToPlaying();
    expect(h.game.drawerSlot).toBe(2);
    const affected = h.layouts.sets.slice(marker);
    expect(affected.map((entry) => entry.target)).toEqual([1, 2]);
    expect(affected.map((entry) => entry.layout)).toEqual([
      DG_GUESSER_LAYOUT_ID,
      DG_DRAWER_LAYOUT_ID,
    ]);
  });

  test("[GAME-DG-HOST-05][FR-8.2] final results are remote-operable and a rematch resets the match", () => {
    const h = createHarness();
    for (let round = 1; round <= 3; round += 1) {
      h.advanceToPlaying();
      solveRound(h);
      h.tick();
    }

    expect(h.game.finalResults).toBe(true);
    expect(h.game.phase).toBe("results");
    for (const slot of [1, 2, 3]) {
      expect(h.layouts.lastFor(slot)).toBe(DG_RESULTS_LAYOUT_ID);
    }
    expect(h.game.results[0]?.winner).toBe(true);

    h.emitChoice(2, "rematch");
    h.tick();
    expect(h.game.phase).toBe("lobby");
    expect(h.game.finalResults).toBe(false);
    expect(h.game.scores.slice(0, 3)).toEqual([0, 0, 0]);

    h.advanceToPlaying();
    expect(h.game.roundNumber).toBe(1);
    expect(h.game.drawerSlot).toBe(1);
    expect(h.game.currentWord.length).toBeGreaterThan(0);
  });

  test("[SR-13][GAME-DG-TEST-07] hostile guesses are inert, never echoed and never scored", () => {
    const h = createHarness({ game: { words: ["apple"] } });
    h.advanceToPlaying();

    h.emitText(2, '<img src=x onerror="alert(1)">');
    h.emitText(2, "<script>alert('x')</script>");
    h.emitText(3, "</script><svg onload=alert(1)>");
    h.tick();
    expect(h.game.phase).toBe("playing");
    expect(h.game.guessCount).toBe(3);

    // Control-only text sanitizes to nothing and is not a guess.
    h.emitText(2, "\u0000\u0001");
    expect(h.game.guessCount).toBe(3);

    h.game.render(0);
    const visible = [
      ...h.panelTextsFor(1),
      ...h.panelTextsFor(2),
      ...h.panelTextsFor(3),
      ...h.renderer.texts,
    ].join("\n");
    expect(visible).not.toContain("<img");
    expect(visible).not.toContain("<script");
    expect(visible).not.toContain("<svg");
    expect(visible).not.toContain("onerror");
    expect(visible).not.toContain("onload");
  });

  test("[G4][GAME-DG-PERF-01][GAME-DG-HOST-03] eight players and a 512-point stroke stay bounded", () => {
    const h = createHarness({ players: roster(1, 2, 3, 4, 5, 6, 7, 8) });
    h.advanceToPlaying();
    expect(h.game.maxPlayers).toBe(8);
    // Bits are slot numbers (1..8), so eight connected players are 0x1fe.
    expect(h.game.connectedMask).toBe(0x1fe);
    expect(h.game.roster).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(h.game.drawerSlot).toBe(1);

    const points = Array.from({ length: 512 }, (_, index) => ({
      x: index / 511,
      y: 0.5,
      t: index,
    }));
    h.emitCanvas(1, points, "start");
    h.tick();
    expect(h.game.strokeCount).toBe(1);
    expect(h.game.strokePointCount).toBe(512);
    h.game.render(0);
    expect(h.renderer.polylines[0]?.points).toHaveLength(512);

    h.emitText(8, h.game.currentWord);
    h.tick();
    expect(h.game.phase).toBe("results");
    expect(h.game.firstCorrectSlot).toBe(8);
    expect(h.game.scores.slice(0, 8)).toEqual([1, 0, 0, 0, 0, 0, 0, 1]);
  });

  test("[GAME-DG-PERF-01] a settled tick does not churn layouts, panels or frames", () => {
    const h = createHarness();
    h.advanceToPlaying();
    h.tick(10);
    const layoutSets = h.layouts.sets.length;
    const panelRecords = h.panels.records.length;

    h.tick(10);
    expect(h.layouts.sets.length).toBe(layoutSets);
    expect(h.panels.records.length).toBe(panelRecords);

    h.game.render(0);
    expect(h.renderer.frameCount).toBe(1);
  });

  test("[G8][GAME-DG-HOST-03] dispose unsubscribes, clears state and is idempotent", () => {
    const h = createHarness();
    h.advanceToPlaying();
    const word = h.game.currentWord;
    expect(h.bus.subscriptionCount).toBe(3);

    h.game.dispose();
    expect(h.bus.subscriptionCount).toBe(0);
    expect(h.game.phase).toBe("lobby");
    expect(h.game.currentWord).toBe("");
    expect(h.game.strokeCount).toBe(0);

    h.emitText(2, word);
    h.tick();
    h.game.render(0);
    expect(h.renderer.frameCount).toBe(0);
    h.game.dispose();
    expect(h.bus.subscriptionCount).toBe(0);
  });
});
