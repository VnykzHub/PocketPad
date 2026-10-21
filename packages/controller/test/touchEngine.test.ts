import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HitRect } from "../src/touch/hitTest.js";
import { TouchEngine, type TouchEngineEvent } from "../src/touch/touchEngine.js";

interface FakeTouch {
  identifier: number;
  clientX: number;
  clientY: number;
}

/**
 * Dispatches a touch event carrying `changedTouches`. jsdom has no real touch
 * input, so the engine's logic is tested against this minimal event shape
 * (the plan calls for fake touch lists, not a browser).
 */
function dispatchTouch(
  target: EventTarget,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  changed: readonly FakeTouch[],
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "changedTouches", { value: changed });
  Object.defineProperty(event, "touches", { value: changed });
  target.dispatchEvent(event);
  return event;
}

function touch(identifier: number, clientX: number, clientY: number): FakeTouch {
  return { identifier, clientX, clientY };
}

/** Waits for the same frame mechanism the engine used to debounce layout work. */
async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        resolve();
      });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

const BUTTONS: HitRect[] = Array.from({ length: 10 }, (_, index) => ({
  controlId: `b${index}`,
  left: index * 80,
  top: 0,
  width: 60,
  height: 60,
  z: 0,
}));

function buttonCenter(index: number): FakeTouch {
  return touch(index + 1, index * 80 + 30, 30);
}

let surface: HTMLDivElement;
let engine: TouchEngine;
let events: TouchEngineEvent[];
let layoutChanges: number;

beforeEach(() => {
  surface = document.createElement("div");
  document.body.append(surface);
  events = [];
  layoutChanges = 0;
  engine = new TouchEngine(surface, {
    onLayoutChange: () => {
      layoutChanges += 1;
    },
  });
  engine.onTouch = (event) => {
    events.push({
      type: event.type,
      controlId: event.controlId,
      binding: { ...event.binding },
    });
  };
  engine.setControls(BUTTONS);
});

afterEach(() => {
  engine.dispose();
  surface.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (document as unknown as Record<string, unknown>)["visibilityState"];
});

describe("[FR-8.6] touch identifier tracking", () => {
  it("[FR-8.6] ten simultaneous touches are tracked by identifier", () => {
    dispatchTouch(surface, "touchstart", BUTTONS.map((_, index) => buttonCenter(index)));

    expect(events).toHaveLength(10);
    expect(events.every((event) => event.type === "start")).toBe(true);

    const bindings = engine.activeBindings;
    expect(bindings).toHaveLength(10);
    for (let index = 0; index < bindings.length; index += 1) {
      expect(bindings[index]).toMatchObject({
        identifier: index + 1,
        controlId: `b${index}`,
        startX: index * 80 + 30,
        startY: 30,
      });
    }
  });

  it("[FR-8.6] the eleventh touch is ignored without throwing", () => {
    const eleven = Array.from({ length: 11 }, (_, index) => buttonCenter(index));
    dispatchTouch(surface, "touchstart", eleven);

    expect(engine.activeBindings).toHaveLength(10);
    expect(events).toHaveLength(10);
    expect(engine.droppedTouches).toBe(1);
  });

  it("[FR-8.6] a touch outside every control does not consume a slot", () => {
    dispatchTouch(surface, "touchstart", [touch(99, 5_000, 5_000)]);

    expect(engine.activeBindings).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(engine.droppedTouches).toBe(0);
  });

  it("[FR-8.6] touchend frees the slot for a new touch", () => {
    dispatchTouch(surface, "touchstart", BUTTONS.map((_, index) => buttonCenter(index)));
    dispatchTouch(surface, "touchend", [touch(1, 30, 30)]);
    expect(engine.activeBindings).toHaveLength(9);

    dispatchTouch(surface, "touchstart", [touch(11, 30, 30)]);

    expect(engine.activeBindings).toHaveLength(10);
    expect(engine.droppedTouches).toBe(0);
    expect(engine.activeBindings.map((binding) => binding.identifier)).toContain(11);
  });

  it("[FR-8.6] touchend emits end with the final coordinates and removes the binding", () => {
    dispatchTouch(surface, "touchstart", [touch(1, 30, 30)]);
    dispatchTouch(surface, "touchend", [touch(1, 40, 35)]);

    const ended = events.at(-1);
    expect(ended).toMatchObject({
      type: "end",
      controlId: "b0",
      binding: {
        identifier: 1,
        controlId: "b0",
        startX: 30,
        startY: 30,
        lastX: 40,
        lastY: 35,
      },
    });
    expect(engine.activeBindings).toHaveLength(0);
  });

  it("[FR-8.6] touchcancel releases the binding and emits cancel", () => {
    dispatchTouch(surface, "touchstart", [touch(1, 30, 30)]);

    dispatchTouch(surface, "touchcancel", [touch(1, 32, 31)]);

    expect(events.at(-1)).toMatchObject({
      type: "cancel",
      controlId: "b0",
      binding: { identifier: 1, lastX: 32, lastY: 31 },
    });
    expect(engine.activeBindings).toHaveLength(0);
  });

  it("[FR-8.6] touchmove updates the binding and keeps its control", () => {
    dispatchTouch(surface, "touchstart", [touch(1, 30, 30)]);
    dispatchTouch(surface, "touchmove", [touch(1, 45, 50)]);

    expect(events.map((event) => event.type)).toEqual(["start", "move"]);
    expect(engine.activeBindings[0]).toMatchObject({
      identifier: 1,
      controlId: "b0",
      startX: 30,
      startY: 30,
      lastX: 45,
      lastY: 50,
    });

    // Dragging far outside the control keeps the binding (the control may drag).
    dispatchTouch(surface, "touchmove", [touch(1, 5_000, 5_000)]);
    expect(engine.activeBindings).toHaveLength(1);
  });

  it("[FR-8.6] move, end and cancel for an untracked identifier are ignored", () => {
    dispatchTouch(surface, "touchmove", [touch(42, 30, 30)]);
    dispatchTouch(surface, "touchend", [touch(42, 30, 30)]);
    dispatchTouch(surface, "touchcancel", [touch(42, 30, 30)]);

    expect(events).toHaveLength(0);
  });
});

