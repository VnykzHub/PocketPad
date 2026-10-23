import type { GameEvent, GameEvents, JsonValue, LayoutDocument } from "@lanpad/sdk";
import { validateLayout } from "@lanpad/sdk";
import { createFakeContext } from "@lanpad/sdk/testing";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  KIT_CHOICE_EVENT,
  createPack,
  type Pack,
} from "../src/index.js";
import {
  SAMPLE_COUNTDOWN_MS,
  SAMPLE_QUESTIONS,
  SAMPLE_REVEAL_MS,
  SAMPLE_ROUND_MS,
  SAMPLE_SEED,
  createSampleGame,
  type QuizQuestion,
} from "./fixtures/kit-sample.js";

interface Emitter {
  readonly events: GameEvents;
  emit(name: string, slot: number, data: JsonValue): void;
}

function createEmitter(): Emitter {
  const listeners = new Map<string, Set<(event: GameEvent) => void>>();
  return {
    events: {
      on(name, handler) {
        const set = listeners.get(name) ?? new Set();
        set.add(handler);
        listeners.set(name, set);
        return () => {
          set.delete(handler);
        };
      },
      onAny() {
        return () => {};
      },
    },
    emit(name, slot, data) {
      const set = listeners.get(name);
      if (set === undefined) {
        return;
      }
      for (const handler of [...set]) {
        handler({ slot, name, data });
      }
    },
  };
}

function nextQuestion(deck: Pack<QuizQuestion>): QuizQuestion {
  return deck.draw();
}

describe("kit sample game (ER-24-08)", () => {
  it("plays headlessly through the kit", () => {
    const emitter = createEmitter();
    const layoutsSet = vi.fn();
    const panelsClear = vi.fn();
    const ctx = createFakeContext({
      events: emitter.events,
      panels: { set: vi.fn(), show: vi.fn(), clear: panelsClear },
      layouts: { set: layoutsSet, clear: vi.fn() },
    });
    const deck = createPack(SAMPLE_QUESTIONS, { seed: SAMPLE_SEED });
    const game = createSampleGame(ctx);

    game.update(0, [1, 2]);
    expect(game.match.phase).toBe("countdown");
    expect(game.countdown).toBe("2");
    expect(game.scoreboard.get(1)).toBe(0);
    expect(layoutsSet).not.toHaveBeenCalled();

    game.update(SAMPLE_COUNTDOWN_MS, [1, 2]);
    expect(game.match.phase).toBe("playing");
    expect(game.match.round).toBe(1);
    expect(layoutsSet).toHaveBeenCalledTimes(2);
    const firstCall = layoutsSet.mock.calls[0] ?? [];
    expect(firstCall[0]).toBe(1);
    const firstLayout = firstCall[1] as LayoutDocument;
    expect(validateLayout(firstLayout).ok).toBe(true);

    const first = nextQuestion(deck);
    emitter.emit(KIT_CHOICE_EVENT, 1, { value: first.answer });
    game.update(SAMPLE_COUNTDOWN_MS + 1, [1, 2]);
    expect(game.match.phase).toBe("playing");

    game.update(SAMPLE_COUNTDOWN_MS + SAMPLE_ROUND_MS, [1, 2]);
    expect(game.match.phase).toBe("results");
    expect(game.scoreboard.get(1)).toBe(1);
    expect(game.scoreboard.get(2)).toBe(0);
    expect(panelsClear).toHaveBeenCalledWith(1);
    expect(panelsClear).toHaveBeenCalledWith(2);

    const revealAt = SAMPLE_COUNTDOWN_MS + SAMPLE_ROUND_MS + SAMPLE_REVEAL_MS;
    game.update(revealAt, [1, 2]);
    expect(game.match.phase).toBe("countdown");
    const roundTwoAt = revealAt + SAMPLE_COUNTDOWN_MS;
    game.update(roundTwoAt, [1, 2]);
    expect(game.match.phase).toBe("playing");
    expect(game.match.round).toBe(2);

    const second = nextQuestion(deck);
    emitter.emit(KIT_CHOICE_EVENT, 1, { value: second.answer });
    const roundTwoEnd = roundTwoAt + SAMPLE_ROUND_MS;
    game.update(roundTwoEnd, [1, 2]);
    expect(game.match.phase).toBe("results");
    expect(game.match.winnerSlot).toBe(1);
    expect(game.scoreboard.get(1)).toBe(2);

    const rows = game.rows;
    expect(rows[0]?.slot).toBe(1);
    expect(rows[0]?.winner).toBe(true);
    expect(rows[0]?.label).toBe("P1");
    expect(rows[0]?.color).toBe("#4cb3f0");

    game.update(roundTwoEnd + SAMPLE_REVEAL_MS, [1, 2]);
    expect(game.match.phase).toBe("lobby");
    expect(game.match.winnerSlot).toBeNull();
    game.dispose();
  });

  it("stays under 200 lines", () => {
    const path = fileURLToPath(
      new URL("./fixtures/kit-sample.ts", import.meta.url),
    );
    const lines = readFileSync(join(path), "utf8").split("\n").length;
    expect(lines).toBeLessThanOrEqual(200);
  });
});
