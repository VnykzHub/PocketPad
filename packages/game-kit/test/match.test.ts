import { describe, expect, it } from "vitest";
import { MatchTransitionError, createMatch } from "../src/index.js";

const OPTIONS = {
  minPlayers: 1,
  maxPlayers: 8,
  countdownMs: 3000,
  roundsToWin: 2,
} as const;

function playing(): ReturnType<typeof createMatch> {
  const match = createMatch(OPTIONS);
  match.update(0, [1, 2]);
  expect(match.start(0)).toBe(true);
  match.update(3000, [1, 2]);
  expect(match.phase).toBe("playing");
  return match;
}

describe("match lifecycle [ER-24-01]", () => {
  it("starts in the lobby with empty scores and no winner", () => {
    const match = createMatch(OPTIONS);
    expect(match.phase).toBe("lobby");
    expect(match.round).toBe(0);
    expect(match.countdownRemainingMs).toBe(0);
    expect(match.scores.size).toBe(0);
    expect(match.winnerSlot).toBeNull();
  });

  it("rejects invalid options eagerly", () => {
    expect(() => createMatch({ minPlayers: 0, maxPlayers: 2 })).toThrow(RangeError);
    expect(() => createMatch({ minPlayers: 1, maxPlayers: 9 })).toThrow(RangeError);
    expect(() => createMatch({ minPlayers: 3, maxPlayers: 2 })).toThrow(RangeError);
    expect(() =>
      createMatch({ minPlayers: 1, maxPlayers: 2, countdownMs: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      createMatch({ minPlayers: 1, maxPlayers: 2, countdownMs: 1.5 }),
    ).toThrow(RangeError);
    expect(() =>
      createMatch({ minPlayers: 1, maxPlayers: 2, roundsToWin: 0 }),
    ).toThrow(RangeError);
  });

  it("uses the documented defaults", () => {
    const match = createMatch({ minPlayers: 1, maxPlayers: 2 });
    match.update(0, [1]);
    expect(match.start(0)).toBe(true);
    expect(match.countdownRemainingMs).toBe(3000);
  });

  it("refuses to start before a roster has been reported", () => {
    const match = createMatch({ minPlayers: 1, maxPlayers: 2 });
    expect(match.start(0)).toBe(false);
    expect(match.phase).toBe("lobby");
  });

  it("rejects duplicate and out-of-range slots", () => {
    const match = createMatch({ minPlayers: 1, maxPlayers: 2 });
    match.update(0, [1, 1]);
    expect(match.start(0)).toBe(false);
    match.update(0, [0]);
    expect(match.start(0)).toBe(false);
    match.update(0, [9]);
    expect(match.start(0)).toBe(false);
    match.update(0, [2, 1]);
    expect(match.start(0)).toBe(true);
  });

  it("enforces the player count bounds", () => {
    const match = createMatch({ minPlayers: 2, maxPlayers: 2 });
    match.update(0, [1]);
    expect(match.start(0)).toBe(false);
    match.update(0, [1, 2, 3]);
    expect(match.start(0)).toBe(false);
    match.update(0, [1, 2]);
    expect(match.start(0)).toBe(true);
  });

  it("snapshots the roster in slot order and seeds zero scores", () => {
    const match = createMatch(OPTIONS);
    match.update(0, [2, 1]);
    expect(match.start(0)).toBe(true);
    expect(match.phase).toBe("countdown");
    expect(match.round).toBe(0);
    expect(match.countdownRemainingMs).toBe(3000);
    expect([...match.scores.keys()]).toEqual([1, 2]);
    expect([...match.scores.values()]).toEqual([0, 0]);
  });

  it("does not observe caller mutation of the roster buffer", () => {
    const match = createMatch({ minPlayers: 1, maxPlayers: 2 });
    const feed = [1, 2];
    match.update(0, feed);
    feed[0] = 5;
    feed.pop();
    expect(match.start(0)).toBe(true);
    expect([...match.scores.keys()]).toEqual([1, 2]);
  });

  it("counts down and enters playing at the deadline", () => {
    const match = createMatch(OPTIONS);
    match.update(0, [1, 2]);
    match.start(0);
    match.update(1500, [1, 2]);
    expect(match.phase).toBe("countdown");
    expect(match.countdownRemainingMs).toBe(1500);
    match.update(3000, [1, 2]);
    expect(match.phase).toBe("playing");
    expect(match.round).toBe(1);
    expect(match.countdownRemainingMs).toBe(0);
  });

  it("cancels the countdown when the roster shrinks", () => {
    const match = createMatch(OPTIONS);
    match.update(0, [1, 2]);
    match.start(0);
    match.update(100, [1]);
    expect(match.phase).toBe("lobby");
    expect(match.round).toBe(0);
    expect(match.scores.size).toBe(0);
  });

  it("cancels the countdown on a malformed roster feed", () => {
    const match = createMatch(OPTIONS);
    match.update(0, [1, 2]);
    match.start(0);
    match.update(100, [1, 1]);
    expect(match.phase).toBe("lobby");
  });

  it("finishes a round exactly once", () => {
    const match = playing();
    match.finishRound(1);
    expect(match.phase).toBe("results");
    expect(match.scores.get(1)).toBe(1);
    expect(() => match.finishRound(1)).toThrow(MatchTransitionError);
  });

  it("rejects winners outside the roster", () => {
    const match = playing();
    expect(() => match.finishRound(3)).toThrow(RangeError);
    expect(() => match.finishRound(0)).toThrow(RangeError);
    expect(match.phase).toBe("playing");
    expect(match.scores.get(1)).toBe(0);
  });

  it("treats a draw as results with no score", () => {
    const match = playing();
    match.finishRound(null);
    expect(match.phase).toBe("results");
    expect([...match.scores.values()]).toEqual([0, 0]);
    expect(match.winnerSlot).toBeNull();
  });

  it("moves from results to the next countdown and round", () => {
    const match = playing();
    match.finishRound(2);
    match.nextRound(4000);
    expect(match.phase).toBe("countdown");
    expect(match.round).toBe(1);
    expect(match.countdownRemainingMs).toBe(3000);
    match.update(7000, [1, 2]);
    expect(match.phase).toBe("playing");
    expect(match.round).toBe(2);
  });

  it("declares a winner at roundsToWin and resets to the lobby", () => {
    const match = playing();
    match.finishRound(1);
    match.nextRound(3100);
    match.update(6100, [1, 2]);
    expect(match.phase).toBe("playing");
    match.finishRound(1);
    expect(match.winnerSlot).toBe(1);
    expect(match.phase).toBe("results");
    match.nextRound(6200);
    expect(match.phase).toBe("lobby");
    expect(match.winnerSlot).toBeNull();
    expect(match.round).toBe(0);
    expect(match.scores.size).toBe(0);
  });

  it("throws on every illegal phase transition", () => {
    const match = createMatch(OPTIONS);
    expect(() => match.finishRound(1)).toThrow(MatchTransitionError);
    expect(() => match.nextRound(0)).toThrow(MatchTransitionError);
    match.update(0, [1]);
    match.start(0);
    expect(() => match.start(0)).toThrow(MatchTransitionError);
    expect(() => match.finishRound(1)).toThrow(MatchTransitionError);
    expect(() => match.nextRound(0)).toThrow(MatchTransitionError);
    match.update(3000, [1]);
    expect(match.phase).toBe("playing");
    expect(() => match.start(0)).toThrow(MatchTransitionError);
    expect(() => match.nextRound(0)).toThrow(MatchTransitionError);
  });

  it("rejects non-finite times", () => {
    const match = createMatch(OPTIONS);
    expect(() => match.update(Number.NaN, [1])).toThrow(RangeError);
    match.update(0, [1]);
    expect(() => match.start(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("reset returns to the lobby and clears all state", () => {
    const match = playing();
    match.finishRound(2);
    match.reset();
    expect(match.phase).toBe("lobby");
    expect(match.round).toBe(0);
    expect(match.scores.size).toBe(0);
    expect(match.countdownRemainingMs).toBe(0);
    expect(match.winnerSlot).toBeNull();
  });
});
