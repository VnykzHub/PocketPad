/**
 * D5 control registry tests (D5-CTRL-01; FR-8.1, FR-8.2, FR-8.3, FR-8.4,
 * FR-8.7, FR-7.7, AR-5, SR-13).
 *
 * jsdom provides the DOM. Touch input is simulated by calling the renderer
 * handlers directly with `TouchBinding` objects, exactly as the D2-CTRL-01
 * engine emits them; there is no socket involved. Canvas has no 2D context in
 * jsdom without the optional `canvas` package, so `getContext` is stubbed with
 * a recording fake — the renderer's guards must also work when it returns null.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  validateLayout,
  type ButtonControl,
  type CanvasControl,
  type ChoiceControl,
  type Control,
  type DpadControl,
  type GyroControl,
  type LayoutDocument,
  type PanelControl,
  type PanelContent,
  type SliderControl,
  type StickControl,
  type TextControl,
  type TouchpadControl,
  type TriggerControl,
} from "@lanpad/sdk";
import type { JsonValue } from "@lanpad/protocol";
import { InputStore } from "../src/input/InputStore.js";
import {
  controlHitRect,
  type ControlContext,
  type ControlRenderer,
  type SurfaceSize,
} from "../src/controls/control.js";
import { createControl, createControls } from "../src/controls/registry.js";
import {
  emitControlEvent,
  type ControlEventPriority,
  type ControlEventSink,
  type StrokeEventData,
} from "../src/controls/eventSink.js";
import { isPanelRenderer, type PanelRenderer } from "../src/controls/panel.js";
import { resolveCanvasInk } from "../src/controls/canvas.js";
import type { TouchBinding } from "../src/touch/touchEngine.js";

const SURFACE: SurfaceSize = { width: 800, height: 400 };

interface RecordedEvent {
  name: string;
  data: JsonValue;
  priority: ControlEventPriority | undefined;
}

class FakeSink implements ControlEventSink {
  readonly events: RecordedEvent[] = [];

  enqueue(name: string, data: JsonValue, priority?: ControlEventPriority): void {
    this.events.push({ name, data, priority });
  }
}

function freshContext(events: FakeSink | null = new FakeSink()): {
  ctx: ControlContext;
  sink: FakeSink;
} {
  const sink = events ?? new FakeSink();
  const ctx: ControlContext = {
    input: new InputStore(),
    surfaceSize: SURFACE,
    events: sink,
  };
  return { ctx, sink };
}

function bareContext(): ControlContext {
  return { input: new InputStore(), surfaceSize: SURFACE };
}

function binding(
  identifier: number,
  controlId: string,
  lastX: number,
  lastY: number,
  startX: number = lastX,
  startY: number = lastY,
): TouchBinding {
  return { identifier, controlId, startX, startY, lastX, lastY };
}

function part(renderer: ControlRenderer, name: string): HTMLElement {
  const element = renderer.element.querySelector<HTMLElement>(`[data-part="${name}"]`);
  if (element === null) {
    throw new Error(`renderer ${renderer.id} has no [data-part="${name}"]`);
  }
  return element;
}

function boxStyle(element: HTMLElement): string[] {
  return [element.style.left, element.style.top, element.style.width, element.style.height];
}

function edge(element: HTMLElement, property: "width" | "height"): number {
  return Number.parseFloat(element.style[property]);
}

const BUTTON: ButtonControl = {
  type: "button",
  id: "jump",
  label: "Jump",
  shape: "circle",
  x: "82%",
  y: "70%",
  r: "11%",
  bit: 0,
};

const DPAD: DpadControl = {
  type: "dpad",
  id: "move",
  x: "20%",
  y: "75%",
  size: "30%",
  bits: { up: 1, down: 2, left: 3, right: 4 },
};

const STICK: StickControl = {
  type: "stick",
  id: "look",
  x: "50%",
  y: "50%",
  size: "50%",
  axis: "left",
  mode: "fixed",
};

/** Vertical trigger at x=736, y=160, 72x72. */
const TRIGGER: TriggerControl = {
  type: "trigger",
  id: "fire",
  x: "92%",
  y: "40%",
  size: "18%",
  channel: "lt",
};

/** Box x=400, y=120, 240x80. */
const TOUCHPAD: TouchpadControl = {
  type: "touchpad",
  id: "pad",
  x: "50%",
  y: "30%",
  w: "30%",
  h: "20%",
};

/** Box x=400, y=40, 240x32 (height clamped to 44). */
const SLIDER: SliderControl = {
  type: "slider",
  id: "power",
  x: "50%",
  y: "10%",
  w: "30%",
  h: "8%",
  channel: "rt",
  direction: "horizontal",
};

const GYRO: GyroControl = {
  type: "gyro",
  id: "tilt",
  x: "10%",
  y: "20%",
};

