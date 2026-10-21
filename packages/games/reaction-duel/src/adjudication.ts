/**
 * Pure round adjudication for Reaction Duel (GAME-RD-HOST-02).
 *
 * Rules (SPEC §17.2, games/reaction-duel.md + A12):
 * - The target is one of the four button bits 0-3.
 * - A pre-signal press-edge is a false start and invalidates that slot.
 * - A post-signal press of a non-target button is a miss and invalidates that
 *   slot.
 * - The earliest synced stamp among valid matching presses wins.
 * - If the two earliest valid stamps differ by less than `tieThresholdMs` the
 *   round is a replay (README §1.1).
 * - No valid matching press inside the timeout window is a no-tap replay.
 *
 * Fairness: every comparison uses the input's synced `tick` from the
 * controller clock (A3, FR-7.10), never the order in which the records appear
 * in the array or the order in which the host received them (FR-7.10).
 *
 * This module has no protocol, socket or DOM import. Its input type is the
 * game-facing shape only: slot, buttons, edges, tick.
 */

/** Highest slot the platform allows (SPEC §7, 2-8 controllers). */
const MAX_SLOT = 8;
/** Button bitfields are u16 on the wire (FR-7.2). */
const BUTTON_MASK = 0xffff;

/**
 * One polled controller input in game-facing form.
 *
 * `buttons` is the u16 level bitfield and `edges` the u16 press-edge bitfield
 * from the same poll (FR-7.2, FR-7.3). `tick` is the controller's synced
 * server-time estimate in milliseconds (A3); it is the only timestamp the
 * adjudicator trusts for fairness.
 */
export interface ReactionInput {
  /** Protocol slot, 1..8. */
  slot: number;
  /** u16 button level bitfield. */
  buttons: number;
  /** u16 press-edge bitfield accumulated since the previous poll. */
  edges: number;
  /** Synced server-clock milliseconds at press (A3). */
  tick: number;
}

/** How one slot's first press in a round was classified. */
export type SlotPressOutcome = "match" | "miss" | "false-start";

/** The first press-edge attributed to one slot, with its classification. */
export interface SlotPress {
  slot: number;
  /** Synced stamp of the slot's earliest edge in the round. */
  tick: number;
  /** Edges OR-merged when a slot had several records at the same tick. */
  edges: number;
  outcome: SlotPressOutcome;
}

/** Why a round produced no winner. */
export type ReplayReason = "tie" | "no-tap" | "all-invalid";

/** A decided round: either a winner or a replay with a machine-readable reason. */
export type RoundDecision =
  | {
      kind: "winner";
      slot: number;
      /** Synced stamp of the winning edge. */
      tick: number;
      /** Every classified first press, sorted by slot. */
      presses: SlotPress[];
    }
  | {
      kind: "replay";
      reason: ReplayReason;
      /** Every classified first press, sorted by slot. */
      presses: SlotPress[];
      /** Slots inside the tie window; empty unless `reason` is "tie". */
      tiedSlots: number[];
    };

export interface AdjudicationOptions {
  /** Target button bit, 0..15 (this game uses 0..3). */
  targetBit: number;
  /** Synced stamp at which the signal became visible. */
  signalTick: number;
  /** Round window measured from `signalTick`, in milliseconds. */
  timeoutMs: number;
  /** A gap below this many milliseconds between the two earliest valid presses replays. */
  tieThresholdMs: number;
}

interface EarliestEdge {
  tick: number;
  edges: number;
}

/**
 * Decides a round from every input record collected since it started.
 *
 * The function is pure and order-independent: for each slot only the earliest
 * `tick` counts, and identical ticks are OR-merged. Records from slots outside
 * 1..8 and records without an edge are ignored.
 *
 * A press is inside the window when `signalTick <= tick < signalTick +
 * timeoutMs`. Earlier presses are false starts; later presses are outside the
 * round and are not reported.
 */
export function adjudicateRound(
  inputs: readonly ReactionInput[],
  options: AdjudicationOptions,
): RoundDecision {
  validateOptions(options);

  // 1. Earliest edge per slot, compared by synced tick only (FR-7.10).
  const earliest = new Map<number, EarliestEdge>();
  for (const input of inputs) {
    if (!isValidSlot(input.slot) || !Number.isFinite(input.tick)) {
      continue;
    }
    const edges = input.edges & BUTTON_MASK;
    if (edges === 0) {
      continue;
    }
    const previous = earliest.get(input.slot);
    if (previous === undefined || input.tick < previous.tick) {
      earliest.set(input.slot, { tick: input.tick, edges });
    } else if (input.tick === previous.tick) {
      previous.edges |= edges;
    }
  }

  // 2. Classify the first press per slot in deterministic slot order.
  const slots: number[] = [];
  for (const slot of earliest.keys()) {
    slots.push(slot);
  }
  slots.sort((a, b) => a - b);

  const timeoutTick = options.signalTick + options.timeoutMs;
  const presses: SlotPress[] = [];
  const candidates: SlotPress[] = [];

  for (const slot of slots) {
    const edge = earliest.get(slot) as EarliestEdge;
    if (edge.tick < options.signalTick) {
      presses.push({
        slot,
        tick: edge.tick,
        edges: edge.edges,
        outcome: "false-start",
      });
    } else if (edge.tick >= timeoutTick) {
      // The press landed outside the round window; it neither wins nor misses.
      continue;
    } else if ((edge.edges & (1 << options.targetBit)) !== 0) {
      const press: SlotPress = {
        slot,
        tick: edge.tick,
        edges: edge.edges,
        outcome: "match",
      };
      presses.push(press);
      candidates.push(press);
    } else {
      presses.push({
        slot,
        tick: edge.tick,
        edges: edge.edges,
        outcome: "miss",
      });
    }
  }

  // 3. No valid matching press: report why the round is a replay.
  if (candidates.length === 0) {
    const reason: ReplayReason = presses.length === 0 ? "no-tap" : "all-invalid";
    return { kind: "replay", reason, presses, tiedSlots: [] };
  }

  // 4. Earliest synced stamp wins; a gap below the threshold replays.
  candidates.sort((a, b) => a.tick - b.tick || a.slot - b.slot);
  const winner = candidates[0] as SlotPress;

  const tiedSlots: number[] = [];
  for (const candidate of candidates) {
    if (candidate.tick - winner.tick < options.tieThresholdMs) {
      tiedSlots.push(candidate.slot);
    }
  }

  if (tiedSlots.length > 1) {
    return { kind: "replay", reason: "tie", presses, tiedSlots };
  }

  return { kind: "winner", slot: winner.slot, tick: winner.tick, presses };
}

function isValidSlot(slot: number): boolean {
  return Number.isInteger(slot) && slot >= 1 && slot <= MAX_SLOT;
}

function validateOptions(options: AdjudicationOptions): void {
  if (
    !Number.isInteger(options.targetBit) ||
    options.targetBit < 0 ||
    options.targetBit > 15
  ) {
    throw new RangeError("targetBit must be an integer in 0..15.");
  }
  if (!Number.isFinite(options.signalTick)) {
    throw new RangeError("signalTick must be a finite number.");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new RangeError("timeoutMs must be a finite number >= 0.");
  }
  if (!Number.isFinite(options.tieThresholdMs) || options.tieThresholdMs < 0) {
    throw new RangeError("tieThresholdMs must be a finite number >= 0.");
  }
}
