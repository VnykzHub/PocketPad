/**
 * Byte ledger, pressure thresholds, eviction ordering and the residency
 * state machine (spec 12 §5.5/§5.7, ER-12-03/07).
 */

import { describe, expect, it } from "vitest";
import type {
  CellKey,
  CellMemoryEntry,
  EvictionCandidate,
  PayloadMeta,
  PayloadRecord,
  ResidencyState,
} from "../../src/index.js";
import {
  MAX_LOAD_ATTEMPTS,
  MemoryLedger,
  ResidencyTable,
  canTransition,
  comparePressureEviction,
  isPressureRecovered,
  payloadId,
  pressureStageOf,
  publicCellState,
  retryDelayTicks,
  selectDistanceEvictions,
  selectPressureEvictions,
} from "../../src/index.js";
import { expectCode } from "../support/world-fixture.js";

function entry(
  key: string,
  geometry = 0,
  texture = 0,
  cpu = 0,
  sharedAssets?: CellMemoryEntry["sharedAssets"],
): CellMemoryEntry {
  return sharedAssets === undefined
    ? { key, geometryBytes: geometry, textureBytes: texture, cpuBytes: cpu }
    : { key, geometryBytes: geometry, textureBytes: texture, cpuBytes: cpu, sharedAssets };
}

function meta(
  key: string,
  kind: "visual" | "sim" = "visual",
  lod: 0 | 1 | 2 | 3 | null = 0,
): PayloadMeta {
  return {
    key: key as CellKey,
    cx: 0,
    cy: 0,
    kind,
    lod: kind === "sim" ? null : lod,
    url: `${key}.cell`,
    expectedBytes: 10,
    contentHash: "fnv1a32:00000000",
  };
}

function candidate(key: string, overrides: Partial<EvictionCandidate> = {}): EvictionCandidate {
  return {
    key: key as CellKey,
    cx: 0,
    cy: 0,
    lod: 3,
    distanceMeters: 100,
    pinned: false,
    guarded: false,
    inSimRing: false,
    ...overrides,
  };
}

describe("pressure thresholds", () => {
  it("[ER-12-03] stages at 85/95/100 percent and recovers below 80", () => {
    expect(pressureStageOf(0, 1000)).toBe(0);
    expect(pressureStageOf(849, 1000)).toBe(0);
    expect(pressureStageOf(850, 1000)).toBe(1);
    expect(pressureStageOf(949, 1000)).toBe(1);
    expect(pressureStageOf(950, 1000)).toBe(2);
    expect(pressureStageOf(999, 1000)).toBe(2);
    expect(pressureStageOf(1000, 1000)).toBe(3);
    expect(pressureStageOf(1200, 1000)).toBe(3);

    expect(isPressureRecovered(799.999, 1000)).toBe(true);
    expect(isPressureRecovered(800, 1000)).toBe(false);
    expect(isPressureRecovered(0, 1000)).toBe(true);
  });

  it("[ER-12-03] rejects impossible ledger inputs", async () => {
    await expectCode(() => pressureStageOf(-1, 1000), "E_STREAM_STATE");
    await expectCode(() => pressureStageOf(0, 0), "E_STREAM_STATE");
    await expectCode(() => pressureStageOf(0, Number.NaN), "E_STREAM_STATE");
    await expectCode(() => isPressureRecovered(0, -10), "E_STREAM_STATE");
  });
});

