/**
 * Deterministic device assignment (10 §5.10).
 *
 * Phones own slots first. Fixed assignments come next (keyboard, then pads
 * by ascending browser index). Existing non-phone assignments are retained
 * when their slot is still free, then remaining eligible devices fill the
 * lowest free slots: keyboard first, then pads by ascending index.
 *
 * A fixed claim blocked by a phone is ignored and the device stays eligible
 * for auto-fill. A fixed claim blocked by another fixed device is counted and
 * left unassigned for this recompute. `conflicts` implements the
 * `E_INPUT_CONFLICT` statistic; the caller reports it, never throws.
 */

import type { AssignmentEntry } from "../contracts/input.js";
import { INPUT_MAX_GAMEPADS } from "../version.js";

export interface AssignmentInput {
  readonly slots: number;
  /** Connected phone slots, ascending. */
  readonly phones: readonly number[];
  readonly keyboardAvailable: boolean;
  /** Eligible standard pad indexes (fixed pads may skip meaningfulness). */
  readonly pads: readonly number[];
  readonly fixedKeyboard: number | undefined;
  readonly fixedGamepads: Readonly<Record<number, number>> | undefined;
  readonly previous: readonly AssignmentEntry[];
}

export interface AssignmentResult {
  /** Sorted by slot. */
  readonly entries: AssignmentEntry[];
  readonly conflicts: number;
}

function isSlot(value: number, slots: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < slots;
}

function padIndexFromId(deviceId: string): number {
  if (!deviceId.startsWith("gamepad:")) return -1;
  const index = Number(deviceId.slice(8));
  return Number.isInteger(index) ? index : -1;
}

function keyboardKey(): string {
  return "keyboard";
}

function padKey(index: number): string {
  return `gamepad:${index}`;
}

export function computeAssignment(input: AssignmentInput): AssignmentResult {
  const slots = input.slots;
  const bySlot: (AssignmentEntry | null)[] = [];
  for (let slot = 0; slot < slots; slot += 1) bySlot.push(null);

  const assigned = new Set<string>();
  const blocked = new Set<string>();
  let conflicts = 0;

  const assign = (
    key: string,
    device: "keyboard" | "gamepad",
    slot: number,
    deviceId: string,
  ): boolean => {
    if (!isSlot(slot, slots)) return false;
    if (bySlot[slot] !== null) return false;
    bySlot[slot] = { slot, device, deviceId };
    assigned.add(key);
    return true;
  };

  // 1. Phones own their room slot.
  for (const slot of input.phones) {
    if (!isSlot(slot, slots)) continue;
    if (bySlot[slot] !== null) continue;
    bySlot[slot] = { slot, device: "phone", deviceId: `phone:${slot}` };
  }

  const eligiblePads = new Set<number>();
  for (const index of input.pads) {
    if (Number.isInteger(index) && index >= 0 && index < INPUT_MAX_GAMEPADS) {
      eligiblePads.add(index);
    }
  }

  // 2. Fixed keyboard. A phone collision is ignored; auto-fill may follow.
  if (input.keyboardAvailable && input.fixedKeyboard !== undefined) {
    const slot = input.fixedKeyboard;
    if (!isSlot(slot, slots) || bySlot[slot] !== null) {
      conflicts += 1;
    } else {
      assign(keyboardKey(), "keyboard", slot, "keyboard");
    }
  }

  // 3. Fixed pads by ascending browser index.
  const fixedPads: Array<{ pad: number; slot: number }> = [];
  if (input.fixedGamepads !== undefined) {
    for (const key of Object.keys(input.fixedGamepads)) {
      const pad = Number(key);
      const slot = input.fixedGamepads[pad];
      if (!Number.isInteger(pad) || slot === undefined) {
        conflicts += 1;
        continue;
      }
      fixedPads.push({ pad, slot });
    }
    fixedPads.sort((a, b) => a.pad - b.pad);
  }
  for (const fixed of fixedPads) {
    if (fixed.pad < 0 || fixed.pad >= INPUT_MAX_GAMEPADS) {
      conflicts += 1;
      continue;
    }
    if (!eligiblePads.has(fixed.pad)) continue;
    const key = padKey(fixed.pad);
    if (!isSlot(fixed.slot, slots) || bySlot[fixed.slot] !== null) {
      conflicts += 1;
      const occupant = isSlot(fixed.slot, slots)
        ? (bySlot[fixed.slot] ?? null)
        : null;
      // Losing to another fixed pad leaves the loser unassigned for this
      // topology; losing to a phone only drops the fixed claim.
      if (occupant !== null && occupant.device === "gamepad") blocked.add(key);
      continue;
    }
    assign(key, "gamepad", fixed.slot, key);
  }

  // 4. Keep stable previous non-phone assignments when still eligible.
  for (const entry of input.previous) {
    if (entry.device === "phone") continue;
    let key: string;
    if (entry.device === "keyboard") {
      if (!input.keyboardAvailable) continue;
      key = keyboardKey();
    } else if (entry.device === "gamepad") {
      const pad = padIndexFromId(entry.deviceId);
      if (pad < 0 || !eligiblePads.has(pad)) continue;
      key = padKey(pad);
    } else {
      continue;
    }
    if (assigned.has(key) || blocked.has(key)) continue;
    assign(key, entry.device, entry.slot, entry.deviceId);
  }

  // 5. Fill the lowest free slots: keyboard, then pads ascending.
  let cursor = 0;
  const lowestFree = (): number => {
    while (cursor < slots && bySlot[cursor] !== null) cursor += 1;
    return cursor < slots ? cursor : -1;
  };

  if (
    input.keyboardAvailable &&
    !assigned.has(keyboardKey()) &&
    !blocked.has(keyboardKey())
  ) {
    const slot = lowestFree();
    if (slot >= 0) assign(keyboardKey(), "keyboard", slot, "keyboard");
  }

  const sortedPads = Array.from(eligiblePads).sort((a, b) => a - b);
  for (const pad of sortedPads) {
    const key = padKey(pad);
    if (assigned.has(key) || blocked.has(key)) continue;
    const slot = lowestFree();
    if (slot < 0) break;
    assign(key, "gamepad", slot, key);
  }

  const entries: AssignmentEntry[] = [];
  for (const entry of bySlot) if (entry !== null) entries.push(entry);
  return { entries, conflicts };
}
