/**
 * Golden trace runner (D2-QA-01).
 *
 * A trace is JSON data, so a recorded session can be replayed through the
 * D2-RT-01 `InputMapper` with no phone, socket or real clock:
 *
 * ```json
 * {
 *   "name": "sub-tick-tap",
 *   "hostTickHz": 60,
 *   "covers": ["FR-7.3"],
 *   "mapper": { "deadzone": 0.08 },
 *   "packets": [{ "atMs": 10, "slot": 1, "tick": 100000, "buttons": 0, "edges": 1 }],
 *   "polls": [{ "hostTick": 1, "expect": { "buttons": 0, "edges": 1 } }]
 * }
 * ```
 *
 * Replay rules, matching the host runtime:
 * - packets are applied in `atMs` order once their send time is at or before
 *   `hostTick * 1000 / hostTickHz`;
 * - every poll for one host tick reads the single `pollAll(hostTick)` result,
 *   because the runtime polls exactly once per simulation tick;
 * - `expect` names use the game-facing `ControllerState` units, and analog
 *   fields compare to three decimal places.
 *
 * The runner is generic so D7's recorded game traces reuse it unchanged
 * (FR-7.17: games replay data, never sockets).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { InputState } from "@lanpad/protocol";
import { InputMapper } from "../../src/input/InputMapper";
import type {
  ControllerState,
  InputMapperOptions,
  InputSnapshot,
} from "../../src/input/types";

export interface TracePacket {
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

export interface TracePoll {
  hostTick: number;
  /** Slot under test; defaults to 1. */
  slot?: number;
  expect: Record<string, number>;
}

/** Optional `InputMapper` constructor options for a trace. */
export interface TraceMapperOptions {
  deadzone?: number;
  slots?: number;
}

export interface TraceFixture {
  name: string;
  description?: string;
  hostTickHz: number;
  /** Requirement IDs this trace exercises; documentation for reviewers. */
  covers?: string[];
  mapper?: TraceMapperOptions;
  packets: TracePacket[];
  polls: TracePoll[];
}

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

const EXPECTED_FIELDS = new Set([
  "slot",
  "buttons",
  "edges",
  "lx",
  "ly",
  "rx",
  "ry",
  "gx",
  "gy",
  "gz",
  "lt",
  "rt",
  "tick",
]);

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requireNumber(
  source: Record<string, unknown>,
  field: string,
  context: string,
): number {
  const value = source[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${context}.${field} must be a finite number.`);
  }
  return value;
}

function optionalNumber(
  source: Record<string, unknown>,
  field: string,
  context: string,
): number | undefined {
  const value = source[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${context}.${field} must be a finite number.`);
  }
  return value;
}

function parsePacket(value: unknown, context: string): TracePacket {
  const source = asObject(value, context);
  const atMs = requireNumber(source, "atMs", context);
  const slot = requireNumber(source, "slot", context);
  const tick = requireNumber(source, "tick", context);
  if (atMs < 0) {
    throw new Error(`${context}.atMs must be >= 0.`);
  }
  if (!Number.isInteger(slot) || slot < 1 || slot > 8) {
    throw new Error(`${context}.slot must be an integer in 1..8.`);
  }

  const packet: TracePacket = { atMs, slot, tick };
  for (const field of [
    "buttons",
    "edges",
    "lx",
    "ly",
    "rx",
    "ry",
    "gx",
    "gy",
    "gz",
    "lt",
    "rt",
    "flags",
  ] as const) {
    const parsed = optionalNumber(source, field, context);
    if (parsed !== undefined) {
      packet[field] = parsed;
    }
  }
  return packet;
}

function parsePoll(value: unknown, context: string): TracePoll {
  const source = asObject(value, context);
  const hostTick = requireNumber(source, "hostTick", context);
  if (!Number.isInteger(hostTick) || hostTick < 0) {
    throw new Error(`${context}.hostTick must be a non-negative integer.`);
  }

  const expectations = asObject(source["expect"], `${context}.expect`);
  const fields = Object.keys(expectations);
  if (fields.length === 0) {
    throw new Error(`${context}.expect must name at least one field.`);
  }
  for (const field of fields) {
    if (!EXPECTED_FIELDS.has(field)) {
      throw new Error(`${context}.expect.${field} is not a ControllerState field.`);
    }
    requireNumber(expectations, field, `${context}.expect`);
  }

  const poll: TracePoll = {
    hostTick,
    expect: expectations as Record<string, number>,
  };
  const slot = optionalNumber(source, "slot", context);
  if (slot !== undefined) {
    if (!Number.isInteger(slot) || slot < 1 || slot > 8) {
      throw new Error(`${context}.slot must be an integer in 1..8.`);
    }
    poll.slot = slot;
  }
  return poll;
}

function parseMapperOptions(value: unknown, context: string): TraceMapperOptions {
  const source = asObject(value, context);
  const options: TraceMapperOptions = {};
  const deadzone = optionalNumber(source, "deadzone", context);
  if (deadzone !== undefined) {
    options.deadzone = deadzone;
  }
  const slots = optionalNumber(source, "slots", context);
  if (slots !== undefined) {
    options.slots = slots;
  }
  return options;
}

