import { describe, expect, test } from "vitest";
import {
  DEFAULT_REACTION_DUEL_CONFIG,
  ReactionDuelModel,
  TARGET_BITS,
  type ReactionDuelConfig,
  type ReactionInput,
  type RoundDecision,
} from "../src/model.js";

/** Injected synced clock; tests move it explicitly. */
class FakeClock {
  nowMs = 0;
  readonly now = (): number => this.nowMs;
}

interface Harness {
  clock: FakeClock;
  model: ReactionDuelModel;
}

function makeModel(
  seed = 1,
  config: Partial<ReactionDuelConfig> = {},
): Harness {
  const clock = new FakeClock();
  const model = new ReactionDuelModel({ seed, clock: clock.now, config });
  return { clock, model };
}

function addPlayers(model: ReactionDuelModel, count: number): void {
  for (let slot = 1; slot <= count; slot += 1) {
    expect(model.addPlayer(slot)).toBe(true);
  }
}

/** Runs the pending timed transition by moving the fake clock to its end. */
function advancePhase(model: ReactionDuelModel, clock: FakeClock): void {
  const endsAt = model.phaseEndsAt;
  if (endsAt === null) {
    throw new Error(`phase ${model.phase} has no timed transition`);
  }
  clock.nowMs = endsAt;
  model.update();
}

function press(
  model: ReactionDuelModel,
  slot: number,
  edges: number,
  tick: number,
  buttons: number = edges,
): void {
  const input: ReactionInput = { slot, buttons, edges, tick };
  model.update([input]);
}

/** Two-player model that has counted down and is showing a live signal. */
function atSignal(seed = 1, players = 2): Harness {
  const harness = makeModel(seed);
  addPlayers(harness.model, players);
  expect(harness.model.startMatch()).toBe(true);
  advancePhase(harness.model, harness.clock); // countdown -> waiting
  advancePhase(harness.model, harness.clock); // waiting -> signal
  expect(harness.model.phase).toBe("signal");
  return harness;
}

function lastDecision(model: ReactionDuelModel): RoundDecision {
  const round = model.lastRound;
  if (round === null) {
    throw new Error("no round has finished");
  }
  return round.decision;
}

function currentTarget(model: ReactionDuelModel): number {
  const target = model.targetBit;
  if (target === null) {
    throw new Error("no target is live");
  }
  return target;
}

/** Wins the live signal round for `slot` and checks the transition. */
function winCurrentRound(
  model: ReactionDuelModel,
  clock: FakeClock,
  slot: number,
): void {
  press(model, slot, 1 << currentTarget(model), clock.nowMs);
  expect(model.phase).toBe("roundResult");
}

/** Plays one decisive round from a countdown and advances past its result. */
function playRound(
  model: ReactionDuelModel,
  clock: FakeClock,
  winnerSlot: number,
): void {
  expect(model.phase).toBe("countdown");
  advancePhase(model, clock); // countdown -> waiting
  advancePhase(model, clock); // waiting -> signal
  winCurrentRound(model, clock, winnerSlot);
  advancePhase(model, clock); // roundResult -> countdown | matchResult
}

/** Finds a seed whose first target is `bit`; keeps all four-bit tests honest. */
function atSignalForTarget(bit: number): Harness {
  for (let seed = 1; seed <= 2000; seed += 1) {
    const harness = atSignal(seed);
    if (harness.model.targetBit === bit) {
      return harness;
    }
  }
  throw new Error(`no seed produced target bit ${bit}`);
}

