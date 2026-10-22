/**
 * InputMapper tests (D2-RT-01).
 *
 * The trace runner replays JSON fixtures from `test/fixtures/traces/` through
 * the same public API the host runtime uses: `apply()` per packet, then
 * `pollAll()` once per host tick. Polls that share a `hostTick` observe one
 * snapshot, exactly like a game reading the single per-tick poll.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { InputState } from "@lanpad/protocol";
import { InputMapper } from "../src/input/InputMapper";
import type {
  ControllerState,
  InputSnapshot,
} from "../src/input/types";

function packet(overrides: Partial<InputState> = {}): InputState {
  return {
    tick: 1000,
    buttons: 0,
    edges: 0,
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
    gx: 0,
    gy: 0,
    gz: 0,
    lt: 0,
    rt: 0,
    flags: 0,
    ...overrides,
  };
}

function pollPlayer(
  mapper: InputMapper,
  slot = 1,
  hostTick = 1,
): ControllerState {
  const snapshot = mapper.pollAll(hostTick);
  const player = snapshot.players[slot - 1];
  if (player === undefined) {
    throw new Error(`InputMapper has no slot ${slot}.`);
  }
  return player;
}

interface TracePacket {
  atMs: number;
  slot: number;
  tick: number;
  buttons?: number;
  edges?: number;
  lx?: number;
  ly?: number;
  rx?: number;
  ry?: number;
  gx?: number;
  gy?: number;
  gz?: number;
  lt?: number;
  rt?: number;
  flags?: number;
}

interface TracePoll {
  hostTick: number;
  slot?: number;
  expect: Record<string, number>;
}

interface TraceFixture {
  name: string;
  hostTickHz: number;
  packets: TracePacket[];
  polls: TracePoll[];
}

const TRACES_DIRECTORY = fileURLToPath(
  new URL("./fixtures/traces/", import.meta.url),
);

const ANALOG_FIELDS = new Set([
  "lx",
  "ly",
  "rx",
  "ry",
  "lt",
  "rt",
  "gx",
  "gy",
  "gz",
]);

function loadTrace(name: string): TraceFixture {
  const text = readFileSync(join(TRACES_DIRECTORY, `${name}.json`), "utf8");
  return JSON.parse(text) as TraceFixture;
}

function toInputState(source: TracePacket): InputState {
  return {
    tick: source.tick,
    buttons: source.buttons ?? 0,
    edges: source.edges ?? 0,
    lx: source.lx ?? 0,
    ly: source.ly ?? 0,
    rx: source.rx ?? 0,
    ry: source.ry ?? 0,
    gx: source.gx ?? 0,
    gy: source.gy ?? 0,
    gz: source.gz ?? 0,
    lt: source.lt ?? 0,
    rt: source.rt ?? 0,
    flags: source.flags ?? 0,
  };
}

function readField(
  player: ControllerState,
  field: string,
): number | undefined {
  switch (field) {
    case "slot":
      return player.slot;
    case "buttons":
      return player.buttons;
    case "edges":
      return player.edges;
    case "lx":
      return player.lx;
    case "ly":
      return player.ly;
    case "rx":
      return player.rx;
    case "ry":
      return player.ry;
    case "gx":
      return player.gyro.x;
    case "gy":
      return player.gyro.y;
    case "gz":
      return player.gyro.z;
    case "lt":
      return player.triggers.lt;
    case "rt":
      return player.triggers.rt;
    case "tick":
      return player.tick;
    default:
      return undefined;
  }
}

function assertPoll(
  trace: TraceFixture,
  snapshot: InputSnapshot,
  poll: TracePoll,
): void {
  const slot = poll.slot ?? 1;
  const player = snapshot.players[slot - 1];
  expect(player, `${trace.name}: slot ${slot}`).toBeDefined();
  if (player === undefined) {
    return;
  }

  for (const [field, expected] of Object.entries(poll.expect)) {
    const actual = readField(player, field);
    if (ANALOG_FIELDS.has(field)) {
      expect(actual, `${trace.name}: ${field}`).toBeCloseTo(expected, 3);
    } else {
      expect(actual, `${trace.name}: ${field}`).toBe(expected);
    }
  }
}

function runTrace(name: string): void {
  const trace = loadTrace(name);
  const mapper = new InputMapper();
  let nextPacket = 0;
  let pollIndex = 0;

  while (pollIndex < trace.polls.length) {
    const firstPoll = trace.polls[pollIndex];
    if (firstPoll === undefined) {
      break;
    }
    const pollAtMs = (firstPoll.hostTick * 1000) / trace.hostTickHz;

    while (nextPacket < trace.packets.length) {
      const tracePacket = trace.packets[nextPacket];
      if (tracePacket === undefined || tracePacket.atMs > pollAtMs) {
        break;
      }
      mapper.apply(
        tracePacket.slot,
        toInputState(tracePacket),
        tracePacket.atMs,
      );
      nextPacket += 1;
    }

    // Every poll for one host tick reads the same single pollAll call.
    const snapshot = mapper.pollAll(firstPoll.hostTick);
    while (pollIndex < trace.polls.length) {
      const poll = trace.polls[pollIndex];
      if (poll === undefined || poll.hostTick !== firstPoll.hostTick) {
        break;
      }
      assertPoll(trace, snapshot, poll);
      pollIndex += 1;
    }
  }

  expect(nextPacket, `${trace.name}: every packet is exercised`).toBe(
    trace.packets.length,
  );
}

describe("latest-wins level state (FR-7.11)", () => {
  test("[FR-7.11] latest level state wins over an older packet", () => {
    const mapper = new InputMapper();
    mapper.apply(
      1,
      packet({ tick: 100, buttons: 1, lx: 32767, lt: 255 }),
      0,
    );
    mapper.apply(
      1,
      packet({ tick: 90, buttons: 2, lx: -32767, lt: 0 }),
      1,
    );

    const player = pollPlayer(mapper);
    expect(player.buttons).toBe(1);
    expect(player.lx).toBeCloseTo(1, 5);
    expect(player.triggers.lt).toBeCloseTo(1, 5);
    expect(player.tick).toBe(100);
  });

  test("[FR-7.11] a packet with an equal tick updates level state", () => {
    const mapper = new InputMapper();
    mapper.apply(1, packet({ tick: 100, buttons: 1 }), 0);
    mapper.apply(1, packet({ tick: 100, buttons: 4 }), 1);
    expect(pollPlayer(mapper).buttons).toBe(4);
  });

  test("[FR-7.11] tick comparison is wrap-safe near the u32 boundary", () => {
    const mapper = new InputMapper();
    mapper.apply(1, packet({ tick: 0xfffffffe, buttons: 1 }), 0);
    mapper.apply(1, packet({ tick: 1, buttons: 2 }), 1);
    mapper.apply(1, packet({ tick: 0xffffff00, buttons: 4 }), 2);

    const player = pollPlayer(mapper);
    expect(player.buttons).toBe(2);
    expect(player.tick).toBe(1);
  });

  test("[FR-7.11] tick comparison rejects a just-older tick near zero", () => {
    const mapper = new InputMapper();
    mapper.apply(1, packet({ tick: 2, buttons: 1 }), 0);
    mapper.apply(1, packet({ tick: 1, buttons: 2 }), 1);
    expect(pollPlayer(mapper).buttons).toBe(1);
  });

  test("[FR-7.11] reset clears one slot or all slots without replacing objects", () => {
    const mapper = new InputMapper();
    mapper.apply(1, packet({ tick: 1, buttons: 1, edges: 1 }), 0);
    mapper.apply(2, packet({ tick: 1, buttons: 2, edges: 2 }), 0);
    const firstSlot = pollPlayer(mapper);

    mapper.reset(1);
    const secondSlot = pollPlayer(mapper, 2, 2);
    expect(secondSlot.buttons).toBe(2);
    expect(mapper.getSlot(1)?.buttons).toBe(0);
    expect(mapper.getSlot(1)?.edges).toBe(0);
    expect(mapper.getSlot(1)).toBe(firstSlot);

    mapper.reset();
    expect(mapper.getSlot(1)?.buttons).toBe(0);
    expect(mapper.getSlot(2)?.buttons).toBe(0);
  });

  test("[FR-7.11] out-of-range slots are ignored and counted as drops", () => {
    const mapper = new InputMapper({ slots: 4 });
    mapper.apply(0, packet({ tick: 1, buttons: 1, edges: 1 }), 0);
    mapper.apply(5, packet({ tick: 1, buttons: 1, edges: 1 }), 0);

    const snapshot = mapper.pollAll(1);
    expect(snapshot.players).toHaveLength(4);
    expect(snapshot.players[0]?.buttons).toBe(0);
    expect(mapper.getStats(0).drops).toBe(2);
    expect(mapper.getStats(1).drops).toBe(0);
  });

  test("[FR-7.11] stats report last input age, packet rate and drops", () => {
    const mapper = new InputMapper();
    const now = performance.now();
    mapper.apply(1, packet({ tick: 1 }), now - 800);
    mapper.apply(1, packet({ tick: 2 }), now - 500);
    mapper.apply(1, packet({ tick: 3 }), now - 100);

    const stats = mapper.getStats(1);
    expect(stats.lastInputAgeMs).toBeGreaterThanOrEqual(100);
    expect(stats.lastInputAgeMs).toBeLessThan(500);
    expect(stats.packetsPerSecond).toBe(3);
    expect(stats.drops).toBe(0);

    const untouched = mapper.getStats(2);
    expect(untouched.lastInputAgeMs).toBe(-1);
    expect(untouched.packetsPerSecond).toBe(0);
  });
});

describe("accumulated edges (FR-7.12)", () => {
  test("[FR-7.12] edges OR-accumulate across packets and clear exactly once on poll", () => {
    const mapper = new InputMapper();
    mapper.apply(1, packet({ tick: 1, edges: 1 }), 0);
    mapper.apply(1, packet({ tick: 2, edges: 2 }), 1);
    mapper.apply(1, packet({ tick: 3, edges: 4 }), 2);

    expect(pollPlayer(mapper, 1, 1).edges).toBe(7);
    expect(pollPlayer(mapper, 1, 2).edges).toBe(0);

    mapper.apply(1, packet({ tick: 4, edges: 8 }), 3);
    expect(pollPlayer(mapper, 1, 3).edges).toBe(8);
    expect(pollPlayer(mapper, 1, 4).edges).toBe(0);
  });

  test("[FR-7.12] a stale packet still contributes its press edge", () => {
    const mapper = new InputMapper();
    mapper.apply(1, packet({ tick: 10, buttons: 0, edges: 0 }), 0);
    mapper.apply(1, packet({ tick: 5, buttons: 1, edges: 2 }), 1);

    const player = pollPlayer(mapper);
    expect(player.buttons).toBe(0);
    expect(player.edges).toBe(2);
  });

  test("[FR-7.12] eight slots default and never cross-contaminate", () => {
    const mapper = new InputMapper();
    mapper.apply(
      8,
      packet({ tick: 1, buttons: 128, edges: 128, lx: 32767 }),
      0,
    );

    const snapshot = mapper.pollAll(1);
    expect(snapshot.players).toHaveLength(8);
    expect(snapshot.players[7]?.buttons).toBe(128);
    expect(snapshot.players[7]?.edges).toBe(128);
    expect(snapshot.players[0]?.buttons).toBe(0);
    expect(snapshot.players[0]?.lx).toBe(0);
  });
});

describe("sub-tick taps (FR-7.3)", () => {
  test("[FR-7.3] a sub-tick tap survives as an edge with level zero", () => {
    const mapper = new InputMapper();
    mapper.apply(1, packet({ tick: 1, buttons: 1, edges: 1 }), 0);
    mapper.apply(1, packet({ tick: 2, buttons: 0, edges: 0 }), 1);

    const player = pollPlayer(mapper);
    expect(player.buttons).toBe(0);
    expect(player.edges).toBe(1);
    expect(pollPlayer(mapper, 1, 2).edges).toBe(0);
  });
});

describe("analog units and deadzone (FR-7.4)", () => {
  test("[FR-7.4] wire axes, triggers and gyro are converted to SPEC units", () => {
    const mapper = new InputMapper();
    mapper.apply(
      1,
      packet({
        tick: 1,
        lx: 32767,
        ly: -32768,
        rx: 16384,
        lt: 255,
        rt: 0,
        gx: 100,
        gy: -50,
      }),
      0,
    );

    const player = pollPlayer(mapper);
    expect(player.lx).toBe(1);
    expect(player.ly).toBe(-1);
    expect(player.rx).toBeCloseTo(16384 / 32767, 4);
    expect(player.triggers.lt).toBe(1);
    expect(player.triggers.rt).toBe(0);
    expect(player.gyro.x).toBeCloseTo(10, 5);
    expect(player.gyro.y).toBeCloseTo(-5, 5);
  });

  test("[FR-7.4] host deadzone is configurable and radial per stick", () => {
    const open = new InputMapper();
    open.apply(
      1,
      packet({ tick: 1, lx: 10000, ly: 10000, rx: 30000 }),
      0,
    );
    const openPlayer = pollPlayer(open);
    expect(openPlayer.lx).toBeCloseTo(10000 / 32767, 5);
    expect(openPlayer.rx).toBeCloseTo(30000 / 32767, 5);

    const filtered = new InputMapper({ deadzone: 0.5 });
    filtered.apply(
      1,
      packet({ tick: 1, lx: 10000, ly: 10000, rx: 30000 }),
      0,
    );
    const filteredPlayer = pollPlayer(filtered);
    expect(filteredPlayer.lx).toBe(0);
    expect(filteredPlayer.ly).toBe(0);
    expect(filteredPlayer.rx).toBeCloseTo(30000 / 32767, 5);

    // Polling again must not push a surviving axis through the cutoff twice.
    expect(pollPlayer(filtered, 1, 2).rx).toBeCloseTo(30000 / 32767, 5);
  });

  test("[FR-7.4][FR-7.11] mapper options are validated", () => {
    expect(() => new InputMapper({ slots: 0 })).toThrow(RangeError);
    expect(() => new InputMapper({ slots: 9 })).toThrow(RangeError);
    expect(() => new InputMapper({ deadzone: 1.5 })).toThrow(RangeError);
    expect(() => new InputMapper({ deadzone: -0.1 })).toThrow(RangeError);
  });
});

describe("controller connectivity (FR-8.2, FR-7.12, FR-5.4)", () => {
  test("[FR-8.2] a tick-0 all-zero packet marks the slot connected", () => {
    const mapper = new InputMapper();
    expect(pollPlayer(mapper, 1, 1).connected).toBe(false);
    expect(pollPlayer(mapper, 2, 1).connected).toBe(false);

    // A phone's first Input arrives before clock sync: tick 0, all zeros.
    // Presence must come from the packet, not from its decoded values.
    mapper.apply(1, packet({ tick: 0 }), 0);

    const player = pollPlayer(mapper, 1, 2);
    expect(player.connected).toBe(true);
    expect(player.tick).toBe(0);
    expect(player.buttons).toBe(0);
    expect(player.edges).toBe(0);
    expect(pollPlayer(mapper, 2, 2).connected).toBe(false);
  });

  test("[FR-7.12] an all-zero packet marks connected without inventing edges", () => {
    const mapper = new InputMapper();
    mapper.apply(1, packet({ tick: 0, edges: 0 }), 0);
    const player = pollPlayer(mapper);
    expect(player.connected).toBe(true);
    expect(player.edges).toBe(0);
  });

  test("[FR-5.4][FR-8.2] reset clears connectivity for one slot or all slots", () => {
    const mapper = new InputMapper();
    mapper.apply(1, packet({ tick: 0 }), 0);
    mapper.apply(2, packet({ tick: 0 }), 0);
    expect(pollPlayer(mapper, 1, 1).connected).toBe(true);

    mapper.reset(1);
    mapper.pollAll(2);
    expect(mapper.getSlot(1)?.connected).toBe(false);
    expect(mapper.getSlot(2)?.connected).toBe(true);

    mapper.reset();
    expect(mapper.getSlot(2)?.connected).toBe(false);
  });
});

describe("game-facing contract (FR-7.17, PR-9.3)", () => {
  test("[FR-7.17] game-facing state exposes ControllerState fields only", () => {
    const mapper = new InputMapper();
    mapper.apply(1, packet({ tick: 7, buttons: 1, edges: 1, lx: 32767 }), 0);
    const snapshot = mapper.pollAll(1);

    expect(Object.keys(snapshot).sort()).toEqual(["players", "tick"]);
    const player = snapshot.players[0];
    expect(player).toBeDefined();
    if (player === undefined) {
      return;
    }
    expect(Object.keys(player).sort()).toEqual([
      "buttons",
      "connected",
      "edges",
      "gyro",
      "gyroActive",
      "gyroRecentered",
      "lx",
      "ly",
      "rx",
      "ry",
      "slot",
      "tick",
      "tilt",
      "triggers",
    ]);
    expect(Object.keys(player.gyro).sort()).toEqual(["x", "y", "z"]);
    expect(Object.keys(player.triggers).sort()).toEqual(["lt", "rt"]);

    const surface = player as unknown as Record<string, unknown>;
    expect(surface["socket"]).toBeUndefined();
    expect(surface["packet"]).toBeUndefined();
    expect(typeof surface["apply"]).not.toBe("function");
  });

  test("[PR-9.3] pollAll reuses the snapshot and player objects", () => {
    const mapper = new InputMapper();
    mapper.apply(1, packet({ tick: 1, buttons: 1, edges: 1 }), 0);
    const first = mapper.pollAll(1);
    const firstPlayers = first.players;
    const firstPlayer = first.players[0];

    for (let tick = 2; tick <= 120; tick += 1) {
      mapper.apply(
        1,
        packet({ tick, buttons: tick % 2, edges: tick % 4 === 0 ? 2 : 0 }),
        tick,
      );
      const snapshot = mapper.pollAll(tick);
      expect(snapshot).toBe(first);
      expect(snapshot.players).toBe(firstPlayers);
      expect(snapshot.players[0]).toBe(firstPlayer);
    }
    expect(mapper.getSlot(1)).toBe(firstPlayer);
  });
});

describe("golden traces (§16)", () => {
  test("[FR-7.3] golden trace: sub-tick tap produces an edge at the next poll", () => {
    runTrace("sub-tick-tap");
  });

  test("[FR-7.12] golden trace: two packets in one tick preserve both edges", () => {
    runTrace("two-presses-one-tick");
  });

  test("[FR-7.11] golden trace: stale level packet is ignored but its edge is kept", () => {
    runTrace("stale-packet");
  });

  test("[FR-7.12] golden trace: a held button reports one edge and a stable level", () => {
    runTrace("press-and-hold");
  });

  test("[FR-7.11] golden trace: eight slots stay independent", () => {
    runTrace("eight-slots");
  });

  test("[FR-7.11] golden trace: tick comparison is wrap-safe near 2^32", () => {
    runTrace("wrap-tick");
  });
});
