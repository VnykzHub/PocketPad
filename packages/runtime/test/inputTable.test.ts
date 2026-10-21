import { describe, expect, test } from "vitest";
import {
  createSlotSnapshot,
  formatBits,
  formatSlotCells,
  type SlotSnapshot,
} from "../src/debug/inputTable";

function liveSnapshot(): SlotSnapshot {
  return {
    ...createSlotSnapshot(1),
    joined: true,
    buttons: 0x0001,
    edges: 0x8000,
    lx: -32768,
    ly: 32767,
    rx: 0,
    ry: -1,
    lt: 255,
    rt: 0,
    tick: 1234,
    receivedAt: 1000,
  };
}

describe("slot row formatter (D0-RT-01)", () => {
  test("[FR-7.2] renders button level and edge bitfields as four-digit hex", () => {
    const cells = formatSlotCells(liveSnapshot(), 1000);
    expect(cells.buttons).toBe("0x0001");
    expect(cells.edges).toBe("0x8000");
    expect(formatBits(0)).toBe("0x0000");
    expect(formatBits(0xffff)).toBe("0xFFFF");
    expect(formatBits(-1)).toBe("0xFFFF");
  });

  test("[FR-7.3] keeps a press edge visible when the level is already zero", () => {
    const snapshot: SlotSnapshot = {
      ...liveSnapshot(),
      buttons: 0,
      edges: 0x0001,
    };
    const cells = formatSlotCells(snapshot, 1000);
    expect(cells.buttons).toBe("0x0000");
    expect(cells.edges).toBe("0x0001");
  });

  test("[FR-7.4] renders analog axes and triggers as wire values", () => {
    const cells = formatSlotCells(liveSnapshot(), 1000);
    expect(cells.left).toBe("-32768, 32767");
    expect(cells.right).toBe("0, -1");
    expect(cells.triggers).toBe("255 / 0");
  });

  test("[A3] renders the slot, live age and raw server-time tick", () => {
    const cells = formatSlotCells(liveSnapshot(), 1250);
    expect(cells.slot).toBe("P1");
    expect(cells.status).toBe("Live");
    expect(cells.age).toBe("250 ms");
    expect(cells.tick).toBe("1234");
  });

  test("[FR-7.2] marks empty and joined-but-silent slots without inventing input", () => {
    const empty = formatSlotCells(createSlotSnapshot(3), 500);
    expect(empty.slot).toBe("P3");
    expect(empty.status).toBe("—");
    expect(empty.buttons).toBe("0x0000");
    expect(empty.age).toBe("—");
    expect(empty.tick).toBe("—");

    const joined = formatSlotCells(
      { ...createSlotSnapshot(2), joined: true },
      500,
    );
    expect(joined.status).toBe("Joined");
    expect(joined.age).toBe("—");
  });

  test("[A3] clamps a negative clock difference to zero", () => {
    const cells = formatSlotCells(liveSnapshot(), 900);
    expect(cells.age).toBe("0 ms");
  });
});