describe("ReactionDuelModel lobby and timing", () => {
  test("[G1] the lobby enforces 2-8 players before the countdown", () => {
    const { clock, model } = makeModel();

    expect(model.addPlayer(0)).toBe(false);
    expect(model.addPlayer(9)).toBe(false);
    expect(model.addPlayer(1)).toBe(true);
    expect(model.addPlayer(1)).toBe(false);
    expect(model.startMatch()).toBe(false);

    for (let slot = 2; slot <= 8; slot += 1) {
      expect(model.addPlayer(slot)).toBe(true);
    }
    expect(model.playerCount).toBe(8);
    expect(model.addPlayer(8)).toBe(false);
    expect(model.startMatch()).toBe(true);
    expect(model.phase).toBe("countdown");
    expect(model.startMatch()).toBe(false);

    // A configured smaller room also refuses a 5th player.
    const small = makeModel(1, { minPlayers: 2, maxPlayers: 4 });
    addPlayers(small.model, 4);
    expect(small.model.addPlayer(5)).toBe(false);
    expect(small.model.startMatch()).toBe(true);

    // The clock is the only time source; no update means no progress.
    clock.nowMs = 0;
    expect(model.phase).toBe("countdown");
  });

  test("[G2] the injected clock alone moves waiting to signal after a 2-6 s delay", () => {
    const { clock, model } = makeModel(7);
    addPlayers(model, 2);
    expect(model.startMatch()).toBe(true);
    expect(model.phase).toBe("countdown");

    clock.nowMs = DEFAULT_REACTION_DUEL_CONFIG.countdownMs - 1;
    model.update();
    expect(model.phase).toBe("countdown");

    clock.nowMs += 1;
    model.update();
    expect(model.phase).toBe("waiting");

    const delay = model.waitDelayMs;
    expect(delay).not.toBeNull();
    expect(delay).toBeGreaterThanOrEqual(2000);
    expect(delay).toBeLessThanOrEqual(6000);
    expect(model.phaseEndsAt).toBe(clock.nowMs + (delay as number));

    clock.nowMs = (model.phaseEndsAt as number) - 1;
    model.update();
    expect(model.phase).toBe("waiting");

    clock.nowMs += 1;
    model.update();
    expect(model.phase).toBe("signal");
    expect(TARGET_BITS).toContain(model.targetBit);
    expect(model.signalAt).toBe(clock.nowMs);
    expect(model.phaseEndsAt).toBe(clock.nowMs + 3000);
  });

  test("[G1] a two-player match reaches a signal and produces a round winner", () => {
    const { clock, model } = atSignal(3, 2);
    expect(model.targetBit).not.toBeNull();
    expect(model.signalAt).toBe(clock.nowMs);

    winCurrentRound(model, clock, 1);

    expect(model.getPlayer(1)?.score).toBe(1);
    expect(model.getPlayer(2)?.score).toBe(0);
    expect(model.roundNumber).toBe(2);
    expect(model.lastRound?.roundNumber).toBe(1);
    expect(lastDecision(model)).toMatchObject({
      kind: "winner",
      slot: 1,
    });
  });
});