/** Box x=160, y=160, 192x96; two 44 px rows. */
const CHOICE: ChoiceControl = {
  type: "choice",
  id: "pick",
  x: "20%",
  y: "40%",
  w: "24%",
  h: "24%",
  event: "pick",
  options: [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Bravo" },
  ],
};

const CHOICE_MANY: ChoiceControl = {
  ...CHOICE,
  id: "pick-many",
  options: [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Bravo" },
    { value: "c", label: "Charlie" },
    { value: "d", label: "Delta" },
  ],
};

const PANEL: PanelControl = {
  type: "panel",
  id: "secret",
  x: "50%",
  y: "55%",
  w: "30%",
  h: "20%",
};

/** Box x=400, y=360, 320x32 (height clamped to 44). */
const TEXT: TextControl = {
  type: "text",
  id: "answer",
  x: "50%",
  y: "90%",
  w: "40%",
  h: "8%",
  event: "answer",
  maxLen: 40,
};

/** Box x=600, y=80, 240x80. The ink fields are the additive D5-CTRL-01 ones. */
const CANVAS = {
  type: "canvas",
  id: "draw",
  x: "75%",
  y: "20%",
  w: "30%",
  h: "20%",
  event: "draw",
  color: "#ff0000",
  width: 8,
} as unknown as CanvasControl;

const D5_LAYOUT: LayoutDocument = {
  id: "d5-all-controls",
  orientation: "landscape",
  background: "#101014",
  controls: [BUTTON, DPAD, STICK, TRIGGER, TOUCHPAD, SLIDER, GYRO, CHOICE, PANEL, TEXT, CANVAS],
};

interface FakeCanvasContext {
  scale: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  strokeStyle: string;
  fillStyle: string;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
}

function makeFakeContext(): FakeCanvasContext {
  return {
    scale: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
  };
}

let fakeContext: FakeCanvasContext;