describe("[FR-8.7] touchstart updates control state synchronously", () => {
  it("[FR-8.7] the start event is emitted before dispatchEvent returns", () => {
    let received: TouchEngineEvent | null = null;
    engine.onTouch = (event) => {
      received = event;
    };

    dispatchTouch(surface, "touchstart", [touch(7, 30, 30)]);

    expect(received).toMatchObject({
      type: "start",
      controlId: "b0",
      binding: { identifier: 7, controlId: "b0" },
    });
    // The binding is observable immediately as well.
    expect(engine.activeBindings.map((binding) => binding.identifier)).toEqual([7]);
  });
});

describe("[FR-8.3] cached rects and layout notifications", () => {
  it("[FR-8.3] hit-test rects are cached and not read during touchmove", () => {
    const source: HitRect = {
      controlId: "jump",
      left: 0,
      top: 0,
      width: 60,
      height: 60,
      z: 0,
    };
    engine.setControls([source]);
    const layoutRead = vi.spyOn(surface, "getBoundingClientRect");

    // Mutating the renderer's object after setControls must not move the cache.
    source.left = 1_000;
    source.width = 10;

    dispatchTouch(surface, "touchstart", [touch(1, 30, 30)]);
    expect(engine.activeBindings[0]).toMatchObject({ controlId: "jump" });

    dispatchTouch(surface, "touchmove", [touch(1, 500, 500)]);
    expect(events.map((event) => event.type)).toEqual(["start", "move"]);
    expect(layoutRead).not.toHaveBeenCalled();
  });

  it("[FR-8.3] orientation change cancels active touches and invalidates the cache", async () => {
    dispatchTouch(surface, "touchstart", [touch(1, 30, 30)]);

    window.dispatchEvent(new Event("orientationchange"));

    expect(engine.activeBindings).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "cancel", controlId: "b0" });
    expect(engine.layoutStale).toBe(true);
    expect(layoutChanges).toBe(0);

    await nextFrame();
    expect(layoutChanges).toBe(1);

    engine.setControls(BUTTONS);
    expect(engine.layoutStale).toBe(false);
  });

  it("[FR-8.3] coalesces rapid resize notifications into one layout callback", async () => {
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    expect(engine.layoutStale).toBe(true);
    expect(layoutChanges).toBe(0);

    await nextFrame();

    expect(layoutChanges).toBe(1);
  });

  it("[FR-8.3] a ResizeObserver on the surface invalidates the cache", async () => {
    const observed: Element[] = [];
    let notify: (() => void) | null = null;

    class FakeResizeObserver {
      constructor(callback: () => void) {
        notify = callback;
      }

      observe(target: Element): void {
        observed.push(target);
      }

      disconnect(): void {
        observed.length = 0;
      }
    }

    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const otherSurface = document.createElement("div");
    document.body.append(otherSurface);
    let otherChanges = 0;
    const other = new TouchEngine(otherSurface, {
      onLayoutChange: () => {
        otherChanges += 1;
      },
    });
    other.setControls(BUTTONS);
    expect(observed).toContain(otherSurface);

    dispatchTouch(otherSurface, "touchstart", [touch(1, 30, 30)]);
    notify?.();
    expect(otherChanges).toBe(0);

    await nextFrame();
    expect(otherChanges).toBe(1);
    expect(other.layoutStale).toBe(true);
    expect(other.activeBindings).toHaveLength(0);

    other.dispose();
    expect(observed).toHaveLength(0);
    otherSurface.remove();
  });

  it("[FR-8.3] dispose removes listeners and cancels pending layout callbacks", async () => {
    window.dispatchEvent(new Event("resize"));
    engine.dispose();

    dispatchTouch(surface, "touchstart", [touch(1, 30, 30)]);
    await nextFrame();

    expect(events).toHaveLength(0);
    expect(layoutChanges).toBe(0);
  });
});

