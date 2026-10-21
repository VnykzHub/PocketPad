import { describe, expect, it } from "vitest";
import {
  CLOCK_SAMPLE_WINDOW_MS,
  ClockSync,
  MAX_RTT_MULTIPLIER,
} from "../src/net/clockSync.js";

describe("[FR-7.10] clock sync offset estimation", () => {
  it("[FR-7.10] serverNow is 0 before the first sample", () => {
    const clock = new ClockSync();
    expect(clock.samples).toBe(0);
    expect(clock.rttMs).toBe(Number.POSITIVE_INFINITY);
    expect(clock.serverNow(1_000)).toBe(0);
  });

  it("[FR-7.10] a symmetric 20 ms round trip produces the exact offset", () => {
    const clock = new ClockSync();
    // Sent at client 100; 10 ms each way; server clock is 1000 ms ahead.
    // Server stamps 1110 when the Pong leaves; it arrives at client 120.
    clock.onPong(100, 1_110, 120);

    expect(clock.rttMs).toBe(20);
    expect(clock.offsetMs).toBe(1_000);
    expect(clock.samples).toBe(1);
    expect(clock.serverNow(500)).toBe(1_500);
    expect(clock.serverNow(5_000)).toBe(6_000);
  });

  it("[FR-7.10] clock offset uses the minimum-RTT sample, not the latest", () => {
    const clock = new ClockSync();
    // True offset is 1000 ms. Sample 1 has symmetric 10 ms legs.
    clock.onPong(100, 1_110, 120); // rtt 20, offset 1000
    clock.onPong(200, 1_210, 240); // rtt 40, offset 990
    clock.onPong(300, 1_305, 350); // rtt 50, offset 980 (> 2x min, discarded)

    expect(clock.rttMs).toBe(20);
    expect(clock.offsetMs).toBe(1_000);
    expect(clock.samples).toBe(2);

    clock.onPong(400, 1_405, 425); // rtt 25, offset 992.5; kept but not chosen
    expect(clock.rttMs).toBe(20);
    expect(clock.offsetMs).toBe(1_000);
    expect(clock.samples).toBe(3);
  });

  it("[FR-7.10] a later clean sample replaces a high-RTT offset", () => {
    const clock = new ClockSync();
    clock.onPong(100, 1_050, 200); // rtt 100, offset 900
    expect(clock.offsetMs).toBe(900);
    expect(clock.samples).toBe(1);

    clock.onPong(300, 1_310, 320); // rtt 20, offset 1000
    expect(clock.samples).toBe(1); // the 100 ms sample is > 2x the 20 ms minimum
    expect(clock.offsetMs).toBe(1_000);
    expect(clock.rttMs).toBe(20);
  });

  it("[FR-7.10] samples are pruned after the 30 s window and the offset recovers", () => {
    const clock = new ClockSync();
    expect(CLOCK_SAMPLE_WINDOW_MS).toBe(30_000);
    expect(MAX_RTT_MULTIPLIER).toBe(2);

    clock.onPong(100, 1_110, 120); // rtt 20, offset 1000, received at 120
    clock.onPong(20_100, 21_050, 20_200); // rtt 100, offset 900, discarded
    expect(clock.offsetMs).toBe(1_000);
    expect(clock.samples).toBe(1);

    // 30.88 s after the only retained sample the window is empty, but the
    // last offset is held over so tick never regresses to 0.
    expect(clock.serverNow(31_000)).toBe(32_000);
    expect(clock.samples).toBe(0);
    expect(clock.offsetMs).toBe(1_000);
    expect(clock.rttMs).toBe(Number.POSITIVE_INFINITY);

    clock.onPong(30_900, 31_900, 31_000); // rtt 100, offset 950
    expect(clock.samples).toBe(1);
    expect(clock.rttMs).toBe(100);
    expect(clock.offsetMs).toBe(950);
    expect(clock.serverNow(31_500)).toBe(32_450);
  });

  it("[FR-7.10] the last offset is held over when the window empties", () => {
    const clock = new ClockSync();
    clock.onPong(100, 1_110, 120);
    expect(clock.offsetMs).toBe(1_000);

    // No Pongs for 40 s: no sample remains, but the synced tick keeps rising.
    expect(clock.serverNow(40_000)).toBe(41_000);
    expect(clock.samples).toBe(0);
    expect(clock.offsetMs).toBe(1_000);
  });

  it("[FR-7.10] a fresh sample keeps the window from going empty", () => {
    const clock = new ClockSync();
    clock.onPong(100, 1_110, 120);
    clock.onPong(20_000, 21_010, 20_020); // rtt 20, offset 1000
    expect(clock.samples).toBe(2);

    // Both samples are still inside the window relative to 25 s.
    expect(clock.serverNow(25_000)).toBe(26_000);
    expect(clock.samples).toBe(2);

    // The first sample is now old; the second survives until 50.02 s.
    expect(clock.serverNow(31_000)).toBe(32_000);
    expect(clock.samples).toBe(1);
  });
});

describe("[FR-7.10] invalid pong samples are ignored", () => {
  it("[FR-7.10] non-finite fields and negative RTT drop the sample", () => {
    const clock = new ClockSync();
    clock.onPong(Number.NaN, 1_000, 2_000);
    clock.onPong(100, Number.NaN, 2_000);
    clock.onPong(100, 1_000, Number.NaN);
    clock.onPong(2_000, 1_000, 1_000); // received before it was sent

    expect(clock.samples).toBe(0);
    expect(clock.offsetMs).toBe(0);
    expect(clock.serverNow(500)).toBe(0);
  });

  it("[FR-7.10] a zero-RTT sample is accepted", () => {
    const clock = new ClockSync();
    clock.onPong(100, 1_100, 100);
    expect(clock.rttMs).toBe(0);
    expect(clock.offsetMs).toBe(1_000);
    expect(clock.serverNow(200)).toBe(1_200);
  });
});
