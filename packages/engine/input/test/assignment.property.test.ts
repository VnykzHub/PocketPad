/**
 * ER-10-07 — deterministic device assignment.
 *
 * Phones own their room slots. Fixed claims come next; a phone collision is
 * only reported, while a fixed-vs-fixed collision blocks the loser. Previous
 * non-phone assignments are retained when their slot is free, then keyboard
 * and pads fill the lowest free slots. The property suite checks structural
 * invariants, determinism and idempotence over random topologies.
 */

import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import { computeAssignment } from "../src/index.js";
import type { AssignmentEntry, AssignmentInput } from "../src/index.js";

function makeInput(overrides: Partial<AssignmentInput> = {}): AssignmentInput {
  return {
    slots: overrides.slots ?? 8,
    phones: overrides.phones ?? [],
    keyboardAvailable: overrides.keyboardAvailable !== false,
    pads: overrides.pads ?? [],
    fixedKeyboard: overrides.fixedKeyboard,
    fixedGamepads: overrides.fixedGamepads,
    previous: overrides.previous ?? [],
  };
}

describe("assignment topologies", () => {
  test("[ER-10-07] phones own their slots and the rest fill around them", () => {
    const result = computeAssignment(
      makeInput({ phones: [0], pads: [0, 1] }),
    );
    expect(result.entries).toEqual([
      { slot: 0, device: "phone", deviceId: "phone:0" },
      { slot: 1, device: "keyboard", deviceId: "keyboard" },
      { slot: 2, device: "gamepad", deviceId: "gamepad:0" },
      { slot: 3, device: "gamepad", deviceId: "gamepad:1" },
    ]);
    expect(result.conflicts).toBe(0);
  });

  test("[ER-10-07] a fixed keyboard blocked by a phone is reported and auto-filled", () => {
    const result = computeAssignment(
      makeInput({ slots: 4, phones: [2], fixedKeyboard: 2 }),
    );
    expect(result.entries).toEqual([
      { slot: 0, device: "keyboard", deviceId: "keyboard" },
      { slot: 2, device: "phone", deviceId: "phone:2" },
    ]);
    expect(result.conflicts).toBe(1);
  });

  test("[ER-10-07] a fixed pad blocked by a phone stays eligible for auto-fill", () => {
    const result = computeAssignment(
      makeInput({
        slots: 4,
        phones: [1],
        pads: [0],
        fixedGamepads: { 0: 1 },
      }),
    );
    expect(result.entries).toEqual([
      { slot: 0, device: "keyboard", deviceId: "keyboard" },
      { slot: 1, device: "phone", deviceId: "phone:1" },
      { slot: 2, device: "gamepad", deviceId: "gamepad:0" },
    ]);
    expect(result.conflicts).toBe(1);
  });

  test("[ER-10-07] a fixed pad losing to another fixed pad is blocked", () => {
    const result = computeAssignment(
      makeInput({
        slots: 4,
        pads: [0, 1],
        fixedKeyboard: 3,
        fixedGamepads: { 0: 0, 1: 0 },
      }),
    );
    expect(result.entries).toEqual([
      { slot: 0, device: "gamepad", deviceId: "gamepad:0" },
      { slot: 3, device: "keyboard", deviceId: "keyboard" },
    ]);
    expect(result.conflicts).toBe(1);
  });

  test("[ER-10-07] previous non-phone assignments are retained when free", () => {
    const previous: AssignmentEntry[] = [
      { slot: 2, device: "keyboard", deviceId: "keyboard" },
      { slot: 3, device: "gamepad", deviceId: "gamepad:0" },
    ];
    const result = computeAssignment(makeInput({ slots: 4, pads: [0], previous }));
    expect(result.entries).toEqual(previous);
    expect(result.conflicts).toBe(0);
  });

  test("[ER-10-07] eight phones leave no slot for keyboard or pads", () => {
    const phones = [0, 1, 2, 3, 4, 5, 6, 7];
    const result = computeAssignment(
      makeInput({ slots: 8, phones, pads: [0] }),
    );
    expect(result.entries).toHaveLength(8);
    expect(result.entries.every((entry) => entry.device === "phone")).toBe(true);
    expect(result.conflicts).toBe(0);
  });
});

