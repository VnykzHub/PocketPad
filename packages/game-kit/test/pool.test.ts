import { describe, expect, it } from "vitest";
import { PoolExhaustedError, createPool } from "../src/index.js";

interface Item {
  id: number;
  resets: number;
}

function trackingPool(capacity: number): {
  pool: ReturnType<typeof createPool<Item>>;
  created: () => number;
} {
  let createdCount = 0;
  const pool = createPool<Item>(
    () => {
      createdCount += 1;
      return { id: createdCount, resets: 0 };
    },
    (item) => {
      item.resets += 1;
    },
    capacity,
  );
  return { pool, created: () => createdCount };
}

describe("object pool (ER-24-05)", () => {
  it("prewarms exactly capacity items and never creates again", () => {
    const { pool, created } = trackingPool(3);
    expect(created()).toBe(3);
    const items = [pool.acquire(), pool.acquire(), pool.acquire()];
    expect(created()).toBe(3);
    for (const item of items) {
      pool.release(item);
    }
    expect(created()).toBe(3);
    pool.acquire();
    expect(created()).toBe(3);
  });

  it("throws the named exhaustion error", () => {
    const { pool } = trackingPool(1);
    pool.acquire();
    let caught: unknown;
    try {
      pool.acquire();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PoolExhaustedError);
    expect((caught as PoolExhaustedError).code).toBe("E_POOL_EXHAUSTED");
    expect(String(caught)).toContain("E_POOL_EXHAUSTED");
  });

  it("tracks active count and reuses released items", () => {
    const { pool } = trackingPool(2);
    const first = pool.acquire();
    const second = pool.acquire();
    expect(pool.active).toBe(2);
    expect(first).not.toBe(second);
    pool.release(first);
    expect(pool.active).toBe(1);
    expect(first.resets).toBe(1);
    expect(pool.acquire()).toBe(first);
    expect(pool.active).toBe(2);
  });

  it("ignores and counts foreign and double releases", () => {
    const { pool } = trackingPool(2);
    const item = pool.acquire();
    pool.release(item);
    pool.release(item);
    pool.release({ id: 99, resets: 0 });
    expect(pool.ignoredReleases).toBe(2);
    expect(pool.active).toBe(0);
  });

  it("visits only active items", () => {
    const { pool } = trackingPool(3);
    const first = pool.acquire();
    const second = pool.acquire();
    const seen: number[] = [];
    pool.forEachActive((item) => {
      seen.push(item.id);
    });
    expect(seen.slice().sort((a, b) => a - b)).toEqual(
      [first.id, second.id].sort((a, b) => a - b),
    );
    pool.release(first);
    seen.length = 0;
    pool.forEachActive((item) => {
      seen.push(item.id);
    });
    expect(seen).toEqual([second.id]);
  });

  it("clear resets every active item and refills the pool", () => {
    const { pool } = trackingPool(2);
    const first = pool.acquire();
    const second = pool.acquire();
    pool.clear();
    expect(pool.active).toBe(0);
    expect(first.resets).toBe(1);
    expect(second.resets).toBe(1);
    expect(pool.acquire()).toBeDefined();
    expect(pool.acquire()).toBeDefined();
    expect(() => pool.acquire()).toThrow(PoolExhaustedError);
  });

  it("supports a zero-capacity pool", () => {
    const { pool } = trackingPool(0);
    expect(pool.capacity).toBe(0);
    expect(pool.active).toBe(0);
    expect(() => pool.acquire()).toThrow(PoolExhaustedError);
    pool.clear();
  });

  it("validates capacity and the factory", () => {
    expect(() => createPool(() => ({}), () => {}, -1)).toThrow(RangeError);
    expect(() => createPool(() => ({}), () => {}, 1.5)).toThrow(RangeError);
    expect(() =>
      createPool<undefined>(
        () => undefined,
        () => {},
        1,
      ),
    ).toThrow(TypeError);
  });

  it("reports capacity", () => {
    const { pool } = trackingPool(6);
    expect(pool.capacity).toBe(6);
  });
});