describe("Reaction Duel four-button rules", () => {
  test("[A12] [FR-8.1] every target bit 0-3 appears and its matching button wins", () => {
    const seen: number[] = [];

    for (const bit of TARGET_BITS) {
      const { clock, model } = atSignalForTarget(bit);
      seen.push(currentTarget(model));

      // A held non-matching level must not matter; the matching edge does.
      press(model, 1, 1 << bit, clock.nowMs);
      expect(model.phase).toBe("roundResult");
      expect(model.getPlayer(1)?.score).toBe(1);
      expect(lastDecision(model)).toMatchObject({
        kind: "winner",
        slot: 1,
        tick: clock.nowMs,
      });
    }

    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  test("[FR-7.3] only press edges drive the match, not a held button level", () => {
    const { clock, model } = atSignal(11);
    const target = currentTarget(model);

    // Level set, no edge: this is a held button, not a press.
    press(model, 1, 0, clock.nowMs, 1 << target);
    expect(model.phase).toBe("signal");
    expect(model.getPlayer(1)?.score).toBe(0);

    press(model, 1, 1 << target, clock.nowMs);
    expect(model.phase).toBe("roundResult");
    expect(lastDecision(model)).toMatchObject({ kind: "winner", slot: 1 });
  });

  test("[FR-7.3] a pre-signal edge is a false start and that slot cannot win", () => {
    const { clock, model } = makeModel(5);
    addPlayers(model, 2);
    expect(model.startMatch()).toBe(true);
    advancePhase(model, clock); // -> waiting

    const falseStartTick = clock.nowMs;
    press(model, 1, 0b0001, falseStartTick); // any button before the signal
    expect(model.phase).toBe("waiting");

    advancePhase(model, clock); // -> signal
    const target = currentTarget(model);

    press(model, 1, 1 << target, clock.nowMs + 10);
    expect(model.phase).toBe("signal");
    expect(model.getPlayer(1)?.score).toBe(0);

    press(model, 2, 1 << target, clock.nowMs + 20);
    expect(model.phase).toBe("roundResult");
    expect(lastDecision(model)).toMatchObject({ kind: "winner", slot: 2 });

    const presses = lastDecision(model).presses;
    expect(presses.find((entry) => entry.slot === 1)).toMatchObject({
      tick: falseStartTick,
      outcome: "false-start",
    });
    expect(model.getPlayer(2)?.score).toBe(1);
  });

  test("[FR-7.3] false starts alone end in an all-invalid replay at the timeout", () => {
    const { clock, model } = makeModel(6);
    addPlayers(model, 2);
    expect(model.startMatch()).toBe(true);
    advancePhase(model, clock); // -> waiting

    press(model, 1, 0b0010, clock.nowMs);
    press(model, 2, 0b0100, clock.nowMs + 1);

    advancePhase(model, clock); // -> signal
    advancePhase(model, clock); // signal timeout

    expect(model.phase).toBe("roundResult");
    expect(lastDecision(model)).toMatchObject({
      kind: "replay",
      reason: "all-invalid",
    });
    expect(model.getPlayer(1)?.score).toBe(0);
    expect(model.getPlayer(2)?.score).toBe(0);
    expect(model.roundNumber).toBe(1);

    advancePhase(model, clock); // -> countdown for the replay
    expect(model.phase).toBe("countdown");
    expect(model.roundNumber).toBe(1);
  });

  test("[FR-7.3] a wrong-button press after the signal is a miss and leaves the round live", () => {
    const { clock, model } = atSignal(13);
    const target = currentTarget(model);
    const wrong = (target + 2) % 4;

    press(model, 1, 1 << wrong, clock.nowMs + 5);
    expect(model.phase).toBe("signal");
    expect(model.getPlayer(1)?.score).toBe(0);

    press(model, 2, 1 << target, clock.nowMs + 10);
    expect(model.phase).toBe("roundResult");
    expect(lastDecision(model)).toMatchObject({ kind: "winner", slot: 2 });
    expect(
      lastDecision(model).presses.find((entry) => entry.slot === 1)?.outcome,
    ).toBe("miss");
  });

  test("[FR-7.3] only wrong-button presses replay as all-invalid", () => {
    const { clock, model } = atSignal(14);
    const target = currentTarget(model);
    const wrong = (target + 1) % 4;

    press(model, 1, 1 << wrong, clock.nowMs + 5);
    advancePhase(model, clock); // timeout

    expect(model.phase).toBe("roundResult");
    expect(lastDecision(model)).toMatchObject({
      kind: "replay",
      reason: "all-invalid",
    });
    expect(model.getPlayer(1)?.score).toBe(0);
  });
});

describe("Reaction Duel timestamp fairness", () => {
  test("[FR-7.10] the earliest synced tick wins even when delivered second", () => {
    const { clock, model } = atSignal(21);
    const target = currentTarget(model);
    const signalAt = clock.nowMs;

    // Same update, arrival order deliberately reversed.
    model.update([
      { slot: 2, buttons: 1 << target, edges: 1 << target, tick: signalAt + 5 },
      { slot: 1, buttons: 1 << target, edges: 1 << target, tick: signalAt + 2 },
    ]);

    expect(model.phase).toBe("roundResult");
    expect(lastDecision(model)).toMatchObject({
      kind: "winner",
      slot: 1,
      tick: signalAt + 2,
    });
    expect(model.getPlayer(1)?.score).toBe(1);
    expect(model.getPlayer(2)?.score).toBe(0);
  });

  test("[FR-7.10] a packet stamped before the signal is a false start when it arrives", () => {
    const { clock, model } = atSignal(22);
    const target = currentTarget(model);
    const signalAt = clock.nowMs;

    press(model, 1, 1 << target, signalAt - 1);
    expect(model.phase).toBe("signal");

    press(model, 2, 1 << target, signalAt + 10);
    expect(model.phase).toBe("roundResult");
    expect(lastDecision(model)).toMatchObject({ kind: "winner", slot: 2 });
    expect(
      lastDecision(model).presses.find((entry) => entry.slot === 1)?.outcome,
    ).toBe("false-start");
  });

  test("[G2] [FR-7.10] a stalled poll catches up at scheduled boundaries and keeps in-window edges", () => {
    const { clock, model } = makeModel(77);
    addPlayers(model, 2);
    expect(model.startMatch()).toBe(true);
    advancePhase(model, clock); // countdown -> waiting

    const scheduledSignalAt = model.phaseEndsAt;
    expect(scheduledSignalAt).not.toBeNull();
    // The host stalls 500 ms past the scheduled signal. A press stamped just
    // after the scheduled signal must still be judged against that signal,
    // not against the late poll time.
    clock.nowMs = (scheduledSignalAt as number) + 500;
    model.update([
      {
        slot: 1,
        buttons: 0b1111,
        edges: 0b1111,
        tick: (scheduledSignalAt as number) + 10,
      },
    ]);

    expect(model.phase).toBe("roundResult");
    expect(model.signalAt).toBe(scheduledSignalAt);
    expect(lastDecision(model)).toMatchObject({
      kind: "winner",
      slot: 1,
      tick: (scheduledSignalAt as number) + 10,
    });
  });

  test("[G2] equal synced stamps are a tie replay and score nothing", () => {
    const { clock, model } = atSignal(23);
    const target = currentTarget(model);
    const signalAt = clock.nowMs;

    model.update([
      { slot: 1, buttons: 1 << target, edges: 1 << target, tick: signalAt + 10 },
      { slot: 2, buttons: 1 << target, edges: 1 << target, tick: signalAt + 10 },
    ]);

    expect(model.phase).toBe("roundResult");
    expect(lastDecision(model)).toMatchObject({
      kind: "replay",
      reason: "tie",
    });
    const decision = lastDecision(model);
    expect(decision.kind === "replay" ? decision.tiedSlots : []).toEqual([1, 2]);
    expect(model.getPlayer(1)?.score).toBe(0);
    expect(model.getPlayer(2)?.score).toBe(0);
    expect(model.roundNumber).toBe(1);
  });

  test("[G2] a near-equal gap under the configured threshold replays", () => {
    const { clock, model } = atSignal(24);
    const target = currentTarget(model);
    const signalAt = clock.nowMs;

    model.update([
      { slot: 1, buttons: 1 << target, edges: 1 << target, tick: signalAt + 10 },
      { slot: 2, buttons: 1 << target, edges: 1 << target, tick: signalAt + 10.5 },
    ]);

    expect(lastDecision(model)).toMatchObject({ kind: "replay", reason: "tie" });

    const decisive = atSignal(24);
    const target2 = currentTarget(decisive.model);
    const at = decisive.clock.nowMs;
    decisive.model.update([
      { slot: 1, buttons: 1 << target2, edges: 1 << target2, tick: at + 10 },
      { slot: 2, buttons: 1 << target2, edges: 1 << target2, tick: at + 11 },
    ]);
    expect(lastDecision(decisive.model)).toMatchObject({
      kind: "winner",
      slot: 1,
    });
  });
});

describe("Reaction Duel round flow and scoring", () => {
  test("[G2] no matching press inside 3 s is a no-tap replay that does not advance the round", () => {
    const { clock, model } = atSignal(31, 2);

    advancePhase(model, clock); // signal timeout

    expect(model.phase).toBe("roundResult");
    expect(lastDecision(model)).toMatchObject({
      kind: "replay",
      reason: "no-tap",
    });
    expect(model.getPlayer(1)?.score).toBe(0);
    expect(model.getPlayer(2)?.score).toBe(0);
    expect(model.roundNumber).toBe(1);

    advancePhase(model, clock); // -> countdown
    expect(model.phase).toBe("countdown");
    expect(model.roundNumber).toBe(1);
    expect(model.targetBit).toBeNull();

    advancePhase(model, clock); // -> waiting
    expect(model.phase).toBe("waiting");
  });

  test("[G4] eight players all reach the signal and exactly one wins", () => {
    const { clock, model } = atSignal(41, 8);
    expect(model.playerCount).toBe(8);
    expect(model.phase).toBe("signal");
    expect(model.targetBit).not.toBeNull();

    const target = currentTarget(model);
    const signalAt = clock.nowMs;
    const inputs: ReactionInput[] = [];
    for (let slot = 8; slot >= 1; slot -= 1) {
      inputs.push({
        slot,
        buttons: 1 << target,
        edges: 1 << target,
        tick: signalAt + slot,
      });
    }
    model.update(inputs);

    expect(model.phase).toBe("roundResult");
    expect(lastDecision(model)).toMatchObject({
      kind: "winner",
      slot: 1,
      tick: signalAt + 1,
    });
    let total = 0;
    for (const player of model.getPlayers()) {
      total += player.score;
    }
    expect(total).toBe(1);
    expect(model.getPlayer(1)?.score).toBe(1);
  });

  test("best of 5 reaches matchResult at three wins and ignores further input", () => {
    const { clock, model } = makeModel(51);
    addPlayers(model, 2);
    expect(model.startMatch()).toBe(true);

    playRound(model, clock, 1); // 1-0, roundNumber 2
    expect(model.roundNumber).toBe(2);
    playRound(model, clock, 1); // 2-0, roundNumber 3
    expect(model.roundNumber).toBe(3);
    playRound(model, clock, 2); // 2-1, roundNumber 4
    expect(model.roundNumber).toBe(4);

    advancePhase(model, clock); // countdown -> waiting
    advancePhase(model, clock); // waiting -> signal
    winCurrentRound(model, clock, 1); // 3-1: match over
    expect(model.getPlayer(1)?.score).toBe(3);
    expect(model.getPlayer(2)?.score).toBe(1);
    expect(model.roundNumber).toBe(4);
    expect(model.matchWinnerSlot).toBe(1);
    expect(model.phase).toBe("roundResult");

    advancePhase(model, clock); // roundResult -> matchResult
    expect(model.phase).toBe("matchResult");
    expect(model.phaseEndsAt).toBeNull();

    const before = model.getPlayer(1)?.score;
    clock.nowMs += 60_000;
    model.update([
      { slot: 1, buttons: 0b1111, edges: 0b1111, tick: clock.nowMs },
    ]);
    expect(model.phase).toBe("matchResult");
    expect(model.getPlayer(1)?.score).toBe(before);
  });

  test("a 3-0 sweep ends the match without a fourth round", () => {
    const { clock, model } = makeModel(52);
    addPlayers(model, 2);
    expect(model.startMatch()).toBe(true);

    playRound(model, clock, 2);
    playRound(model, clock, 2);
    playRound(model, clock, 2);

    expect(model.phase).toBe("matchResult");
    expect(model.getPlayer(2)?.score).toBe(3);
    expect(model.getPlayer(1)?.score).toBe(0);
    expect(model.roundNumber).toBe(3);
    expect(model.matchWinnerSlot).toBe(2);
  });

  test("rematch resets scores and round number and starts a fresh countdown", () => {
    const { clock, model } = makeModel(53);
    addPlayers(model, 2);
    expect(model.startMatch()).toBe(true);
    playRound(model, clock, 1);
    playRound(model, clock, 1);
    playRound(model, clock, 1);
    expect(model.phase).toBe("matchResult");

    expect(model.rematch()).toBe(true);
    expect(model.phase).toBe("countdown");
    expect(model.roundNumber).toBe(1);
    expect(model.matchWinnerSlot).toBeNull();
    expect(model.lastRound).toBeNull();
    expect(model.targetBit).toBeNull();
    expect(model.waitDelayMs).toBeNull();
    for (const player of model.getPlayers()) {
      expect(player.score).toBe(0);
    }
    expect(model.rematch()).toBe(false);

    playRound(model, clock, 2);
    expect(model.getPlayer(2)?.score).toBe(1);
    expect(model.getPlayer(1)?.score).toBe(0);
  });

  test("a dropped slot keeps its score and can reconnect without adding a new opponent", () => {
    const { clock, model } = makeModel(54);
    addPlayers(model, 2);
    expect(model.startMatch()).toBe(true);
    playRound(model, clock, 1);
    expect(model.getPlayer(1)?.score).toBe(1);

    expect(model.removePlayer(1)).toBe(true);
    expect(model.removePlayer(1)).toBe(false);
    expect(model.playerCount).toBe(1);

    // A new slot cannot join a live match...
    expect(model.addPlayer(5)).toBe(false);
    // ...but the dropped slot reconnects with its score intact.
    expect(model.addPlayer(1)).toBe(true);
    expect(model.getPlayer(1)?.score).toBe(1);
    expect(model.playerCount).toBe(2);
  });

  test("a slot that returns mid-round joins from the next round", () => {
    const { clock, model } = makeModel(55);
    addPlayers(model, 2);
    expect(model.startMatch()).toBe(true);

    // Drop slot 1 during the countdown, so it is absent from the round roster.
    expect(model.removePlayer(1)).toBe(true);
    advancePhase(model, clock); // -> waiting (roster: slot 2)
    advancePhase(model, clock); // -> signal

    expect(model.addPlayer(1)).toBe(true); // reconnect during the signal
    const target = currentTarget(model);
    press(model, 1, 1 << target, clock.nowMs + 5);
    expect(model.phase).toBe("signal");

    press(model, 2, 1 << target, clock.nowMs + 10);
    expect(lastDecision(model)).toMatchObject({ kind: "winner", slot: 2 });

    // The next round includes the reconnected slot.
    advancePhase(model, clock); // -> countdown
    advancePhase(model, clock); // -> waiting
    advancePhase(model, clock); // -> signal
    winCurrentRound(model, clock, 1);
    expect(model.getPlayer(1)?.score).toBe(1);
  });

  test("the same seed and the same inputs produce the same match", () => {
    const run = (seed: number): string => {
      const { clock, model } = makeModel(seed);
      addPlayers(model, 2);
      expect(model.startMatch()).toBe(true);
      advancePhase(model, clock); // -> waiting
      const delay = model.waitDelayMs;
      advancePhase(model, clock); // -> signal
      const target = model.targetBit;
      const signalAt = model.signalAt;
      press(model, 1, 1 << currentTarget(model), clock.nowMs);
      return JSON.stringify({
        delay,
        target,
        signalAt,
        phase: model.phase,
        round: model.roundNumber,
        scores: model.getPlayers().map((player) => player.score),
      });
    };

    expect(run(99)).toBe(run(99));
    expect(run(100)).not.toBe("");
  });

  test("invalid configuration is rejected", () => {
    expect(() => makeModel(1, { minPlayers: 0 })).toThrow(RangeError);
    expect(() => makeModel(1, { minPlayers: 5, maxPlayers: 4 })).toThrow(
      RangeError,
    );
    expect(() => makeModel(1, { maxPlayers: 9 })).toThrow(RangeError);
    expect(() => makeModel(1, { roundsToWin: 0 })).toThrow(RangeError);
    expect(() => makeModel(1, { minDelayMs: 6001 })).toThrow(RangeError);
    expect(() => makeModel(1, { countdownMs: -1 })).toThrow(RangeError);
  });
});