/** Parses and validates one trace document. */
export function parseTrace(text: string, sourceName: string): TraceFixture {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${sourceName}: invalid JSON (${String(error)}).`);
  }

  const source = asObject(raw, sourceName);
  const name = source["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`${sourceName}: name must be a non-empty string.`);
  }
  const hostTickHz = requireNumber(source, "hostTickHz", sourceName);
  if (hostTickHz <= 0) {
    throw new Error(`${sourceName}: hostTickHz must be > 0.`);
  }

  const rawPackets = source["packets"];
  const rawPolls = source["polls"];
  if (!Array.isArray(rawPackets) || rawPackets.length === 0) {
    throw new Error(`${sourceName}: packets must be a non-empty array.`);
  }
  if (!Array.isArray(rawPolls) || rawPolls.length === 0) {
    throw new Error(`${sourceName}: polls must be a non-empty array.`);
  }

  const packets = rawPackets.map((packet, index) =>
    parsePacket(packet, `${sourceName}.packets[${index}]`),
  );
  const polls = rawPolls.map((poll, index) =>
    parsePoll(poll, `${sourceName}.polls[${index}]`),
  );

  for (let index = 1; index < packets.length; index += 1) {
    const previous = packets[index - 1];
    const current = packets[index];
    if (previous !== undefined && current !== undefined && current.atMs < previous.atMs) {
      throw new Error(`${sourceName}: packets must be sorted by atMs.`);
    }
  }
  for (let index = 1; index < polls.length; index += 1) {
    const previous = polls[index - 1];
    const current = polls[index];
    if (previous !== undefined && current !== undefined && current.hostTick < previous.hostTick) {
      throw new Error(`${sourceName}: polls must be sorted by hostTick.`);
    }
  }

  const fixture: TraceFixture = { name, hostTickHz, packets, polls };
  const description = source["description"];
  if (typeof description === "string") {
    fixture.description = description;
  }
  const covers = source["covers"];
  if (Array.isArray(covers) && covers.every((id) => typeof id === "string")) {
    fixture.covers = covers as string[];
  }
  const mapper = source["mapper"];
  if (mapper !== undefined) {
    fixture.mapper = parseMapperOptions(mapper, `${sourceName}.mapper`);
  }
  return fixture;
}

/**
 * Loads every `*.json` trace in `directory`, sorted by file name. File name
 * and `name` must agree and names must be unique so a failure names one trace.
 */
export function loadTraceFixtures(directory: string): TraceFixture[] {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort();

  const names = new Set<string>();
  return files.map((file) => {
    const fixture = parseTrace(
      readFileSync(join(directory, file), "utf8"),
      file,
    );
    const stem = file.slice(0, -".json".length);
    if (fixture.name !== stem) {
      throw new Error(`${file}: name "${fixture.name}" must match the file name.`);
    }
    if (names.has(fixture.name)) {
      throw new Error(`${file}: duplicate trace name "${fixture.name}".`);
    }
    names.add(fixture.name);
    return fixture;
  });
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

function readField(player: ControllerState, field: string): number | undefined {
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
  fixture: TraceFixture,
  snapshot: InputSnapshot,
  poll: TracePoll,
): void {
  const slot = poll.slot ?? 1;
  const player = snapshot.players[slot - 1];
  expect(player, `${fixture.name}: slot ${slot} is missing`).toBeDefined();
  if (player === undefined) {
    return;
  }

  for (const [field, expected] of Object.entries(poll.expect)) {
    const actual = readField(player, field);
    const label = `${fixture.name}: poll ${poll.hostTick}, slot ${slot}, ${field}`;
    if (ANALOG_FIELDS.has(field)) {
      expect(actual, label).toBeCloseTo(expected, 3);
    } else {
      expect(actual, label).toBe(expected);
    }
  }
}

/** Replays one trace through a fresh `InputMapper`. Throws on any mismatch. */
export function replayTrace(fixture: TraceFixture): void {
  const mapperOptions: InputMapperOptions = fixture.mapper ?? {};
  const mapper = new InputMapper(mapperOptions);

  let nextPacket = 0;
  let pollIndex = 0;

  while (pollIndex < fixture.polls.length) {
    const firstPoll = fixture.polls[pollIndex];
    if (firstPoll === undefined) {
      break;
    }
    const pollAtMs = (firstPoll.hostTick * 1000) / fixture.hostTickHz;

    while (nextPacket < fixture.packets.length) {
      const packet = fixture.packets[nextPacket];
      if (packet === undefined || packet.atMs > pollAtMs) {
        break;
      }
      mapper.apply(packet.slot, toInputState(packet), packet.atMs);
      nextPacket += 1;
    }

    const snapshot = mapper.pollAll(firstPoll.hostTick);
    while (pollIndex < fixture.polls.length) {
      const poll = fixture.polls[pollIndex];
      if (poll === undefined || poll.hostTick !== firstPoll.hostTick) {
        break;
      }
      assertPoll(fixture, snapshot, poll);
      pollIndex += 1;
    }
  }

  expect(nextPacket, `${fixture.name}: every packet is exercised`).toBe(
    fixture.packets.length,
  );
}
