// @vitest-environment jsdom
/**
 * HP-08 slot roster: eight stable rows, word-plus-colour state, live summary.
 * Requirement IDs resolve to existing TRACEABILITY rows (SR-6 eight
 * controllers, FR-5.4 slot reservation on reconnect); HP-08 is a page-plan
 * label, not a trace tag.
 */
import { afterEach, describe, expect, test } from "vitest";
import { MAX_CONTROLLERS } from "@lanpad/protocol";
import { SLOT_STATE_LABEL, SlotRoster } from "../src/ui/SlotRoster";

afterEach(() => {
  document.body.replaceChildren();
});

function rowOf(roster: SlotRoster, slot: number): Element | null {
  return roster.element.querySelector(`.slot-row[data-slot="${slot}"]`);
}

function stateText(roster: SlotRoster, slot: number): string | null | undefined {
  return rowOf(roster, slot)?.querySelector(".slot-row__state")?.textContent;
}

describe("SlotRoster (HP-08)", () => {
  test("[SR-6] always renders eight labelled rows, one per slot", () => {
    const roster = new SlotRoster(document);
    const rows = roster.element.querySelectorAll(".slot-row");

    expect(rows).toHaveLength(MAX_CONTROLLERS);
    expect(MAX_CONTROLLERS).toBe(8);

    Array.from(rows).forEach((row, index) => {
      expect(row.getAttribute("data-slot")).toBe(String(index + 1));
      expect(row.getAttribute("data-state")).toBe("open");
      expect(row.querySelector(".slot-row__name")?.textContent).toBe(
        `Player ${index + 1}`,
      );
      expect(row.querySelector(".slot-row__state")?.textContent).toBe(
        SLOT_STATE_LABEL.open,
      );
      // The hue swatch is decorative; the row's word carries the state.
      expect(
        row.querySelector(".slot-row__swatch")?.getAttribute("aria-hidden"),
      ).toBe("true");
    });
  });

  test("[SR-6] update writes the state as both data and a word", () => {
    const roster = new SlotRoster(document);
    roster.update([
      { slot: 1, state: "connected" },
      { slot: 3, state: "reconnecting" },
    ]);

    expect(rowOf(roster, 1)?.getAttribute("data-state")).toBe("connected");
    expect(stateText(roster, 1)).toBe("Connected");
    expect(rowOf(roster, 3)?.getAttribute("data-state")).toBe("reconnecting");
    expect(stateText(roster, 3)).toBe("Reconnecting");
    // A slot missing from the snapshot falls back to open.
    expect(rowOf(roster, 2)?.getAttribute("data-state")).toBe("open");
    expect(stateText(roster, 2)).toBe("Open");
  });

  test("[FR-5.4] a reserved slot shows reconnecting until the player returns", () => {
    const roster = new SlotRoster(document);
    roster.update([{ slot: 2, state: "connected" }]);
    expect(rowOf(roster, 2)?.getAttribute("data-state")).toBe("connected");

    // The 30 s reservation window: the slot is neither free nor connected.
    roster.update([{ slot: 2, state: "reconnecting" }]);
    expect(rowOf(roster, 2)?.getAttribute("data-state")).toBe("reconnecting");
    expect(stateText(roster, 2)).toBe("Reconnecting");

    roster.update([{ slot: 2, state: "connected" }]);
    expect(rowOf(roster, 2)?.getAttribute("data-state")).toBe("connected");
  });

  test("[SR-6] out-of-range slots are ignored and the summary counts players", () => {
    const roster = new SlotRoster(document);
    roster.mount(document.body);

    roster.update([
      { slot: 0, state: "connected" },
      { slot: 9, state: "connected" },
      { slot: 2, state: "connected" },
    ]);

    expect(rowOf(roster, 0)).toBeNull();
    expect(rowOf(roster, 9)).toBeNull();
    expect(rowOf(roster, 2)?.getAttribute("data-state")).toBe("connected");

    const summary = roster.element.querySelector('[role="status"]');
    expect(summary?.getAttribute("aria-live")).toBe("polite");
    expect(summary?.textContent).toBe("1 of 8 players connected");

    // Repeating the same snapshot must not churn the live region.
    roster.update([{ slot: 2, state: "connected" }]);
    expect(summary?.textContent).toBe("1 of 8 players connected");

    roster.update([
      { slot: 2, state: "connected" },
      { slot: 4, state: "connected" },
      { slot: 5, state: "reconnecting" },
    ]);
    expect(summary?.textContent).toBe(
      "2 of 8 players connected, 1 reconnecting",
    );
  });

  test("[SR-6] destroy removes the roster from the document", () => {
    const roster = new SlotRoster(document);
    roster.mount(document.body);
    expect(document.querySelector(".slot-roster")).not.toBeNull();

    roster.destroy();
    roster.destroy();

    expect(document.querySelector(".slot-roster")).toBeNull();
  });
});