beforeEach(() => {
  fakeContext = makeFakeContext();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    fakeContext as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("[FR-8.4] the D5 fixture is a valid layout", () => {
  it("[FR-8.4] validateLayout accepts every v1 control type in one layout", () => {
    const result = validateLayout(D5_LAYOUT);
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
  });
});

describe("[FR-8.1] every v1 control type renders from layout data", () => {
  it("[FR-8.1] all eleven control types build through createControl", () => {
    const { ctx } = freshContext();
    const renderers = createControls(D5_LAYOUT.controls, ctx);

    expect(renderers).toHaveLength(11);
    for (const renderer of renderers) {
      const control = D5_LAYOUT.controls.find((candidate) => candidate.id === renderer.id);
      expect(control).toBeDefined();
      expect(renderer.element.dataset["controlType"]).toBe(control?.type);
      expect(renderer.element.dataset["controlId"]).toBe(control?.id);
      expect(renderer.element.style.position).toBe("absolute");
      expect(edge(renderer.element, "width")).toBeGreaterThanOrEqual(44);
      expect(edge(renderer.element, "height")).toBeGreaterThanOrEqual(44);
      expect(renderer.getState()).toBeTypeOf("object");
    }
  });

  it("[FR-8.1] unknown control types still fail with a clear error", () => {
    const { ctx } = freshContext();
    const unknown = { type: "hologram", id: "x", x: "0%", y: "0%" } as unknown as Control;
    expect(() => createControl(unknown, ctx)).toThrow(/Unknown control type/);
  });

  it("[FR-8.1] debug outlines cover all control types without moving them", () => {
    const sink = new FakeSink();
    const ctx: ControlContext = {
      input: new InputStore(),
      surfaceSize: SURFACE,
      debug: { outline: true },
      events: sink,
    };
    const renderers = createControls(D5_LAYOUT.controls, ctx);
    for (const renderer of renderers) {
      expect(renderer.element.style.outline).toMatch(/dashed|dotted/);
    }
  });
});

describe("[FR-8.2] registry rebuilds for a layout without page-level state", () => {
  it("[FR-8.2] dispose removes every control and a rebuild is clean", () => {
    const surface = document.createElement("div");
    document.body.append(surface);
    const { ctx } = freshContext();

    const first = createControls(D5_LAYOUT.controls, ctx);
    for (const renderer of first) {
      surface.append(renderer.element);
    }
    expect(surface.childElementCount).toBe(11);

    for (const renderer of first) {
      renderer.dispose();
    }
    expect(surface.childElementCount).toBe(0);
    const snapshot = ctx.input.snapshot(0);
    expect(snapshot.buttons).toBe(0);
    expect(snapshot.lt).toBe(0);
    expect(snapshot.rt).toBe(0);
    expect(snapshot.rx).toBe(0);
    expect(snapshot.ry).toBe(0);

    const second = createControls(D5_LAYOUT.controls, ctx);
    expect(second).toHaveLength(11);
    for (const renderer of second) {
      surface.append(renderer.element);
    }
    expect(surface.childElementCount).toBe(11);

    for (const renderer of second) {
      renderer.dispose();
    }
    surface.remove();
    expect(surface.childElementCount).toBe(0);
  });
});

describe("[FR-7.7] analog channel mapping", () => {
  it("[FR-7.7] touchpad maps center to 0 and edges to +/-32767", () => {
    const { ctx } = freshContext();
    const renderer = createControl(TOUCHPAD, ctx);

    renderer.onTouchStart(binding(1, "pad", 400, 120));
    expect(ctx.input.snapshot(0).rx).toBe(0);
    expect(ctx.input.snapshot(0).ry).toBe(0);

    // 1 px from center is inside the 2% radial snap (half-extents are 120x40).
    renderer.onTouchMove(binding(1, "pad", 401, 120, 400, 120));
    expect(ctx.input.snapshot(0).rx).toBe(0);

    renderer.onTouchMove(binding(1, "pad", 520, 120, 400, 120));
    expect(ctx.input.snapshot(0).rx).toBe(32767);
    expect(ctx.input.snapshot(0).ry).toBe(0);
    expect(renderer.getState()).toEqual({ rx: 32767, ry: 0 });

    renderer.onTouchMove(binding(1, "pad", 280, 120, 400, 120));
    expect(ctx.input.snapshot(0).rx).toBe(-32767);

    renderer.onTouchMove(binding(1, "pad", 400, 80, 400, 120));
    expect(ctx.input.snapshot(0).ry).toBe(-32767);

    renderer.onTouchMove(binding(1, "pad", 400, 160, 400, 120));
    expect(ctx.input.snapshot(0).ry).toBe(32767);

    // Mid-travel is a linear absolute position, not the stick curve.
    renderer.onTouchMove(binding(1, "pad", 460, 120, 400, 120));
    expect(ctx.input.snapshot(0).rx).toBe(16384);
    expect(renderer.getState()).toEqual({ rx: 16384, ry: 0 });

    renderer.onTouchEnd(binding(1, "pad", 460, 120, 400, 120));
    expect(ctx.input.snapshot(0).rx).toBe(0);
    expect(ctx.input.snapshot(0).ry).toBe(0);

    // Axes only: the touchpad never touches the button mask or the left stick.
    expect(ctx.input.snapshot(0).buttons).toBe(0);
    expect(ctx.input.snapshot(0).lx).toBe(0);
    expect(ctx.input.snapshot(0).ly).toBe(0);
  });

  it("[FR-7.7] trigger maps to lt and slider maps to rt, never the other channel", () => {
    const first = freshContext();
    const trigger = createControl(TRIGGER, first.ctx);

    trigger.onTouchStart(binding(1, "fire", 736, 124));
    expect(first.ctx.input.snapshot(0).lt).toBe(255);
    expect(first.ctx.input.snapshot(0).rt).toBe(0);
    expect(trigger.getState()).toEqual({ lt: 255 });

    trigger.onTouchMove(binding(1, "fire", 736, 160, 736, 124));
    expect(first.ctx.input.snapshot(0).lt).toBe(128);
    expect(trigger.getState()).toEqual({ lt: 128 });

    trigger.onTouchMove(binding(1, "fire", 736, 196, 736, 124));
    expect(first.ctx.input.snapshot(0).lt).toBe(0);

    trigger.onTouchEnd(binding(1, "fire", 736, 196, 736, 124));
    expect(first.ctx.input.snapshot(0).lt).toBe(0);

    const second = freshContext();
    const slider = createControl(SLIDER, second.ctx);

    slider.onTouchStart(binding(1, "power", 280, 40));
    expect(second.ctx.input.snapshot(0).rt).toBe(0);
    expect(second.ctx.input.snapshot(0).lt).toBe(0);

    slider.onTouchMove(binding(1, "power", 400, 40, 280, 40));
    expect(second.ctx.input.snapshot(0).rt).toBe(128);
    expect(second.ctx.input.snapshot(0).lt).toBe(0);
    expect(slider.getState()).toEqual({ rt: 128 });

    slider.onTouchMove(binding(1, "power", 520, 40, 280, 40));
    expect(second.ctx.input.snapshot(0).rt).toBe(255);

    slider.onTouchEnd(binding(1, "power", 520, 40, 280, 40));
    expect(second.ctx.input.snapshot(0).rt).toBe(0);
  });

  it("[FR-7.7] horizontal triggers and vertical sliders follow their travel axis", () => {
    // 72x72 box centered at (400, 360), so x spans 364..436.
    const horizontalTrigger: TriggerControl = {
      ...TRIGGER,
      id: "fire-h",
      orientation: "horizontal",
      x: "50%",
      y: "90%",
    };
    const first = freshContext();
    const trigger = createControl(horizontalTrigger, first.ctx);

    trigger.onTouchStart(binding(1, "fire-h", 364, 360));
    expect(first.ctx.input.snapshot(0).lt).toBe(0);
    trigger.onTouchMove(binding(1, "fire-h", 400, 360, 364, 360));
    expect(first.ctx.input.snapshot(0).lt).toBe(128);
    expect(part(trigger, "fill").style.transform).toBe("scaleX(0.5)");
    trigger.onTouchMove(binding(1, "fire-h", 436, 360, 364, 360));
    expect(first.ctx.input.snapshot(0).lt).toBe(255);
    trigger.onTouchEnd(binding(1, "fire-h", 436, 360, 364, 360));

    // 240x44 box centered at (400, 200), so y spans 178..222.
    const verticalSlider: SliderControl = {
      ...SLIDER,
      id: "power-v",
      direction: "vertical",
      y: "50%",
    };
    const second = freshContext();
    const slider = createControl(verticalSlider, second.ctx);

    slider.onTouchStart(binding(1, "power-v", 400, 222));
    expect(second.ctx.input.snapshot(0).rt).toBe(0);
    slider.onTouchMove(binding(1, "power-v", 400, 200, 400, 222));
    expect(second.ctx.input.snapshot(0).rt).toBe(128);
    expect(part(slider, "fill").style.transform).toBe("scaleY(0.5)");
    slider.onTouchMove(binding(1, "power-v", 400, 178, 400, 222));
    expect(second.ctx.input.snapshot(0).rt).toBe(255);
    slider.onTouchEnd(binding(1, "power-v", 400, 178, 400, 222));
  });
});

describe("[FR-8.7] same-frame analog feedback", () => {
  it("[FR-8.7] trigger fill and store value change synchronously on touchstart", () => {
    const { ctx } = freshContext();
    const renderer = createControl(TRIGGER, ctx);

    renderer.onTouchStart(binding(1, "fire", 736, 124));

    expect(part(renderer, "fill").style.transform).toBe("scaleY(1)");
    expect(renderer.element.getAttribute("aria-valuenow")).toBe("255");
    expect(ctx.input.snapshot(0).lt).toBe(255);
    expect(renderer.element.classList.contains("is-pressed")).toBe(true);
  });

  it("[FR-8.7] slider fill and store value change synchronously on touchstart", () => {
    const { ctx } = freshContext();
    const renderer = createControl(SLIDER, ctx);

    renderer.onTouchStart(binding(1, "power", 400, 40));

    expect(part(renderer, "fill").style.transform).toBe("scaleX(0.5)");
    expect(ctx.input.snapshot(0).rt).toBe(128);
  });
});

describe("[AR-5] minimum touch targets", () => {
  it("[AR-5] every interactive control renders at least 44x44", () => {
    const tiny: Control[] = [
      { ...TRIGGER, id: "tiny-trigger", size: "10px" },
      { ...TOUCHPAD, id: "tiny-touchpad", w: "10px", h: "10px" },
      { ...SLIDER, id: "tiny-slider", w: "10px", h: "10px" },
      { ...CHOICE_MANY, id: "tiny-choice", w: "10px", h: "10px" },
      { ...PANEL, id: "tiny-panel", w: "10px", h: "10px" },
      { ...TEXT, id: "tiny-text", w: "10px", h: "10px" },
      { ...CANVAS, id: "tiny-canvas", w: "10px", h: "10px" },
      GYRO,
    ];

    for (const control of tiny) {
      const { ctx } = freshContext();
      const renderer = createControl(control, ctx);
      const rect = controlHitRect(control, SURFACE);

      expect(edge(renderer.element, "width"), control.id).toBeGreaterThanOrEqual(44);
      expect(edge(renderer.element, "height"), control.id).toBeGreaterThanOrEqual(44);
      expect(rect.width, control.id).toBeGreaterThanOrEqual(44);
      expect(rect.height, control.id).toBeGreaterThanOrEqual(44);
      expect(rect.width).toBe(edge(renderer.element, "width"));
      expect(rect.height).toBe(edge(renderer.element, "height"));
    }
  });

  it("[AR-5] undersized layout boxes are flagged in debug mode", () => {
    const debug: ControlContext = {
      input: new InputStore(),
      surfaceSize: SURFACE,
      debug: { outline: true },
      events: new FakeSink(),
    };
    const clamped = createControl({ ...TRIGGER, id: "clamped", size: "10px" }, debug);
    expect(clamped.element.dataset["targetClamped"]).toBe("true");
    expect(clamped.element.style.outline).toContain("dotted");

    const normal = createControl({ ...TRIGGER, id: "normal" }, debug);
    expect(normal.element.dataset["targetClamped"]).toBeUndefined();
    expect(normal.element.style.outline).toContain("dashed");
  });

  it("[AR-5] the text send button is 44 px wide and fills the control height", () => {
    const { ctx } = freshContext();
    const renderer = createControl(TEXT, ctx);
    const send = part(renderer, "send");

    expect(send.style.width).toBe("44px");
    expect(edge(renderer.element, "height")).toBeGreaterThanOrEqual(44);
  });
});

describe("[FR-8.3] feedback and scrolling stay on transform/opacity", () => {
  it("[FR-8.3] analog and choice interactions never change the control box", () => {
    const { ctx } = freshContext();
    const trigger = createControl(TRIGGER, ctx);
    const slider = createControl(SLIDER, ctx);
    const touchpad = createControl(TOUCHPAD, ctx);
    const choice = createControl(CHOICE_MANY, ctx);

    const boxes = [trigger, slider, touchpad, choice].map((renderer) =>
      boxStyle(renderer.element),
    );

    trigger.onTouchStart(binding(1, "fire", 736, 150));
    trigger.onTouchEnd(binding(1, "fire", 736, 150));
    slider.onTouchStart(binding(2, "power", 400, 40));
    slider.onTouchEnd(binding(2, "power", 400, 40));
    touchpad.onTouchStart(binding(3, "pad", 460, 120));
    // The knob follows the finger by transform while the touch is live; it
    // recentres on release, so sample it before ending the gesture.
    expect(part(touchpad, "knob").style.transform).toContain("translate3d");
    touchpad.onTouchEnd(binding(3, "pad", 460, 120));
    choice.onTouchStart(binding(4, "pick-many", 100, 130));
    choice.onTouchEnd(binding(4, "pick-many", 100, 130));

    expect(boxStyle(trigger.element)).toEqual(boxes[0]);
    expect(boxStyle(slider.element)).toEqual(boxes[1]);
    expect(boxStyle(touchpad.element)).toEqual(boxes[2]);
    expect(boxStyle(choice.element)).toEqual(boxes[3]);

    expect(part(trigger, "fill").style.transform).toContain("scaleY");
    expect(part(slider, "fill").style.transform).toContain("scaleX");
    expect(part(choice, "selection").style.opacity).toBe("1");
    expect(part(choice, "selection").style.transform).toContain("translate3d");
  });

  it("[FR-8.3] a choice drag scrolls by transform and selects nothing", () => {
    const { ctx, sink } = freshContext();
    const renderer = createControl(CHOICE_MANY, ctx);

    renderer.onTouchStart(binding(1, "pick-many", 100, 190));
    renderer.onTouchMove(binding(1, "pick-many", 100, 110, 100, 190));
    renderer.onTouchEnd(binding(1, "pick-many", 100, 110, 100, 190));

    expect(sink.events).toHaveLength(0);
    // Four 44 px rows in a 96 px box: max scroll is -80 px.
    expect(part(renderer, "list").style.transform).toContain("-80.00px");
  });

  it("[FR-8.3] text and canvas press states use transform/opacity", () => {
    const { ctx } = freshContext();
    const text = createControl(TEXT, ctx);
    const canvas = createControl(CANVAS, ctx);
    const textBox = boxStyle(text.element);
    const canvasBox = boxStyle(canvas.element);

    text.onTouchStart(binding(1, "answer", 540, 360));
    expect(part(text, "send").style.transform).toContain("scale(0.96)");
    text.onTouchEnd(binding(1, "answer", 540, 360));

    canvas.onTouchStart(binding(2, "draw", 480, 40));
    expect(canvas.element.style.opacity).toBe("0.96");
    canvas.onTouchEnd(binding(2, "draw", 480, 40));

    expect(boxStyle(text.element)).toEqual(textBox);
    expect(boxStyle(canvas.element)).toEqual(canvasBox);
  });
});

describe("[FR-8.1] choice behavior", () => {
  it("[FR-8.1] tapping an option emits exactly one validated event and selects locally", () => {
    const { ctx, sink } = freshContext();
    const renderer = createControl(CHOICE, ctx);
    const rows = renderer.element.querySelectorAll<HTMLElement>('[data-part="option"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toBe("Alpha");

    renderer.onTouchStart(binding(1, "pick", 100, 130));
    renderer.onTouchEnd(binding(1, "pick", 100, 130));

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.name).toBe("pick");
    expect(sink.events[0]?.data).toEqual({ value: "a" });
    expect(sink.events[0]?.priority).toBe("high");
    expect(rows[0]?.getAttribute("aria-selected")).toBe("true");
    expect(rows[1]?.getAttribute("aria-selected")).toBe("false");

    renderer.onTouchStart(binding(2, "pick", 100, 170));
    renderer.onTouchEnd(binding(2, "pick", 100, 170));
    expect(sink.events).toHaveLength(2);
    expect(sink.events[1]?.data).toEqual({ value: "b" });
    expect(part(renderer, "selection").style.transform).toContain("44px");

    // Re-tapping the current selection is local state only.
    renderer.onTouchStart(binding(3, "pick", 100, 170));
    renderer.onTouchEnd(binding(3, "pick", 100, 170));
    expect(sink.events).toHaveLength(2);

    // A cancelled touch never selects.
    renderer.onTouchStart(binding(4, "pick", 100, 130));
    renderer.onTouchCancel(binding(4, "pick", 100, 130));
    expect(sink.events).toHaveLength(2);
  });

  it("[FR-8.1] a choice with an invalid event name stays local (defense in depth)", () => {
    const { ctx, sink } = freshContext();
    const renderer = createControl({ ...CHOICE, event: "not a wire name!" }, ctx);

    renderer.onTouchStart(binding(1, "pick", 100, 130));
    renderer.onTouchEnd(binding(1, "pick", 100, 130));

    expect(sink.events).toHaveLength(0);
    expect(renderer.element.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
  });
});

describe("[FR-8.1] text behavior", () => {
  it("[FR-8.1] text submits one event on Enter, never per keystroke", () => {
    const { ctx, sink } = freshContext();
    const renderer = createControl(TEXT, ctx);
    const input = renderer.element.querySelector("input");
    if (input === null) {
      throw new Error("text renderer is missing its input");
    }

    input.value = "hello";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(sink.events).toHaveLength(0);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.name).toBe("answer");
    expect(sink.events[0]?.data).toEqual({ value: "hello" });
    expect(sink.events[0]?.priority).toBe("high");
    expect(input.value).toBe("");
  });

  it("[FR-8.1] the 44 px send button submits once with the current value", () => {
    const { ctx, sink } = freshContext();
    const renderer = createControl(TEXT, ctx);
    const input = renderer.element.querySelector("input");
    if (input === null) {
      throw new Error("text renderer is missing its input");
    }
    input.value = "world";

    renderer.onTouchStart(binding(1, "answer", 540, 360));
    renderer.onTouchEnd(binding(1, "answer", 540, 360));

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.data).toEqual({ value: "world" });
    expect(input.value).toBe("");
  });

  it("[FR-8.1] touching the input focuses it without submitting", () => {
    const { ctx, sink } = freshContext();
    const renderer = createControl(TEXT, ctx);
    const input = renderer.element.querySelector("input");
    if (input === null) {
      throw new Error("text renderer is missing its input");
    }
    input.value = "typing";

    // Renderers are attached to the play surface in the app; jsdom only
    // focuses elements that are in the document.
    document.body.append(renderer.element);
    try {
      renderer.onTouchStart(binding(1, "answer", 300, 360));
      renderer.onTouchEnd(binding(1, "answer", 300, 360));

      expect(document.activeElement).toBe(input);
      expect(sink.events).toHaveLength(0);
      expect(input.value).toBe("typing");
    } finally {
      renderer.dispose();
    }
  });

  it("[SR-13] text strips control characters and truncates to maxLen before send", () => {
    const { ctx, sink } = freshContext();
    const renderer = createControl({ ...TEXT, maxLen: 5 }, ctx);
    const input = renderer.element.querySelector("input");
    if (input === null) {
      throw new Error("text renderer is missing its input");
    }

    expect(input.maxLength).toBe(5);
    input.value = "a\u0000bcdef";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.value).toBe("abcde");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.data).toEqual({ value: "abcde" });
  });

  it("[SR-13] whitespace-only submissions are not sent", () => {
    const { ctx, sink } = freshContext();
    const renderer = createControl(TEXT, ctx);
    const input = renderer.element.querySelector("input");
    if (input === null) {
      throw new Error("text renderer is missing its input");
    }

    input.value = "   ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sink.events).toHaveLength(0);
    expect(input.value).toBe("   ");
  });
});

