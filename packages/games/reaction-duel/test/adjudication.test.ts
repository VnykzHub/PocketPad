import { describe, expect, test } from "vitest";
import {
  adjudicateRound,
  type AdjudicationOptions,
  type ReactionInput,
  type RoundDecision,
} from "../src/adjudication.js";

/**
 * Adjudication is pure, so every test pins the synced stamps explicitly.
 * Signal at 1000, 3 s window, 1 ms tie threshold: valid presses live in
 * [1000, 4000).
 */
const OPTIONS: AdjudicationOptions = {
  targetBit: 1,
  signalTick: 1000,
  timeoutMs: 3000,
  tieThresholdMs: 1,
};

function input(
  slot: number,
  tick: number,
  edges: number,
  buttons: number = edges,
): ReactionInput {
  return { slot, buttons, edges, tick };
}

function winnerOf(decision: RoundDecision): { slot: number; tick: number } {
  if (decision.kind !== "winner") {
    throw new Error(`expected a winner, got replay: ${decision.reason}`);
  }
  return { slot: decision.slot, tick: decision.tick };
}

describe("adjudicateRound", () => {
  test("[FR-7.3] the target bit is matched from the edges bitfield for all four bits", () => {
    for (const bit of [0, 1, 2, 3]) {
      const decision = adjudicateRound(
        [input(1, 1100, 1 << bit)],
        { ...OPTIONS, targetBit: bit },
      );
      expect(winnerOf(decision)).toEqual({ slot: 1, tick: 1100 });
    }
  });

  test("[FR-7.3] a level without an edge does not count as a press", () => {
    const decision = adjudicateRound(
      [input(1, 1100, 0, 1 << OPTIONS.targetBit)],
      OPTIONS,
    );
    expect(decision).toMatchObject({ kind: "replay", reason: "no-tap" });
  });

  test("[FR-7.3] a multi-button edge that includes the target is a match", () => {
    const decision = adjudicateRound([input(1, 1100, 0b1111)], OPTIONS);
    expect(winnerOf(decision)).toEqual({ slot: 1, tick: 1100 });
  });

  test("[FR-7.10] the earliest synced tick wins regardless of record order", () => {
    const later = input(2, 1050, 1 << OPTIONS.targetBit);
    const earlier = input(1, 1020, 1 << OPTIONS.targetBit);

    expect(
      winnerOf(adjudicateRound([later, earlier], OPTIONS)),
    ).toEqual({ slot: 1, tick: 1020 });
    expect(
      winnerOf(adjudicateRound([earlier, later], OPTIONS)),
    ).toEqual({ slot: 1, tick: 1020 });
  });

  test("[FR-7.10] a pre-signal edge is a false start even when the slot matches later", () => {
    const decision = adjudicateRound(
      [
        input(1, 999, 1 << OPTIONS.targetBit),
        input(1, 1100, 1 << OPTIONS.targetBit),
        input(2, 1200, 1 << OPTIONS.targetBit),
      ],
      OPTIONS,
    );

    const winner = winnerOf(decision);
    expect(winner).toEqual({ slot: 2, tick: 1200 });
    const falseStart = decision.presses.find((press) => press.slot === 1);
    expect(falseStart).toMatchObject({ tick: 999, outcome: "false-start" });
  });

  test("[FR-7.10] a late-arriving packet stamped before the signal is still a false start", () => {
    const decision = adjudicateRound(
      [
        input(1, 999, 1 << OPTIONS.targetBit),
        input(2, 1000, 1 << OPTIONS.targetBit),
      ],
      OPTIONS,
    );

    expect(winnerOf(decision)).toEqual({ slot: 2, tick: 1000 });
    expect(decision.presses.find((press) => press.slot === 1)?.outcome).toBe(
      "false-start",
    );
  });

  test("[FR-7.3] a wrong-button edge after the signal is a miss and cannot win", () => {
    const wrongBit = (OPTIONS.targetBit + 2) % 4;
    const onlyWrong = adjudicateRound(
      [input(1, 1100, 1 << wrongBit), input(1, 1150, 1 << OPTIONS.targetBit)],
      OPTIONS,
    );
    expect(onlyWrong).toMatchObject({ kind: "replay", reason: "all-invalid" });
    expect(onlyWrong.presses).toHaveLength(1);
    expect(onlyWrong.presses[0]).toMatchObject({
      slot: 1,
      tick: 1100,
      outcome: "miss",
    });

    const withWinner = adjudicateRound(
      [input(1, 1100, 1 << wrongBit), input(2, 1150, 1 << OPTIONS.targetBit)],
      OPTIONS,
    );
    expect(winnerOf(withWinner)).toEqual({ slot: 2, tick: 1150 });
  });

  test("[FR-7.3] the first press of a slot decides its outcome", () => {
    const wrongFirst = adjudicateRound(
      [
        input(1, 1050, 1 << OPTIONS.targetBit),
        input(1, 1040, 1 << ((OPTIONS.targetBit + 1) % 4)),
      ],
      OPTIONS,
    );
    expect(wrongFirst).toMatchObject({ kind: "replay", reason: "all-invalid" });
    expect(wrongFirst.presses[0]).toMatchObject({ tick: 1040, outcome: "miss" });

    const correctFirst = adjudicateRound(
      [
        input(1, 1040, 1 << OPTIONS.targetBit),
        input(1, 1050, 1 << ((OPTIONS.targetBit + 1) % 4)),
      ],
      OPTIONS,
    );
    expect(winnerOf(correctFirst)).toEqual({ slot: 1, tick: 1040 });
  });

  test("[G2] the signal tick is inclusive and the timeout tick is exclusive", () => {
    expect(
      winnerOf(adjudicateRound([input(1, 1000, 1 << OPTIONS.targetBit)], OPTIONS)),
    ).toEqual({ slot: 1, tick: 1000 });

    const tooLate = adjudicateRound(
      [input(1, 4000, 1 << OPTIONS.targetBit)],
      OPTIONS,
    );
    expect(tooLate).toMatchObject({ kind: "replay", reason: "no-tap" });
    expect(tooLate.presses).toEqual([]);
  });

  test("[G2] no matching press in the window is a no-tap replay", () => {
    expect(adjudicateRound([], OPTIONS)).toMatchObject({
      kind: "replay",
      reason: "no-tap",
      presses: [],
    });
    expect(
      adjudicateRound([input(1, 999, 1 << OPTIONS.targetBit)], OPTIONS),
    ).toMatchObject({ kind: "replay", reason: "all-invalid" });
  });

  test("[G2] equal synced ticks replay as a tie and score no winner", () => {
    const decision = adjudicateRound(
      [
        input(1, 1100, 1 << OPTIONS.targetBit),
        input(2, 1100, 1 << OPTIONS.targetBit),
      ],
      OPTIONS,
    );
    expect(decision).toMatchObject({ kind: "replay", reason: "tie" });
    expect(decision.kind === "replay" ? decision.tiedSlots : []).toEqual([1, 2]);
  });

  test("[G2] the tie threshold is a strict less-than gap and is data-driven", () => {
    const nearEqual = adjudicateRound(
      [input(1, 1100, 1 << OPTIONS.targetBit), input(2, 1100.5, 1 << OPTIONS.targetBit)],
      OPTIONS,
    );
    expect(nearEqual).toMatchObject({ kind: "replay", reason: "tie" });

    const exactlyOne = adjudicateRound(
      [input(1, 1100, 1 << OPTIONS.targetBit), input(2, 1101, 1 << OPTIONS.targetBit)],
      OPTIONS,
    );
    expect(winnerOf(exactlyOne)).toEqual({ slot: 1, tick: 1100 });

    const wideThreshold = adjudicateRound(
      [input(1, 1100, 1 << OPTIONS.targetBit), input(2, 1102, 1 << OPTIONS.targetBit)],
      { ...OPTIONS, tieThresholdMs: 3 },
    );
    expect(wideThreshold).toMatchObject({ kind: "replay", reason: "tie" });
  });

  test("[G2] a three-way near-tie reports every slot inside the window", () => {
    const decision = adjudicateRound(
      [
        input(3, 1100.9, 1 << OPTIONS.targetBit),
        input(1, 1100, 1 << OPTIONS.targetBit),
        input(2, 1100.5, 1 << OPTIONS.targetBit),
      ],
      { ...OPTIONS, tieThresholdMs: 2 },
    );
    expect(decision).toMatchObject({ kind: "replay", reason: "tie" });
    expect(decision.kind === "replay" ? decision.tiedSlots : []).toEqual([
      1, 2, 3,
    ]);
  });

  test("[G4] eight players are adjudicated with one winner", () => {
    const inputs: ReactionInput[] = [];
    for (let slot = 8; slot >= 1; slot -= 1) {
      inputs.push(input(slot, 1000 + slot * 10, 1 << OPTIONS.targetBit));
    }

    const decision = adjudicateRound(inputs, OPTIONS);
    expect(winnerOf(decision)).toEqual({ slot: 1, tick: 1010 });
    expect(decision.presses).toHaveLength(8);
    expect(decision.presses.map((press) => press.slot)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  test("[G1] the winner is identified by slot for the result screen", () => {
    const decision = adjudicateRound(
      [
        input(7, 1500, 1 << OPTIONS.targetBit),
        input(3, 1250, 1 << OPTIONS.targetBit),
      ],
      OPTIONS,
    );
    expect(winnerOf(decision)).toEqual({ slot: 3, tick: 1250 });
    expect(decision.presses.every((press) => press.outcome === "match")).toBe(
      true,
    );
  });

  test("[A12] every A/B/X/Y target can win from its matching button bit", () => {
    for (const bit of [0, 1, 2, 3]) {
      const options = { ...OPTIONS, targetBit: bit };
      const decision = adjudicateRound([input(4, 1234, 1 << bit)], options);
      expect(winnerOf(decision)).toEqual({ slot: 4, tick: 1234 });
    }
  });

  test("[FR-8.1] only slot, buttons, edges and tick are consumed", () => {
    // The input object deliberately carries no socket/protocol fields; the
    // adjudicator must still decide from the four-field shape alone.
    const plain: ReactionInput = {
      slot: 2,
      buttons: 1 << OPTIONS.targetBit,
      edges: 1 << OPTIONS.targetBit,
      tick: 1200,
    };
    expect(Object.keys(plain).sort()).toEqual(["buttons", "edges", "slot", "tick"]);
    expect(winnerOf(adjudicateRound([plain], OPTIONS))).toEqual({
      slot: 2,
      tick: 1200,
    });
  });

  test("duplicate records for one slot use the earliest tick and merge equal ticks", () => {
    const merge = adjudicateRound(
      [
        input(1, 1100, 0b0100),
        input(1, 1100, 1 << OPTIONS.targetBit),
        input(1, 1090, 0b1000),
      ],
      OPTIONS,
    );
    // 1090 is the earliest edge and is a miss; the equal-tick 1100 records merge.
    expect(merge).toMatchObject({ kind: "replay", reason: "all-invalid" });
    expect(merge.presses[0]).toMatchObject({ slot: 1, tick: 1090, outcome: "miss" });

    const equalMerge = adjudicateRound(
      [
        input(2, 1100, 0b0100),
        input(2, 1100, 1 << OPTIONS.targetBit),
      ],
      OPTIONS,
    );
    expect(winnerOf(equalMerge)).toEqual({ slot: 2, tick: 1100 });
    expect(equalMerge.presses[0]?.edges).toBe(0b0100 | (1 << OPTIONS.targetBit));
  });

  test("out-of-range slots and non-finite stamps are ignored", () => {
    const decision = adjudicateRound(
      [
        input(0, 1010, 1 << OPTIONS.targetBit),
        input(9, 1020, 1 << OPTIONS.targetBit),
        input(3, Number.NaN, 1 << OPTIONS.targetBit),
        input(1, 1100, 1 << OPTIONS.targetBit),
      ],
      OPTIONS,
    );
    expect(winnerOf(decision)).toEqual({ slot: 1, tick: 1100 });
    expect(decision.presses).toHaveLength(1);
  });

  test("invalid adjudication options are rejected", () => {
    expect(() =>
      adjudicateRound([], { ...OPTIONS, targetBit: 16 }),
    ).toThrow(RangeError);
    expect(() =>
      adjudicateRound([], { ...OPTIONS, signalTick: Number.NaN }),
    ).toThrow(RangeError);
    expect(() =>
      adjudicateRound([], { ...OPTIONS, timeoutMs: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      adjudicateRound([], { ...OPTIONS, tieThresholdMs: -1 }),
    ).toThrow(RangeError);
  });
});
