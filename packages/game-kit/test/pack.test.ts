import { describe, expect, it } from "vitest";
import { createPack } from "../src/index.js";

const ITEMS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

function order(seed: number): string[] {
  const pack = createPack(ITEMS, { seed });
  return ITEMS.map(() => pack.draw());
}

describe("content pack [ER-24-04]", () => {
  it("is deterministic for a seed", () => {
    expect(order(123)).toEqual(order(123));
    expect(order(123)).not.toEqual(order(999));
  });

  it("draws without replacement until the deck wraps", () => {
    const pack = createPack(ITEMS, { seed: 5 });
    const drawn = ITEMS.map(() => pack.draw());
    expect(new Set(drawn).size).toBe(ITEMS.length);
    expect(pack.draw()).toBe(drawn[0]);
    expect(pack.draw()).toBe(drawn[1]);
  });

  it("reset restores the seeded order", () => {
    const pack = createPack(ITEMS, { seed: 11 });
    const initial = ITEMS.map(() => pack.draw());
    pack.draw();
    pack.reset();
    expect(ITEMS.map(() => pack.draw())).toEqual(initial);
  });

  it("drawUnique returns the next unique batch and advances the cursor", () => {
    const pack = createPack(ITEMS, { seed: 4 });
    const first = [...pack.drawUnique(3)];
    const second = [...pack.drawUnique(5)];
    expect(new Set(first).size).toBe(3);
    expect(new Set(second).size).toBe(5);
    expect(new Set([...first, ...second]).size).toBe(8);
  });

  it("drawUnique reuses its result buffer", () => {
    const pack = createPack(ITEMS, { seed: 4 });
    const buffer = pack.drawUnique(2);
    expect(pack.drawUnique(2)).toBe(buffer);
  });

  it("drawUnique of zero is empty and of size is a permutation", () => {
    const pack = createPack(ITEMS, { seed: 2 });
    expect(pack.drawUnique(0)).toHaveLength(0);
    const all = [...pack.drawUnique(ITEMS.length)];
    expect(all).toHaveLength(ITEMS.length);
    expect(new Set(all).size).toBe(ITEMS.length);
  });

  it("rejects out-of-range unique counts", () => {
    const pack = createPack(ITEMS, { seed: 2 });
    expect(() => pack.drawUnique(-1)).toThrow(RangeError);
    expect(() => pack.drawUnique(9)).toThrow(RangeError);
    expect(() => pack.drawUnique(1.5)).toThrow(RangeError);
  });

  it("exposes the item count", () => {
    expect(createPack(ITEMS, { seed: 1 }).size).toBe(8);
  });

  it("validates its inputs at creation", () => {
    expect(() => createPack([], { seed: 1 })).toThrow(RangeError);
    expect(() => createPack<number>([1], { seed: Number.NaN })).toThrow(RangeError);
    expect(() =>
      createPack<number>([1, undefined as unknown as number], { seed: 1 }),
    ).toThrow(TypeError);
    expect(() =>
      createPack<unknown>(["ok", 2], {
        seed: 1,
        validate: (value): value is string => typeof value === "string",
      }),
    ).toThrow(TypeError);
  });
});
