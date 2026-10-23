import type {
  GameEvent,
  GameEvents,
  GameLayouts,
  GamePanels,
  JsonValue,
  LayoutDocument,
} from "@lanpad/sdk";
import { validateLayout } from "@lanpad/sdk";
import { createFakeContext } from "@lanpad/sdk/testing";
import { describe, expect, it, vi } from "vitest";
import {
  KIT_CANVAS_EVENT,
  KIT_CHOICE_EVENT,
  KIT_TEXT_EVENT,
  clearPanel,
  onCanvas,
  onChoice,
  onText,
  showChoice,
  showText,
} from "../src/index.js";

interface Emitter {
  readonly events: GameEvents;
  emit(name: string, slot: number, data: JsonValue): void;
}

function createEmitter(): Emitter {
  const listeners = new Map<string, Set<(event: GameEvent) => void>>();
  return {
    events: {
      on(name, handler) {
        const set = listeners.get(name) ?? new Set();
        set.add(handler);
        listeners.set(name, set);
        return () => {
          set.delete(handler);
        };
      },
      onAny() {
        return () => {};
      },
    },
    emit(name, slot, data) {
      const set = listeners.get(name);
      if (set === undefined) {
        return;
      }
      for (const handler of [...set]) {
        handler({ slot, name, data });
      }
    },
  };
}

function makeContext(): {
  ctx: ReturnType<typeof createFakeContext>;
  emitter: Emitter;
  panelsSet: ReturnType<typeof vi.fn>;
  panelsClear: ReturnType<typeof vi.fn>;
  layoutsSet: ReturnType<typeof vi.fn>;
} {
  const emitter = createEmitter();
  const panelsSet = vi.fn();
  const panelsClear = vi.fn();
  const layoutsSet = vi.fn();
  const panels: GamePanels = { set: panelsSet, show: panelsSet, clear: panelsClear };
  const layouts: GameLayouts = { set: layoutsSet, clear: vi.fn() };
  return {
    ctx: createFakeContext({ events: emitter.events, panels, layouts }),
    emitter,
    panelsSet,
    panelsClear,
    layoutsSet,
  };
}

function choiceLayout(call: unknown[]): LayoutDocument {
  const layout = call[1] as LayoutDocument;
  const result = validateLayout(layout);
  expect(result.ok).toBe(true);
  return layout;
}