describe("[FR-8.6] touch handlers own the play surface", () => {
  it("[FR-8.6] touchstart, touchmove, touchend and touchcancel prevent default", () => {
    const start = dispatchTouch(surface, "touchstart", [touch(1, 30, 30)]);
    const move = dispatchTouch(surface, "touchmove", [touch(1, 31, 31)]);
    const end = dispatchTouch(surface, "touchend", [touch(1, 31, 31)]);
    const cancel = dispatchTouch(surface, "touchstart", [touch(2, 30, 30)]);
    dispatchTouch(surface, "touchcancel", [touch(2, 30, 30)]);

    expect(start.defaultPrevented).toBe(true);
    expect(move.defaultPrevented).toBe(true);
    expect(end.defaultPrevented).toBe(true);
    expect(cancel.defaultPrevented).toBe(true);
  });

  it("[FR-8.6] blur cancels every active touch", () => {
    dispatchTouch(surface, "touchstart", [touch(1, 30, 30), touch(2, 110, 30)]);
    window.dispatchEvent(new Event("blur"));

    const cancelled = events.filter((event) => event.type === "cancel");
    expect(cancelled.map((event) => event.binding.identifier)).toEqual([1, 2]);
    expect(engine.activeBindings).toHaveLength(0);
  });

  it("[FR-8.6] visibilitychange hidden cancels every active touch", () => {
    dispatchTouch(surface, "touchstart", [touch(1, 30, 30), touch(2, 110, 30)]);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });

    document.dispatchEvent(new Event("visibilitychange"));

    expect(events.filter((event) => event.type === "cancel")).toHaveLength(2);
    expect(engine.activeBindings).toHaveLength(0);
  });

  it("[FR-8.6] visibilitychange visible keeps active touches", () => {
    dispatchTouch(surface, "touchstart", [touch(1, 30, 30)]);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    document.dispatchEvent(new Event("visibilitychange"));

    expect(events.filter((event) => event.type === "cancel")).toHaveLength(0);
    expect(engine.activeBindings).toHaveLength(1);
  });
});

describe("[AR-5] engine hit areas are at least 44x44 CSS pixels", () => {
  it("[AR-5] an undersized rendered box still has a 44x44 hit area", () => {
    const tinySurface = document.createElement("div");
    document.body.append(tinySurface);
    const tiny = new TouchEngine(tinySurface, { slopPx: 0 });
    tiny.setControls([{ controlId: "tiny", left: 100, top: 100, width: 20, height: 20, z: 0 }]);

    // Center (110, 110); a 44 px minimum reaches to 132 inclusive.
    dispatchTouch(tinySurface, "touchstart", [touch(1, 132, 110)]);
    expect(tiny.activeBindings.map((binding) => binding.controlId)).toEqual(["tiny"]);

    dispatchTouch(tinySurface, "touchend", [touch(1, 132, 110)]);
    dispatchTouch(tinySurface, "touchstart", [touch(2, 133, 110)]);
    expect(tiny.activeBindings).toHaveLength(0);

    tiny.dispose();
    tinySurface.remove();
  });
});
