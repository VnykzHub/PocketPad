// @req ER-12-03 — the resident ledger must never exceed its byte/cell budgets.
import { describe, expect, it } from "vitest";
import { createWorldStreamer } from "../../src/index.js";
import {
  MemorySource,
  RecordingSink,
  createTestWorld,
  gunzipBytes,
  makeView,
  settle,
} from "../support/world-fixture.js";

describe("streamer budget enforcement", () => {
  it("[ER-12-03] never charges resident bytes above the budget", async () => {
    const world = createTestWorld({
      size: 5,
      budgets: {
        residentBytes: 100,
        textureBytes: 40,
        geometryBytes: 40,
        cpuBytes: 20,
        cacheBytes: 0,
      },
    });
    const sink = new RecordingSink();
    const streamer = createWorldStreamer(
      world.index,
      new MemorySource(world.payloads),
      sink,
      { decodeGzip: gunzipBytes },
    );

    for (let tick = 0; tick < 24; tick += 1) {
      streamer.update(tick, makeView(0, 0));
      await settle(4);
      expect(streamer.stats.residentBytes).toBeLessThanOrEqual(
        world.config.budgets.residentBytes,
      );
    }

    // The guard must not starve the streamer: with room for at least one cell,
    // the focus cell still activates.
    expect(sink.activations.length).toBeGreaterThan(0);
    streamer.stop();
    expect(streamer.stats.residentBytes).toBe(0);
  });

  it("[ER-12-03] never exceeds the resident-cell cap", async () => {
    const world = createTestWorld({
      size: 5,
      budgets: { maxResidentCells: 1 },
    });
    const sink = new RecordingSink();
    const streamer = createWorldStreamer(
      world.index,
      new MemorySource(world.payloads),
      sink,
      { decodeGzip: gunzipBytes },
    );

    for (let tick = 0; tick < 24; tick += 1) {
      streamer.update(tick, makeView(0, 0));
      await settle(4);
      expect(streamer.stats.residentCells).toBeLessThanOrEqual(1);
    }

    expect(sink.activations.length).toBeGreaterThan(0);
    streamer.stop();
  });
});
