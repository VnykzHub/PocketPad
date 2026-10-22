/**
 * RoundManager tests (D7-SDK-01; fake clock, best-of shell).
 *
 * `RoundManager` is optional and owns no timers: every transition takes an
 * explicit `nowMs`, so these tests also serve as the fake-clock contract.
 */
import { describe, expect, test } from "vitest";
import {
  RoundManager,
  RoundTransitionError,
  type RoundPhase,
} from "../src/game/RoundManager.js";

function started(options: {
  minPlayers?: number;
  maxPlayers?: number;
  countdownMs?: number;
  roundsToWin?: number;
} = {}, slots: ReadonlyArray<number> = [1, 2]): RoundManager {
  const rounds = new RoundManager({
    minPlayers: options.minPlayers ?? 2,
    maxPlayers: options.maxPlayers ?? 8,
    ...(options.countdownMs === undefined ? {} : { countdownMs: options.countdownMs }),
    ...(options.roundsToWin === undefined ? {} : { roundsToWin: options.roundsToWin }),
  });
  expect(rounds.startWhenReady(slots)).toBe(true);
  return rounds;
}

describe("player-count gating", () => {
  test("[A12] below minPlayers the manager stays in the lobby", () => {
    const rounds = new RoundManager({ minPlayers: 2, maxPlayers: 8 });
    expect(rounds.startWhenReady([1])).toBe(false);
    expect(rounds.startWhenReady([])).toBe(false);
    expect(rounds.phase).toBe("lobby");
    expect(rounds.slots).toEqual([]);
  });

  test("[A12] exactly minPlayers starts the countdown", () => {
    const rounds = new RoundManager({ minPlayers: 2, maxPlayers: 8 });
    expect(rounds.startWhenReady([2, 1])).toBe(true);
    expect(rounds.phase).toBe("countdown");
    expect(rounds.slots).toEqual([1, 2]);
    expect(rounds.roundNumber).toBe(0);
  });

  test("[A12] eight slots are accepted and nine are not", () => {
    const eight = new RoundManager({ minPlayers: 2, maxPlayers: 8 });
    expect(eight.startWhenReady([8, 1, 2, 3, 4, 5, 6, 7])).toBe(true);

    const capped = new RoundManager({ minPlayers: 1, maxPlayers: 2 });
    expect(capped.startWhenReady([1, 2, 3])).toBe(false);
    expect(capped.phase).toBe("lobby");
  });

  test("invalid and duplicate slot lists are rejected without changing phase", () => {
    const rounds = new RoundManager({ minPlayers: 1, maxPlayers: 8 });
    expect(rounds.startWhenReady([0])).toBe(false);
    expect(rounds.startWhenReady([9])).toBe(false);
    expect(rounds.startWhenReady([1.5])).toBe(false);
    expect(rounds.startWhenReady([1, 1])).toBe(false);
    expect(rounds.phase).toBe("lobby");
  });

  test("startWhenReady only succeeds once", () => {
    const rounds = started();
    expect(rounds.startWhenReady([1, 2])).toBe(false);
    expect(rounds.phase).toBe("countdown");
  });
});

describe("phase transitions", () => {
  test("[G8] countdown -> playing -> results -> countdown", () => {
    const rounds = started({ countdownMs: 1500 });
    expect(rounds.phase).toBe("countdown");

    rounds.beginRound(1000);
    expect(rounds.phase).toBe("playing");
    expect(rounds.roundNumber).toBe(1);
    expect(rounds.roundStartedAt).toBe(1000);

    rounds.endRound({ winnerSlot: 1 });
    expect(rounds.phase).toBe("results");
    expect(rounds.getScore(1)).toBe(1);
    expect(rounds.roundStartedAt).toBeNull();

    expect(rounds.nextRound(2500)).toBe(true);
    expect(rounds.phase).toBe("countdown");
    expect(rounds.countdownEndsAt).toBe(4000);
    expect(rounds.roundNumber).toBe(1);

    rounds.beginRound(4000);
    expect(rounds.roundNumber).toBe(2);
    expect(rounds.countdownEndsAt).toBeNull();
  });

  test("beginRound and endRound reject impossible phases", () => {
    const rounds = new RoundManager({ minPlayers: 2, maxPlayers: 8 });
    expect(() => rounds.beginRound(0)).toThrow(RoundTransitionError);
    expect(() => rounds.endRound({ winnerSlot: 1 })).toThrow(RoundTransitionError);

    rounds.startWhenReady([1, 2]);
    expect(() => rounds.endRound({ winnerSlot: 1 })).toThrow(RoundTransitionError);

    rounds.beginRound(0);
    expect(() => rounds.beginRound(1)).toThrow(RoundTransitionError);
  });

  test("nextRound returns false outside the results phase", () => {
    const rounds = new RoundManager({ minPlayers: 2, maxPlayers: 8 });
    expect(rounds.nextRound(0)).toBe(false);
    rounds.startWhenReady([1, 2]);
    expect(rounds.nextRound(0)).toBe(false);
    rounds.beginRound(0);
    expect(rounds.nextRound(0)).toBe(false);
  });

  test("a winner outside the roster is rejected", () => {
    const rounds = started({}, [1, 2]);
    rounds.beginRound(0);
    expect(() => rounds.endRound({ winnerSlot: 3 })).toThrow(RangeError);
    expect(rounds.phase).toBe("playing");
    expect(rounds.getScore(3)).toBe(0);
  });
});