describe("[SR-13] private panel rendering", () => {
  function panelRenderer(ctx: ControlContext): PanelRenderer {
    const renderer = createControl(PANEL, ctx);
    if (!isPanelRenderer(renderer)) {
      throw new Error("panel renderer does not expose setContent");
    }
    return renderer;
  }

  it("[SR-13] panel text is assigned as text, never parsed as HTML", () => {
    const { ctx } = freshContext();
    const renderer = panelRenderer(ctx);

    renderer.setContent({
      kind: "text",
      title: "<b>Title</b>",
      text: '<img src=x onerror="alert(1)">',
    });

    expect(renderer.element.querySelector("img")).toBeNull();
    expect(renderer.element.querySelector("b")).toBeNull();
    expect(part(renderer, "panel-title").textContent).toBe("<b>Title</b>");
    expect(part(renderer, "panel-text").textContent).toBe('<img src=x onerror="alert(1)">');
  });

  it("[SR-13] panel blocks render text/list items safely and images through isAllowedImageSrc", () => {
    const { ctx } = freshContext();
    const renderer = panelRenderer(ctx);

    renderer.setContent({
      kind: "blocks",
      blocks: [
        { type: "heading", text: "<h1>Heading</h1>" },
        { type: "paragraph", text: "<script>bad()</script>" },
        { type: "list", items: ["<em>one</em>", "two"] },
        { type: "image", src: "assets/pic.png", alt: "pic" },
      ],
    });

    expect(renderer.element.querySelector("h1")).toBeNull();
    expect(renderer.element.querySelector("script")).toBeNull();
    const items = renderer.element.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toBe("<em>one</em>");
    const image = renderer.element.querySelector("img");
    expect(image?.getAttribute("src")).toBe("assets/pic.png");
    expect(image?.alt).toBe("pic");
  });

  it("[SR-13] panel rejects hostile image sources", () => {
    const { ctx } = freshContext();
    const renderer = panelRenderer(ctx);

    for (const src of [
      "javascript:alert(1)",
      "https://evil.example/x.png",
      "//evil.example/x.png",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    ]) {
      renderer.setContent({ kind: "image", src });
      expect(renderer.element.querySelector("img"), src).toBeNull();
    }

    renderer.setContent({ kind: "image", src: "assets/secret.png", alt: "secret", fit: "cover" });
    const image = renderer.element.querySelector("img");
    expect(image?.getAttribute("src")).toBe("assets/secret.png");
    expect(image?.style.objectFit).toBe("cover");
  });

  it("[FR-8.1] panel shows a neutral placeholder for empty and invalid content", () => {
    const { ctx } = freshContext();
    const renderer = panelRenderer(ctx);

    expect(part(renderer, "placeholder").textContent).toBe("Private panel");
    expect(part(renderer, "placeholder").hidden).toBe(false);

    renderer.setContent({ kind: "text", text: "secret word" });
    expect(part(renderer, "placeholder").hidden).toBe(true);
    expect(part(renderer, "panel-text").textContent).toBe("secret word");

    renderer.setContent(null);
    expect(part(renderer, "placeholder").hidden).toBe(false);
    expect(renderer.getContent()).toBeNull();

    renderer.setContent({ kind: "text", text: 42 } as unknown as PanelContent);
    expect(part(renderer, "placeholder").textContent).toBe("Panel content unavailable");
    expect(renderer.element.dataset["invalidPanel"]).toBe("true");
    expect(renderer.element.querySelector("img")).toBeNull();
  });

  it("[FR-8.1] panel updates in place and emits nothing", () => {
    const { ctx, sink } = freshContext();
    const renderer = panelRenderer(ctx);
    const element = renderer.element;

    renderer.setContent({ kind: "text", text: "first" });
    renderer.setContent({ kind: "text", text: "second" });

    expect(renderer.element).toBe(element);
    expect(renderer.element.querySelectorAll('[data-part="panel-text"]')).toHaveLength(1);
    expect(part(renderer, "panel-text").textContent).toBe("second");

    renderer.onTouchStart(binding(1, "secret", 400, 220));
    renderer.onTouchMove(binding(1, "secret", 400, 180, 400, 220));
    renderer.onTouchEnd(binding(1, "secret", 400, 180, 400, 220));

    expect(sink.events).toHaveLength(0);
    const snapshot = ctx.input.snapshot(0);
    expect(snapshot.buttons).toBe(0);
    expect(snapshot.lt).toBe(0);
    expect(snapshot.rt).toBe(0);
    expect(snapshot.rx).toBe(0);
    expect(snapshot.ry).toBe(0);
  });
});