describe("memory ledger", () => {
  it("[ER-12-03] adds and removes the three categories exactly", () => {
    const ledger = new MemoryLedger(1000);
    const bill = ledger.add(entry("a", 100, 20, 5));
    expect(bill.totalBytes).toBe(125);
    ledger.add(entry("b", 50, 0, 5));
    expect(ledger.residentBytes).toBe(180);
    expect(ledger.geometryBytes).toBe(150);
    expect(ledger.textureBytes).toBe(20);
    expect(ledger.cpuBytes).toBe(10);
    expect(ledger.cellCount).toBe(2);
    expect(ledger.snapshot()).toEqual({
      geometryBytes: 150,
      textureBytes: 20,
      cpuBytes: 10,
      residentBytes: 180,
      cells: 2,
      sharedAssets: 0,
    });
    expect(ledger.billFor("a")).toEqual({
      key: "a",
      uniqueBytes: 125,
      sharedBytes: 0,
      totalBytes: 125,
    });

    expect(ledger.remove("a")).toBe(true);
    expect(ledger.remove("a")).toBe(false);
    expect(ledger.residentBytes).toBe(55);
    expect(ledger.billFor("a")).toBeUndefined();
    expect(ledger.has("b")).toBe(true);
    ledger.reset();
    expect(ledger.residentBytes).toBe(0);
    expect(ledger.cellCount).toBe(0);
  });

  it("[ER-12-03] rejects duplicate cells and negative byte counts", async () => {
    const ledger = new MemoryLedger(1000);
    ledger.add(entry("a", 1));
    await expectCode(() => ledger.add(entry("a", 1)), "E_STREAM_STATE");
    await expectCode(() => ledger.add(entry("b", -1)), "E_STREAM_STATE");
    await expectCode(() => new MemoryLedger(0), "E_STREAM_STATE");
    await expectCode(() => ledger.wouldExceed(-1), "E_STREAM_STATE");
  });

  it("[ER-12-03] charges a shared asset once and releases it at the last reference", () => {
    const ledger = new MemoryLedger(1000);
    const mesh = { id: "mesh:city", category: "geometry" as const, bytes: 100 };
    ledger.add(entry("a", 10, 0, 0, [mesh]));
    ledger.add(entry("b", 10, 0, 0, [mesh]));
    expect(ledger.residentBytes).toBe(120);
    expect(ledger.sharedAssetCount).toBe(1);
    expect(ledger.billFor("a")).toEqual({
      key: "a",
      uniqueBytes: 10,
      sharedBytes: 100,
      totalBytes: 110,
    });

    ledger.remove("a");
    expect(ledger.residentBytes).toBe(110);
    expect(ledger.sharedAssetCount).toBe(1);
    ledger.remove("b");
    expect(ledger.residentBytes).toBe(0);
    expect(ledger.sharedAssetCount).toBe(0);
  });

  it("[ER-12-03] rejects an inconsistent shared-asset declaration", async () => {
    const ledger = new MemoryLedger(1000);
    ledger.add(entry("a", 0, 0, 0, [{ id: "mesh:x", category: "geometry", bytes: 10 }]));
    await expectCode(
      () => ledger.add(entry("b", 0, 0, 0, [{ id: "mesh:x", category: "geometry", bytes: 11 }])),
      "E_STREAM_STATE",
    );
    await expectCode(
      () => ledger.add(entry("c", 0, 0, 0, [{ id: "mesh:x", category: "texture", bytes: 10 }])),
      "E_STREAM_STATE",
    );
    await expectCode(
      () =>
        ledger.add(
          entry("d", 0, 0, 0, [
            { id: "mesh:y", category: "geometry", bytes: 1 },
            { id: "mesh:y", category: "geometry", bytes: 1 },
          ]),
        ),
      "E_STREAM_STATE",
    );
    await expectCode(
      () => ledger.add(entry("e", 0, 0, 0, [{ id: "", category: "geometry", bytes: 1 }])),
      "E_STREAM_STATE",
    );
  });

  it("[ER-12-03] reports whether an addition would exceed the budget", () => {
    const ledger = new MemoryLedger(100);
    ledger.add(entry("a", 60));
    expect(ledger.wouldExceed(40)).toBe(false);
    expect(ledger.wouldExceed(41)).toBe(true);
    expect(ledger.pressureStage).toBe(0);
    ledger.add(entry("b", 25));
    expect(ledger.pressureStage).toBe(1);
    ledger.add(entry("c", 15));
    expect(ledger.pressureStage).toBe(3);
    expect(ledger.recovered).toBe(false);
    ledger.remove("c");
    expect(ledger.pressureStage).toBe(1);
    // Recovery means *below* 80%, so 85% is still under pressure.
    expect(ledger.recovered).toBe(false);
    ledger.remove("b");
    expect(ledger.pressureStage).toBe(0);
    expect(ledger.recovered).toBe(true);
  });
});