describe("scoring and best-of", () => {
  test("[A12] the first slot to roundsToWin ends the match", () => {
    const rounds = started({ roundsToWin: 2, countdownMs: 1000 }, [1, 2, 3]);

    rounds.beginRound(0);
    rounds.endRound({ winnerSlot: 1 });
    expect(rounds.matchWinnerSlot).toBeNull();
    expect(rounds.nextRound(100)).toBe(true);

    rounds.beginRound(1000);
    rounds.endRound({ winnerSlot: 3 });
    expect(rounds.nextRound(1100)).toBe(true);

    rounds.beginRound(2000);
    rounds.endRound({ winnerSlot: 1 });
    expect(rounds.getScore(1)).toBe(2);
    expect(rounds.matchWinnerSlot).toBe(1);
    expect(rounds.nextRound(2100)).toBe(false);
    expect(rounds.phase).toBe("results");
  });

  test("a draw (null winner) scores nothing and can be replayed", () => {
    const rounds = started({ roundsToWin: 2 });
    rounds.beginRound(0);
    rounds.endRound({ winnerSlot: null });
    expect(rounds.phase).toBe("results");
    expect(rounds.getScore(1)).toBe(0);
    expect(rounds.getScore(2)).toBe(0);
    expect(rounds.matchWinnerSlot).toBeNull();
    expect(rounds.nextRound(100)).toBe(true);
    rounds.beginRound(1100);
    expect(rounds.roundNumber).toBe(2);
  });

  test("roundsToWin 1 decides in a single round", () => {
    const rounds = started({ roundsToWin: 1 });
    rounds.beginRound(0);
    rounds.endRound({ winnerSlot: 2 });
    expect(rounds.matchWinnerSlot).toBe(2);
    expect(rounds.nextRound(0)).toBe(false);
  });
});

describe("validation and reset", () => {
  test("invalid constructor options throw RangeError", () => {
    expect(() => new RoundManager({ minPlayers: 0, maxPlayers: 8 })).toThrow(RangeError);
    expect(() => new RoundManager({ minPlayers: 1, maxPlayers: 9 })).toThrow(RangeError);
    expect(() => new RoundManager({ minPlayers: 3, maxPlayers: 2 })).toThrow(RangeError);
    expect(
      () => new RoundManager({ minPlayers: 1, maxPlayers: 8, countdownMs: -1 }),
    ).toThrow(RangeError);
    expect(
      () => new RoundManager({ minPlayers: 1, maxPlayers: 8, roundsToWin: 0 }),
    ).toThrow(RangeError);
  });

  test("defaults are 3000 ms countdown and best of 5 (3 wins)", () => {
    const rounds = new RoundManager({ minPlayers: 1, maxPlayers: 8 });
    expect(rounds.countdownMs).toBe(3000);
    expect(rounds.roundsToWin).toBe(3);
  });

  test("non-finite time values are rejected", () => {
    const rounds = new RoundManager({ minPlayers: 1, maxPlayers: 8 });
    rounds.startWhenReady([1]);
    expect(() => rounds.beginRound(Number.NaN)).toThrow(RangeError);
    expect(() => rounds.beginRound(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    rounds.beginRound(0);
    rounds.endRound({ winnerSlot: 1 });
    expect(() => rounds.nextRound(Number.NaN)).toThrow(RangeError);
  });

  test("reset returns to a clean lobby and allows a rematch", () => {
    const rounds = started({ minPlayers: 1, roundsToWin: 1 }, [1]);
    rounds.beginRound(0);
    rounds.endRound({ winnerSlot: 1 });
    expect(rounds.matchWinnerSlot).toBe(1);

    rounds.reset();
    expect(rounds.phase).toBe("lobby");
    expect(rounds.roundNumber).toBe(0);
    expect(rounds.matchWinnerSlot).toBeNull();
    expect(rounds.slots).toEqual([]);
    expect(rounds.getScore(1)).toBe(0);

    expect(rounds.startWhenReady([1])).toBe(true);
    expect(rounds.phase).toBe("countdown");
  });

  test("the exposed phase union matches the frozen D7-SDK-01 shape", () => {
    const phases: RoundPhase[] = ["lobby", "countdown", "playing", "results"];
    expect(phases).toHaveLength(4);
    expect(started().phase satisfies RoundPhase).toBe("countdown");
  });
});