describe("[FR-8.1] gyro placeholder", () => {
  it("[FR-8.1] gyro renders the motion prompt and writes no input or events", () => {
    const { ctx, sink } = freshContext();
    const renderer = createControl(GYRO, ctx);

    expect(renderer.element.textContent).toContain("Enable motion");
    expect(renderer.element.getAttribute("aria-disabled")).toBe("true");

    renderer.onTouchStart(binding(1, "tilt", 80, 80));
    expect(renderer.element.style.transform).toContain("scale(0.96)");
    renderer.onTouchEnd(binding(1, "tilt", 80, 80));

    expect(sink.events).toHaveLength(0);
    const snapshot = ctx.input.snapshot(0);
    expect(snapshot.buttons).toBe(0);
    expect(snapshot.lt).toBe(0);
    expect(snapshot.rt).toBe(0);
    expect(snapshot.rx).toBe(0);
    expect(snapshot.ry).toBe(0);
  });
});

describe("[FR-8.1] canvas stroke capture", () => {
  it("[FR-8.1] canvas draws ink immediately and batches points into start/move/end", () => {
    let clock = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { ctx, sink } = freshContext();
    const renderer = createControl(CANVAS, ctx);

    renderer.onTouchStart(binding(1, "draw", 480, 40));
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.name).toBe("draw");
    expect(sink.events[0]?.priority).toBe("low");
    const start = sink.events[0]?.data as StrokeEventData;
    expect(start.phase).toBe("start");
    expect(start.color).toBe("#ff0000");
    expect(start.width).toBe(8);
    expect(start.points).toHaveLength(1);
    expect(start.points[0]).toMatchObject({ x: 0, y: 0 });
    expect(fakeContext.arc).toHaveBeenCalledTimes(1);

    clock = 1_020;
    renderer.onTouchMove(binding(1, "draw", 600, 80, 480, 40));
    // Ink is drawn synchronously, before any event batch leaves (E10).
    expect(fakeContext.lineTo).toHaveBeenCalledTimes(1);
    expect(fakeContext.stroke).toHaveBeenCalledTimes(1);
    expect(sink.events).toHaveLength(1);
    const first = fakeContext.lineTo.mock.calls[0];
    expect(first).toEqual([120, 40]);

    clock = 1_060;
    renderer.onTouchMove(binding(1, "draw", 650, 100, 480, 40));
    expect(sink.events).toHaveLength(2);
    const move = sink.events[1]?.data as StrokeEventData;
    expect(move.phase).toBe("move");
    expect(move.points).toHaveLength(2);
    expect(move.points[1]).toMatchObject({ x: (650 - 480) / 240, y: (100 - 40) / 80 });

    clock = 1_070;
    renderer.onTouchEnd(binding(1, "draw", 650, 100, 480, 40));
    expect(sink.events).toHaveLength(3);
    expect((sink.events[2]?.data as StrokeEventData).phase).toBe("end");

    const phases = sink.events.map((event) => (event.data as StrokeEventData).phase);
    expect(phases).toEqual(["start", "move", "end"]);
  });

  it("[FR-8.1] canvas still reports strokes when no 2D context exists", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    let clock = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { ctx, sink } = freshContext();
    const renderer = createControl(CANVAS, ctx);

    renderer.onTouchStart(binding(1, "draw", 480, 40));
    clock = 160;
    renderer.onTouchMove(binding(1, "draw", 600, 80, 480, 40));
    clock = 170;
    renderer.onTouchEnd(binding(1, "draw", 600, 80, 480, 40));

    const phases = sink.events.map((event) => (event.data as StrokeEventData).phase);
    expect(phases).toEqual(["start", "move", "end"]);
  });

  it("[FR-8.1] canvas captures one stroke at a time", () => {
    vi.spyOn(performance, "now").mockImplementation(() => 500);
    const { ctx, sink } = freshContext();
    const renderer = createControl(CANVAS, ctx);

    renderer.onTouchStart(binding(1, "draw", 480, 40));
    renderer.onTouchStart(binding(2, "draw", 500, 50));
    expect(sink.events).toHaveLength(1);

    renderer.onTouchEnd(binding(2, "draw", 500, 50));
    expect(sink.events).toHaveLength(1);

    renderer.onTouchEnd(binding(1, "draw", 480, 40));
    expect(sink.events).toHaveLength(2);
    expect((sink.events[1]?.data as StrokeEventData).phase).toBe("end");
  });

  it("[FR-8.1] canvas ink fields default and clamp safely", () => {
    expect(resolveCanvasInk({ ...CANVAS })).toEqual({ color: "#ff0000", width: 8 });
    expect(
      resolveCanvasInk({
        type: "canvas",
        id: "plain",
        x: "0%",
        y: "0%",
        w: "10%",
        h: "10%",
        event: "draw",
      }),
    ).toEqual({ color: "#ffffff", width: 6 });

    const hostile = {
      type: "canvas",
      id: "hostile",
      x: "0%",
      y: "0%",
      w: "10%",
      h: "10%",
      event: "draw",
      color: "url(javascript:alert(1))",
      width: 5_000,
    } as unknown as CanvasControl;
    expect(resolveCanvasInk(hostile)).toEqual({ color: "#ffffff", width: 32 });
  });
});

