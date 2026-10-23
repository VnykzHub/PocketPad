import { describe, expect, test } from "vitest";
import {
  ConsoleStartGate,
  START_GATE_HINT,
  START_GATE_PROMPT,
} from "../../src/ui/console/startGate.js";
import {
  FakeDocument,
  FakeElement,
  asDocument,
  keyEvent,
  textOf,
} from "./fakeDom.js";

function fake(value: unknown): FakeElement {
  return value as FakeElement;
}

function setup(
  options: {
    onStart?: () => void;
    unlockAudio?: () => Promise<void>;
  } = {},
): {
  doc: FakeDocument;
  gate: ConsoleStartGate;
  starts: () => number;
  unlocks: () => number;
} {
  const doc = new FakeDocument();
  let starts = 0;
  let unlocks = 0;
  const gate = new ConsoleStartGate(asDocument(doc), {
    onStart: () => {
      starts += 1;
      options.onStart?.();
    },
    unlockAudio: () => {
      unlocks += 1;
      return options.unlockAudio?.() ?? Promise.resolve();
    },
  });
  return {
    doc,
    gate,
    starts: () => starts,
    unlocks: () => unlocks,
  };
}

describe("console start gate", () => {
  test("[ER-25-04] any key starts the launcher exactly once", async () => {
    const { doc, gate, starts } = setup();
    const event = doc.defaultView.dispatch("keydown", { key: "a" });
    // The gate awaits the audio unlock before reporting start.
    await Promise.resolve();
    expect(starts()).toBe(1);
    expect(event.defaultPrevented).toBe(true);
    expect(gate.started).toBe(true);

    doc.defaultView.dispatch("keydown", { key: "b" });
    expect(starts()).toBe(1);
    expect(gate.handleKey(keyEvent("c") as unknown as KeyboardEvent)).toBe(
      false,
    );
  });

  test("[ER-25-04] Tab, Escape, modifiers and auto-repeat do not start", () => {
    const { doc, gate, starts, unlocks } = setup();
    for (const key of ["Tab", "Escape", "Shift", "Control", "Alt", "Meta"]) {
      expect(gate.handleKey(keyEvent(key) as unknown as KeyboardEvent)).toBe(
        false,
      );
    }
    doc.defaultView.dispatch("keydown", { key: "a", repeat: true });
    expect(starts()).toBe(0);
    expect(unlocks()).toBe(0);
  });

  test("[ER-25-04] the gate waits for the audio unlock before reporting start", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const doc = new FakeDocument();
    const gate = new ConsoleStartGate(asDocument(doc), {
      onStart: () => order.push("start"),
      unlockAudio: () => {
        order.push("unlock");
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });

    doc.defaultView.dispatch("keydown", { key: " " });
    expect(order).toEqual(["unlock"]);

    release();
    await gate.activate("keyboard");
    expect(order).toEqual(["unlock", "start"]);
  });

  test("[ER-25-04] a failed audio unlock still starts (silent fallback)", async () => {
    const { gate, starts } = setup({
      unlockAudio: () => Promise.reject(new Error("audio blocked")),
    });
    await gate.activate("keyboard");
    expect(starts()).toBe(1);
    expect(gate.started).toBe(true);
  });

  test("[ER-25-04] pointer, button and programmatic starts share one path", async () => {
    const first = setup();
    fake(first.gate.element).dispatch("pointerdown");
    await Promise.resolve();
    expect(first.starts()).toBe(1);

    const second = setup();
    fake(second.gate.primaryButton).click();
    await Promise.resolve();
    expect(second.starts()).toBe(1);

    const third = setup();
    await third.gate.activate("pointer");
    expect(third.starts()).toBe(1);
    expect(third.unlocks()).toBe(1);
  });

  test("[ER-25-04] destroy removes the keyboard listener, the click handler and the tree", () => {
    const { doc, gate, starts } = setup();
    doc.body.append(fake(gate.element));
    expect(doc.defaultView.listenerCount("keydown")).toBe(1);
    expect(fake(gate.primaryButton).listenerCount("click")).toBe(1);

    gate.destroy();
    expect(doc.defaultView.listenerCount("keydown")).toBe(0);
    expect(fake(gate.primaryButton).listenerCount("click")).toBe(0);
    expect(fake(gate.element).parent).toBeNull();

    doc.defaultView.dispatch("keydown", { key: "a" });
    expect(starts()).toBe(0);
  });

  test("[ER-25-04] focus lands on the single start action", () => {
    const { gate } = setup();
    gate.focus();
    expect(fake(gate.primaryButton).focused).toBe(true);
    expect(fake(gate.element).getAttribute("role")).toBe("dialog");
    expect(textOf(fake(gate.element), "console-gate__prompt")).toBe(
      START_GATE_PROMPT,
    );
    expect(textOf(fake(gate.element), "console-gate__hint")).toBe(
      START_GATE_HINT,
    );
  });
});
