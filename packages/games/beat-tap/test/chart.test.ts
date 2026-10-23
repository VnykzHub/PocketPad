/**
 * Beat Tap chart-pack schema (GAME-BT-DATA-01/02; G8, FR-10.3).
 *
 * Charts are untrusted data. The tests validate the shipped pack and then
 * mutate a deep copy to prove each rule is enforced by the pure validator that
 * `init` runs before a round can start.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  chartById,
  firstChart,
  validateChartPack,
  type ChartPack,
} from "../src/chart.js";

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("chart fixture must be an object");
  }
  return value as Record<string, unknown>;
}

const shipped = readJson("../packs/charts-demo-v1.json");

function cloneShipped(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(shipped)) as Record<string, unknown>;
}

function firstItem(pack: Record<string, unknown>): Record<string, unknown> {
  const items = pack["items"];
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("chart fixture must have one item");
  }
  return asRecord(items[0]);
}

function notesOf(pack: Record<string, unknown>): Record<string, unknown>[] {
  const notes = firstItem(pack)["notes"];
  if (!Array.isArray(notes)) {
    throw new Error("chart fixture notes must be an array");
  }
  return notes.map((note) => asRecord(note));
}

describe("Beat Tap chart pack", () => {
  test("[G8] the shipped pack validates and is self-authored CC0 data", () => {
    const result = validateChartPack(shipped);
    expect(result.ok, result.ok ? "" : result.errors.join("\n")).toBe(true);
    if (!result.ok) {
      return;
    }
    const pack: ChartPack = result.pack;
    expect(pack.type).toBe("chart");
    expect(pack.license).toBe("CC0-1.0");
    expect(pack.items).toHaveLength(1);

    const item = pack.items[0];
    if (item === undefined) {
      throw new Error("shipped pack has no chart");
    }
    expect(item.id).toBe("demo-120bpm");
    expect(item.title).toBe("Demo 120");
    expect(item.bpm).toBe(120);
    expect(item.offsetMs).toBe(0);
    expect(item.durationMs).toBe(34000);
    expect(item.notes.length).toBeGreaterThan(0);

    const last = item.notes[item.notes.length - 1];
    expect(last?.timeMs).toBeLessThanOrEqual(item.durationMs);
    for (let index = 1; index < item.notes.length; index += 1) {
      const previous = item.notes[index - 1];
      const note = item.notes[index];
      if (previous !== undefined && note !== undefined) {
        expect(note.timeMs, `note ${index}`).toBeGreaterThanOrEqual(previous.timeMs);
      }
    }

    const provenance = asRecord(shipped)["provenance"];
    expect(typeof provenance).toBe("string");
    expect(provenance).toContain("no third-party");
  });

  test("[G8] chart lookup is by id and falls back to the first chart", () => {
    const result = validateChartPack(shipped);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(firstChart(result.pack).id).toBe("demo-120bpm");
    expect(chartById(result.pack, "demo-120bpm")?.title).toBe("Demo 120");
    expect(chartById(result.pack, "missing")).toBeNull();
  });

  test("[G8] pack metadata is validated: type, license, ids and item count", () => {
    const pack = cloneShipped();
    pack["type"] = "song";
    pack["license"] = "";
    pack["items"] = [];
    const result = validateChartPack(pack);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const errors = result.errors.join("\n");
    expect(errors).toContain('type: must be "chart"');
    expect(errors).toContain("license: must be 1..64 characters");
    expect(errors).toContain("items: must contain 1..32 charts");
    expect(validateChartPack(null).ok).toBe(false);
  });

  test("[G8] unsorted notes are rejected", () => {
    const pack = cloneShipped();
    const notes = notesOf(pack);
    const second = notes[1];
    if (second !== undefined) {
      second["timeMs"] = 1500;
    }
    const result = validateChartPack(pack);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.join("\n")).toContain("notes must be ordered by time");
  });

  test("[G8] lanes outside 0..3 and times past the duration are rejected", () => {
    const lanePack = cloneShipped();
    const laneNote = notesOf(lanePack)[0];
    if (laneNote !== undefined) {
      laneNote["lane"] = 4;
    }
    const laneResult = validateChartPack(lanePack);
    expect(laneResult.ok).toBe(false);
    if (!laneResult.ok) {
      expect(laneResult.errors.join("\n")).toContain("lane: must be an integer 0..3");
    }

    const timePack = cloneShipped();
    const timeNotes = notesOf(timePack);
    const last = timeNotes[timeNotes.length - 1];
    if (last !== undefined) {
      last["timeMs"] = 35000;
    }
    const timeResult = validateChartPack(timePack);
    expect(timeResult.ok).toBe(false);
    if (!timeResult.ok) {
      expect(timeResult.errors.join("\n")).toContain("timeMs: must be an integer 0..34000");
    }
  });

  test("[G8] duplicate notes on one lane are rejected; chords across lanes are legal", () => {
    // The shipped pack already has chords (12000 ms on lanes 0 and 2).
    expect(validateChartPack(cloneShipped()).ok).toBe(true);

    const duplicate = cloneShipped();
    const notes = notesOf(duplicate);
    const second = notes[1];
    if (second !== undefined) {
      second["timeMs"] = 2000;
      second["lane"] = 0;
    }
    const result = validateChartPack(duplicate);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.join("\n")).toContain(
      "duplicate note at the same time and lane",
    );
  });

  test("[G8] timing metadata is range-checked in one pass", () => {
    const pack = cloneShipped();
    const item = firstItem(pack);
    item["bpm"] = 0;
    item["offsetMs"] = 9000;
    item["durationMs"] = 12.5;
    const result = validateChartPack(pack);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toHaveLength(3);
    const errors = result.errors.join("\n");
    expect(errors).toContain("bpm");
    expect(errors).toContain("offsetMs");
    expect(errors).toContain("durationMs");
  });
});