describe("[FR-8.1] controls without an event sink", () => {
  it("[FR-8.1] event controls stay local and do not throw when no queue is wired", () => {
    const ctx = bareContext();

    const text = createControl(TEXT, ctx);
    const input = text.element.querySelector("input");
    if (input === null) {
      throw new Error("text renderer is missing its input");
    }
    input.value = "keep me";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(input.value).toBe("keep me");
    expect(text.element.dataset["eventBlocked"]).toBe("true");

    const choice = createControl(CHOICE, ctx);
    choice.onTouchStart(binding(1, "pick", 100, 130));
    choice.onTouchEnd(binding(1, "pick", 100, 130));
    expect(choice.element.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);

    const canvas = createControl(CANVAS, ctx);
    canvas.onTouchStart(binding(2, "draw", 480, 40));
    canvas.onTouchMove(binding(2, "draw", 600, 80, 480, 40));
    canvas.onTouchEnd(binding(2, "draw", 600, 80, 480, 40));
  });

  it("[FR-8.1] emitControlEvent rejects missing sinks and unsafe names", () => {
    const sink = new FakeSink();
    expect(emitControlEvent(undefined, "answer", { value: "x" }, "high")).toBe(false);
    expect(emitControlEvent(sink, "bad name!", { value: "x" }, "high")).toBe(false);
    expect(sink.events).toHaveLength(0);
    expect(emitControlEvent(sink, "answer", { value: "x" }, "high")).toBe(true);
    expect(sink.events).toHaveLength(1);
  });
});