describe("eviction policy", () => {
  it("[ER-12-03] orders pressure evictions coarsest first, then farthest", () => {
    const candidates = [
      candidate("1,1", { cx: 1, cy: 1, lod: 1, distanceMeters: 500 }),
      candidate("2,2", { cx: 2, cy: 2, lod: 3, distanceMeters: 450 }),
      candidate("3,3", { cx: 3, cy: 3, lod: 3, distanceMeters: 460 }),
      candidate("4,4", { cx: 4, cy: 4, lod: 2, distanceMeters: 300 }),
      candidate("5,5", { cx: 5, cy: 5, lod: 3, distanceMeters: 460 }),
    ];
    const selected = selectPressureEvictions(candidates);
    expect(selected.map((item) => item.key)).toEqual(["5,5", "3,3", "2,2", "4,4", "1,1"]);
    expect(selectPressureEvictions(candidates, 2).map((item) => item.key)).toEqual(["5,5", "3,3"]);
    expect(
      comparePressureEviction(
        candidates[0] as EvictionCandidate,
        candidates[1] as EvictionCandidate,
      ),
    ).toBeGreaterThan(0);
  });

  it("[ER-12-03] never evicts pinned, guarded or simulation-ring cells", () => {
    const candidates = [
      candidate("0,0", { pinned: true, distanceMeters: 900 }),
      candidate("1,0", { guarded: true, distanceMeters: 900 }),
      candidate("2,0", { inSimRing: true, distanceMeters: 900 }),
      candidate("3,0", { distanceMeters: 900 }),
    ];
    expect(selectPressureEvictions(candidates).map((item) => item.key)).toEqual(["3,0"]);
    expect(selectPressureEvictions([])).toEqual([]);
    expect(selectPressureEvictions(candidates, 0)).toEqual([]);
  });

  it("[ER-12-03] evicts distance candidates past the limit, ascending key, never pinned", () => {
    const candidates = [
      candidate("5,0", { cx: 5, distanceMeters: 472.0001 }),
      candidate("2,0", { cx: 2, distanceMeters: 500 }),
      candidate("9,0", { cx: 9, distanceMeters: 900, pinned: true }),
      candidate("1,0", { cx: 1, distanceMeters: 472 }),
    ];
    const selected = selectDistanceEvictions(candidates, 472);
    expect(selected.map((item) => item.key)).toEqual(["2,0", "5,0"]);
    // A zero limit still excludes only the pinned cell; every positive
    // distance counts as past the limit (strict `>`).
    expect(selectDistanceEvictions(candidates, 0).map((item) => item.key)).toEqual([
      "1,0",
      "2,0",
      "5,0",
    ]);
  });
});