const slotsArb = fc.integer({ min: 1, max: 8 });
const phonesArb = fc.uniqueArray(fc.integer({ min: 0, max: 7 }), {
  maxLength: 8,
});
const padsArb = fc.uniqueArray(fc.integer({ min: 0, max: 3 }), {
  maxLength: 4,
});
const fixedKeyboardArb = fc
  .integer({ min: -1, max: 8 })
  .map((value) => (value < 0 ? undefined : value));
const fixedGamepadsArb = fc
  .uniqueArray(
    fc.record({
      pad: fc.integer({ min: 0, max: 4 }),
      slot: fc.integer({ min: -1, max: 8 }),
    }),
    { maxLength: 3, selector: (spec) => spec.pad },
  )
  .map((specs) => {
    if (specs.length === 0) return undefined;
    const record: Record<number, number> = {};
    for (const spec of specs) record[spec.pad] = spec.slot;
    return record;
  });
const previousArb = fc
  .array(
    fc.record({
      slot: fc.integer({ min: 0, max: 7 }),
      device: fc.constantFrom("keyboard" as const, "gamepad" as const, "phone" as const),
      pad: fc.integer({ min: 0, max: 3 }),
    }),
    { maxLength: 5 },
  )
  .map((specs): AssignmentEntry[] =>
    specs.map((spec) => ({
      slot: spec.slot,
      device: spec.device,
      deviceId:
        spec.device === "keyboard"
          ? "keyboard"
          : spec.device === "phone"
            ? `phone:${spec.slot}`
            : `gamepad:${spec.pad}`,
    })),
  );

describe("assignment properties", () => {
  test(
    "[ER-10-07] 10,000 random topologies stay sorted, unique, valid and idempotent",
    () => {
      fc.assert(
        fc.property(
          slotsArb,
          phonesArb,
          padsArb,
          fixedKeyboardArb,
          fixedGamepadsArb,
          previousArb,
          (slots, rawPhones, pads, fixedKeyboard, fixedGamepads, previous) => {
            const phones = rawPhones.filter((phone) => phone < slots);
            const input = makeInput({
              slots,
              phones,
              pads,
              fixedKeyboard,
              fixedGamepads,
              previous,
            });

            const first = computeAssignment(input);
            const seenSlots = new Set<number>();
            const seenIds = new Set<string>();
            for (let index = 0; index < first.entries.length; index += 1) {
              const entry = first.entries[index];
              if (entry === undefined) throw new Error("missing entry");
              expect(Number.isInteger(entry.slot)).toBe(true);
              expect(entry.slot).toBeGreaterThanOrEqual(0);
              expect(entry.slot).toBeLessThan(slots);
              expect(seenSlots.has(entry.slot)).toBe(false);
              seenSlots.add(entry.slot);
              if (index > 0) {
                const before = first.entries[index - 1];
                expect(entry.slot).toBeGreaterThan(before?.slot ?? -1);
              }
              expect(seenIds.has(entry.deviceId)).toBe(false);
              seenIds.add(entry.deviceId);
              if (entry.device === "phone") {
                expect(phones).toContain(entry.slot);
                expect(entry.deviceId).toBe(`phone:${entry.slot}`);
              } else if (entry.device === "gamepad") {
                const pad = Number(entry.deviceId.slice("gamepad:".length));
                expect(pads).toContain(pad);
              } else {
                expect(entry.deviceId).toBe("keyboard");
              }
            }

            for (const phone of phones) {
              const entry = first.entries.find((item) => item.slot === phone);
              expect(entry?.device).toBe("phone");
            }
            expect(Number.isInteger(first.conflicts)).toBe(true);
            expect(first.conflicts).toBeGreaterThanOrEqual(0);

            // Determinism: the same topology produces the same assignment.
            const replay = computeAssignment(input);
            expect(replay.entries).toEqual(first.entries);
            expect(replay.conflicts).toBe(first.conflicts);

            // Idempotence: feeding the result back changes nothing.
            const again = computeAssignment(
              makeInput({
                slots,
                phones,
                pads,
                fixedKeyboard,
                fixedGamepads,
                previous: first.entries,
              }),
            );
            expect(again.entries).toEqual(first.entries);
          },
        ),
        { numRuns: 10_000 },
      );
    },
    30_000,
  );
});