describe("panel and choice helpers (ER-24-06)", () => {
  it("hot-swaps a valid choice layout with the prompt", () => {
    const { ctx, panelsSet, layoutsSet } = makeContext();
    showChoice(
      ctx,
      2,
      [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
      ],
      "Pick one",
    );
    expect(layoutsSet).toHaveBeenCalledTimes(1);
    const call = layoutsSet.mock.calls[0] ?? [];
    expect(call[0]).toBe(2);
    const layout = choiceLayout(call);
    const control = layout.controls.find((entry) => entry.type === "choice");
    expect(control?.type).toBe("choice");
    if (control?.type !== "choice") {
      throw new Error("expected a choice control");
    }
    expect(control.event).toBe(KIT_CHOICE_EVENT);
    expect(control.options).toEqual([
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ]);
    expect(panelsSet).toHaveBeenCalledWith(2, { kind: "text", text: "Pick one" });
  });

  it("clears the prompt panel when no prompt is given", () => {
    const { ctx, panelsClear } = makeContext();
    showChoice(ctx, 1, [{ id: "a", label: "Alpha" }]);
    expect(panelsClear).toHaveBeenCalledWith(1);
  });

  it("sanitizes labels and falls back to the option id", () => {
    const { ctx, layoutsSet } = makeContext();
    showChoice(ctx, 1, [
      { id: "a", label: "Al\u0001pha" },
      { id: "b", label: "\u0002" },
    ]);
    const layout = choiceLayout(layoutsSet.mock.calls[0] ?? []);
    const control = layout.controls.find((entry) => entry.type === "choice");
    if (control?.type !== "choice") {
      throw new Error("expected a choice control");
    }
    expect(control.options[0]).toEqual({ value: "a", label: "Alpha" });
    expect(control.options[1]).toEqual({ value: "b", label: "b" });
  });

  it("ignores invalid choice arguments", () => {
    const { ctx, panelsSet, layoutsSet } = makeContext();
    const options = [{ id: "a", label: "Alpha" }];
    showChoice(ctx, 0, options);
    showChoice(ctx, 9, options);
    showChoice(ctx, 1, []);
    showChoice(
      ctx,
      1,
      Array.from({ length: 13 }, (_, index) => ({
        id: `o${index}`,
        label: `O${index}`,
      })),
    );
    showChoice(ctx, 1, [
      { id: "a", label: "A" },
      { id: "a", label: "B" },
    ]);
    showChoice(ctx, 1, [{ id: "", label: "A" }]);
    showChoice(ctx, 1, undefined as unknown as []);
    expect(layoutsSet).not.toHaveBeenCalled();
    expect(panelsSet).not.toHaveBeenCalled();
  });

  it("never throws when the host has no panel support", () => {
    const ctx = createFakeContext({
      layouts: {
        set() {
          throw new Error("unavailable");
        },
        clear() {
          throw new Error("unavailable");
        },
      },
      panels: {
        set() {
          throw new Error("unavailable");
        },
        show() {
          throw new Error("unavailable");
        },
        clear() {
          throw new Error("unavailable");
        },
      },
      events: {
        on() {
          throw new Error("unavailable");
        },
        onAny() {
          throw new Error("unavailable");
        },
      },
    });
    expect(() => showChoice(ctx, 1, [{ id: "a", label: "A" }])).not.toThrow();
    expect(() => showText(ctx, 1, { prompt: "Name?", maxLength: 10 })).not.toThrow();
    expect(() => clearPanel(ctx, 1)).not.toThrow();
    expect(() => onChoice(ctx, () => {})()).not.toThrow();
    expect(() => onText(ctx, () => {})()).not.toThrow();
    expect(() => onCanvas(ctx, () => {})()).not.toThrow();
  });

  it("hot-swaps a valid text layout with the prompt", () => {
    const { ctx, panelsSet, layoutsSet } = makeContext();
    showText(ctx, 3, { prompt: "Your name?", maxLength: 24 });
    const layout = choiceLayout(layoutsSet.mock.calls[0] ?? []);
    const control = layout.controls.find((entry) => entry.type === "text");
    if (control?.type !== "text") {
      throw new Error("expected a text control");
    }
    expect(control.event).toBe(KIT_TEXT_EVENT);
    expect(control.maxLen).toBe(24);
    expect(panelsSet).toHaveBeenCalledWith(3, {
      kind: "text",
      text: "Your name?",
    });
  });

  it("ignores invalid text prompts", () => {
    const { ctx, layoutsSet } = makeContext();
    showText(ctx, 0, { prompt: "x", maxLength: 10 });
    showText(ctx, 1, { prompt: "x", maxLength: 0 });
    showText(ctx, 1, { prompt: "x", maxLength: 201 });
    showText(ctx, 1, { prompt: "x", maxLength: 1.5 });
    showText(ctx, 1, null as unknown as { prompt: string; maxLength: number });
    expect(layoutsSet).not.toHaveBeenCalled();
  });

  it("clears valid panels and ignores invalid slots", () => {
    const { ctx, panelsClear } = makeContext();
    clearPanel(ctx, 1);
    clearPanel(ctx, 0);
    clearPanel(ctx, 9);
    expect(panelsClear).toHaveBeenCalledTimes(1);
    expect(panelsClear).toHaveBeenCalledWith(1);
  });

  it("delivers only well-formed choice events", () => {
    const { ctx, emitter } = makeContext();
    const seen: Array<[number, string]> = [];
    const unsubscribe = onChoice(ctx, (slot, optionId) => {
      seen.push([slot, optionId]);
    });
    emitter.emit(KIT_CHOICE_EVENT, 2, { value: "a" });
    emitter.emit(KIT_CHOICE_EVENT, 0, { value: "a" });
    emitter.emit(KIT_CHOICE_EVENT, 9, { value: "a" });
    emitter.emit(KIT_CHOICE_EVENT, 2, { value: 1 });
    emitter.emit(KIT_CHOICE_EVENT, 2, null);
    emitter.emit(KIT_CHOICE_EVENT, 2, ["a"]);
    emitter.emit(KIT_CHOICE_EVENT, 2, { value: null });
    expect(seen).toEqual([[2, "a"]]);
    unsubscribe();
    emitter.emit(KIT_CHOICE_EVENT, 2, { value: "b" });
    expect(seen).toHaveLength(1);
  });

  it("delivers only well-formed text events", () => {
    const { ctx, emitter } = makeContext();
    const seen: Array<[number, string]> = [];
    const unsubscribe = onText(ctx, (slot, text) => {
      seen.push([slot, text]);
    });
    emitter.emit(KIT_TEXT_EVENT, 1, { value: "hello" });
    emitter.emit(KIT_TEXT_EVENT, 1, { value: "" });
    emitter.emit(KIT_TEXT_EVENT, 1, { value: 3 });
    emitter.emit(KIT_TEXT_EVENT, 1, {});
    expect(seen).toEqual([
      [1, "hello"],
      [1, ""],
    ]);
    unsubscribe();
    emitter.emit(KIT_TEXT_EVENT, 1, { value: "later" });
    expect(seen).toHaveLength(2);
  });

  it("delivers only fully valid canvas strokes", () => {
    const { ctx, emitter } = makeContext();
    let received: JsonValue | null = null;
    const unsubscribe = onCanvas(ctx, (slot, data) => {
      expect(slot).toBe(4);
      received = data;
    });
    const stroke = {
      points: [{ x: 0.1, y: 0.2, t: 10 }],
      color: "#ff0",
      width: 3,
      phase: "start",
    };
    emitter.emit(KIT_CANVAS_EVENT, 4, stroke);
    expect(received).toBe(stroke);

    const invalid: unknown[] = [
      null,
      [],
      {},
      { points: [], color: "#fff", width: 1, phase: "start" },
      { points: [{ x: 2, y: 0, t: 0 }], color: "#fff", width: 1, phase: "start" },
      { points: [{ x: 0, y: -0.1, t: 0 }], color: "#fff", width: 1, phase: "start" },
      { points: [{ x: 0, y: 0, t: -1 }], color: "#fff", width: 1, phase: "start" },
      { points: [{ x: 0, y: 0, t: 0 }], color: "red", width: 1, phase: "start" },
      { points: [{ x: 0, y: 0, t: 0 }], color: "#fff", width: 0, phase: "start" },
      { points: [{ x: 0, y: 0, t: 0 }], color: "#fff", width: 1, phase: "done" },
      {
        points: [{ x: 0, y: 0, t: 0 }],
        color: "#fff",
        width: 1,
        phase: "start",
        count: 1.5,
      },
      {
        points: Array.from({ length: 513 }, () => ({ x: 0, y: 0, t: 0 })),
        color: "#fff",
        width: 1,
        phase: "move",
      },
    ];
    for (const data of invalid) {
      emitter.emit(KIT_CANVAS_EVENT, 4, data as JsonValue);
    }
    expect(received).toBe(stroke);

    const end = {
      points: [
        { x: 0, y: 0, t: 0 },
        { x: 1, y: 1, t: 12 },
      ],
      color: "#ffffff",
      width: 2,
      phase: "end",
      count: 2,
    };
    emitter.emit(KIT_CANVAS_EVENT, 4, end);
    expect(received).toBe(end);
    unsubscribe();
    emitter.emit(KIT_CANVAS_EVENT, 4, stroke);
    expect(received).toBe(end);
  });
});