describe("residency state machine", () => {
  it("[ER-12-07] names payloads by kind, cell and LOD and projects public states", () => {
    expect(payloadId("visual", "1,2" as CellKey, 3)).toBe("visual:1,2:3");
    expect(payloadId("visual", "1,2" as CellKey)).toBe("visual:1,2:0");
    expect(payloadId("sim", "1,2" as CellKey)).toBe("sim:1,2");

    const states: ResidencyState[] = [
      "unloaded",
      "queued",
      "loading",
      "decoding",
      "ready",
      "resident",
      "evicting",
      "failed",
    ];
    expect(states.map(publicCellState)).toEqual([
      "unloaded",
      "loading",
      "loading",
      "loading",
      "resident",
      "resident",
      "evicting",
      "unloaded",
    ]);
  });

  it("[ER-12-07] allows only the diagram's edges", () => {
    expect(canTransition("unloaded", "queued")).toBe(true);
    expect(canTransition("queued", "loading")).toBe(true);
    expect(canTransition("loading", "decoding")).toBe(true);
    expect(canTransition("decoding", "ready")).toBe(true);
    expect(canTransition("ready", "resident")).toBe(true);
    expect(canTransition("resident", "evicting")).toBe(true);
    expect(canTransition("evicting", "unloaded")).toBe(true);
    expect(canTransition("failed", "unloaded")).toBe(true);
    expect(canTransition("unloaded", "resident")).toBe(false);
    expect(canTransition("resident", "queued")).toBe(false);
    expect(canTransition("failed", "queued")).toBe(false);
  });

  it("[ER-12-07] backs off 15/30/60 ticks then parks", async () => {
    expect(retryDelayTicks(1)).toBe(15);
    expect(retryDelayTicks(2)).toBe(30);
    expect(retryDelayTicks(3)).toBe(60);
    expect(retryDelayTicks(4)).toBe(Number.POSITIVE_INFINITY);
    await expectCode(() => retryDelayTicks(0), "E_STREAM_STATE");
    await expectCode(() => retryDelayTicks(1.5), "E_STREAM_STATE");
    expect(MAX_LOAD_ATTEMPTS).toBe(3);
  });

  it("[ER-12-07] enforces concurrent and per-tick admission caps", () => {
    const table = new ResidencyTable({ maxConcurrentLoads: 2, maxLoadsStartedPerTick: 1 });
    const a = table.ensure(meta("0,0"));
    const b = table.ensure(meta("1,0"));
    const c = table.ensure(meta("2,0"));
    expect(a.state).toBe("unloaded");

    table.beginTick();
    table.admit(a, 10, 0, 0);
    table.admit(b, 10, 0, 0);
    table.admit(c, 10, 0, 0);
    expect(a.requestedAtTick).toBe(10);
    expect(table.tryStart(a, 10, new AbortController())).toBe(true);
    expect(table.tryStart(b, 10, new AbortController())).toBe(false); // per-tick cap
    expect(a.state).toBe("loading");
    expect(b.state).toBe("queued");

    table.beginTick();
    expect(table.tryStart(b, 11, new AbortController())).toBe(true);
    // Both slots are now in flight; a third start must wait.
    expect(table.inFlight()).toBe(2);
    table.beginTick();
    expect(table.tryStart(c, 12, new AbortController())).toBe(false);
    expect(c.state).toBe("queued");
  });

  it("[ER-12-07] walks admission to residency and resets attempt history", () => {
    const table = new ResidencyTable({ maxConcurrentLoads: 4, maxLoadsStartedPerTick: 4 });
    const record = table.ensure(meta("0,0"));
    const abort = new AbortController();
    table.admit(record, 1, 1, 12);
    expect(record.priorityClass).toBe(1);
    expect(record.score).toBe(12);
    table.admit(record, 2, 0, 3); // idempotent re-admission updates demand
    expect(record.requestedAtTick).toBe(2);
    expect(record.state).toBe("queued");

    table.beginTick();
    expect(table.tryStart(record, 2, abort)).toBe(true);
    expect(record.abort).toBe(abort);
    expect(record.startedAtTick).toBe(2);
    table.markReceived(record);
    expect(record.state).toBe("decoding");
    table.markReady(record, 9);
    expect(record.readyAtTick).toBe(9);
    expect(record.abort).toBeNull();
    table.markResident(record);
    expect(record.state).toBe("resident");
    expect(record.activated).toBe(true);

    expect(table.countIn(["resident"])).toBe(1);
    expect(table.size).toBe(1);
    table.beginEvict(record);
    table.release(record);
    expect(record.state).toBe("unloaded");
    expect(record.activated).toBe(false);
  });

  it("[ER-12-07] retries after backoff and parks after the third failure", () => {
    const table = new ResidencyTable({ maxConcurrentLoads: 4, maxLoadsStartedPerTick: 4 });
    const record = table.ensure(meta("0,0"));

    const failOnce = (tick: number): void => {
      table.beginTick();
      table.admit(record, tick, 0, 0);
      expect(table.tryStart(record, tick, new AbortController())).toBe(true);
      table.markReceived(record);
      table.markFailed(record, "E_CELL_FORMAT", tick);
    };

    failOnce(100);
    expect(record.state).toBe("failed");
    expect(record.attempts).toBe(1);
    expect(record.retryAtTick).toBe(115);
    expect(table.isRetryable(record, 114)).toBe(false);
    expect(table.isRetryable(record, 115)).toBe(true);
    expect(table.readyRetry(record, 114)).toBe(false);
    expect(table.readyRetry(record, 115)).toBe(true);
    expect(record.state).toBe("unloaded");

    failOnce(200);
    expect(record.attempts).toBe(2);
    expect(record.retryAtTick).toBe(230);
    expect(table.readyRetry(record, 230)).toBe(true);

    failOnce(300);
    expect(record.attempts).toBe(3);
    expect(record.retryAtTick).toBe(Number.POSITIVE_INFINITY);
    expect(table.isRetryable(record, 1_000_000)).toBe(false);

    table.resetForReentry(record);
    expect(record.state).toBe("unloaded");
    expect(record.errorCode).toBeNull();
    expect(record.retryAtTick).toBe(0);
    // `resetForReentry` keeps attempts; only a successful apply resets them.
    expect(record.attempts).toBe(3);
  });

  it("[ER-12-07] cancels queued, loading and ready payloads and aborts fetches", () => {
    const table = new ResidencyTable({ maxConcurrentLoads: 4, maxLoadsStartedPerTick: 4 });
    const queued = table.ensure(meta("0,0"));
    table.admit(queued, 0, 0, 0);
    table.cancelPending(queued);
    expect(queued.state).toBe("unloaded");

    const loading = table.ensure(meta("1,0"));
    table.admit(loading, 0, 0, 0);
    const abort = new AbortController();
    table.beginTick();
    expect(table.tryStart(loading, 0, abort)).toBe(true);
    expect(abort.signal.aborted).toBe(false);
    table.cancelPending(loading);
    expect(abort.signal.aborted).toBe(true);
    expect(loading.state).toBe("unloaded");
    expect(loading.abort).toBeNull();

    const ready = table.ensure(meta("2,0"));
    table.admit(ready, 0, 0, 0);
    table.beginTick();
    table.tryStart(ready, 0, new AbortController());
    table.markReceived(ready);
    table.markReady(ready, 1);
    table.cancelPending(ready);
    expect(ready.state).toBe("evicting");
    expect(ready.activated).toBe(false);

    const resident = table.ensure(meta("3,0"));
    table.admit(resident, 0, 0, 0);
    table.beginTick();
    table.tryStart(resident, 0, new AbortController());
    table.markReceived(resident);
    table.markReady(resident, 1);
    table.markResident(resident);
    expect(() => table.cancelPending(resident)).toThrow(/cannot cancel/);
  });

  it("[ER-12-07] rejects illegal transitions instead of guessing", async () => {
    const table = new ResidencyTable({ maxConcurrentLoads: 4, maxLoadsStartedPerTick: 4 });
    const record = table.ensure(meta("0,0"));
    table.admit(record, 0, 0, 0);
    await expectCode(() => table.markReady(record, 1), "E_STREAM_STATE");
    await expectCode(() => table.markResident(record), "E_STREAM_STATE");
    await expectCode(() => table.beginEvict(record), "E_STREAM_STATE");
    // A queued record is cancellable, unlike a resident one.
    expect(() => table.cancelPending(record)).not.toThrow();
    expect(record.state).toBe("unloaded");
  });

  it("[ER-12-07] lists one cell's payloads visual-first and aborts on clear", () => {
    const table = new ResidencyTable({ maxConcurrentLoads: 4, maxLoadsStartedPerTick: 4 });
    table.ensure(meta("0,0", "visual", 3));
    table.ensure(meta("0,0", "visual", 0));
    table.ensure(meta("0,0", "visual", 2));
    table.ensure(meta("0,0", "sim"));
    table.ensure(meta("1,0", "visual", 0));
    expect(table.forCell("0,0" as CellKey).map((record: PayloadRecord) => record.lod)).toEqual([
      0,
      2,
      3,
      null,
    ]);
    expect(table.forCell("9,9" as CellKey)).toEqual([]);

    const active = table.ensure(meta("2,0"));
    table.admit(active, 0, 0, 0);
    const abort = new AbortController();
    table.beginTick();
    table.tryStart(active, 0, abort);
    table.clear();
    expect(abort.signal.aborted).toBe(true);
    expect(table.size).toBe(0);

    const forgotten = table.ensure(meta("3,0"));
    table.admit(forgotten, 0, 0, 0);
    const forgetAbort = new AbortController();
    table.beginTick();
    table.tryStart(forgotten, 0, forgetAbort);
    table.forget(forgotten);
    expect(forgetAbort.signal.aborted).toBe(true);
    expect(table.get(payloadId("visual", "3,0" as CellKey, 0))).toBeUndefined();
  });
});
