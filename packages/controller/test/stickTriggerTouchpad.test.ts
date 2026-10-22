/**
 * Design-language tests for the stick, trigger and touchpad renderers
 * (CP-09, CP-10, CP-12; FR-8.1, FR-8.3, FR-8.7, FR-7.7, AR-5).
 *
 * These tests pin the renderer half of the control contract added in W4:
 * `.control` + `.control-<type>` + `.is-pressed`, the `data-part` hooks that
 * `styles.css` styles, labels/readouts, and the rule that renderers contribute
 * geometry and state only — never inline colour or opacity. Mapping behaviour
 * stays covered by `controls.test.ts` and `controlRegistry.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StickControl, TouchpadControl, TriggerControl } from "@lanpad/sdk";
import { InputStore } from "../src/input/InputStore.js";
import { createControl } from "../src/controls/registry.js";
import type { ControlContext, ControlRenderer } from "../src/controls/control.js";
import type { TouchBinding } from "../src/touch/touchEngine.js";

const SURFACE = { width: 800, height: 400 } as const;

const STICK: StickControl = {
  type: "stick",
  id: "move",
  x: "50%",
  y: "50%",
  size: "50%",
  axis: "left",
  mode: "fixed",
};

/** 72x72 box centered at (736, 200): top = 1, middle = 0.5, bottom = 0. */
const TRIGGER: TriggerControl = {
  type: "trigger",
  id: "fire",
  x: "92%",
  y: "50%",
  size: "18%",
  channel: "lt",
};

/** 240x80 box centered at (400, 200), half-extents 120x40. */
const TOUCHPAD: TouchpadControl = {
  type: "touchpad",
  id: "pad",
  x: "50%",
  y: "50%",
  w: "30%",
  h: "20%",
};

function freshContext(): ControlContext {
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

afterEach(() => {
  vi.useRealTimers();
});

describe("[FR-8.1] shared control grammar and design parts", () => {
  it("[FR-8.1] stick, trigger and touchpad emit the shared classes", () => {
    const ctx = freshContext();

    const stick = createControl(STICK, ctx);
    expect(stick.element.classList.contains("control")).toBe(true);
    expect(stick.element.classList.contains("control-stick")).toBe(true);
    expect(stick.element.dataset["mode"]).toBe("fixed");

    const trigger = createControl(TRIGGER, ctx);
    expect(trigger.element.classList.contains("control")).toBe(true);
    expect(trigger.element.classList.contains("control-trigger")).toBe(true);
    expect(trigger.element.getAttribute("role")).toBe("slider");
    expect(trigger.element.getAttribute("aria-orientation")).toBe("vertical");

    const pad = createControl(TOUCHPAD, ctx);
    expect(pad.element.classList.contains("control")).toBe(true);
    expect(pad.element.classList.contains("control-touchpad")).toBe(true);

    // None of these controls has a selection/blocked state to expose.
    for (const renderer of [stick, trigger, pad]) {
      expect(renderer.element.classList.contains("is-selected")).toBe(false);
      expect(renderer.element.classList.contains("is-blocked")).toBe(false);
    }
  });

  it("[FR-8.1] the stick exposes ticks, a deadzone ring and a Move/Look label", () => {
    const ctx = freshContext();
    const stick = createControl(STICK, ctx);

    expect(stick.element.querySelectorAll('[data-part="tick"]')).toHaveLength(4);
    expect(part(stick, "base")).not.toBeNull();
    expect(part(stick, "knob").style.width).toBe("42%");

    const deadzone = part(stick, "deadzone");
    expect(deadzone.style.width).toBe("8%");
    expect(deadzone.style.height).toBe("8%");
    expect(deadzone.hidden).toBe(true);
    expect(part(stick, "label").textContent).toBe("Move");

    const wide = createControl({ ...STICK, id: "wide", deadzone: 0.2 }, freshContext());
    expect(part(wide, "deadzone").style.width).toBe("20%");

    const look = createControl({ ...STICK, id: "look", axis: "right" }, freshContext());
    expect(part(look, "label").textContent).toBe("Look");
  });

  it("[FR-8.1] the trigger exposes the LT/RT label and a hidden readout", () => {
    const ctx = freshContext();
    const trigger = createControl(TRIGGER, ctx);

    expect(part(trigger, "fill").style.transform).toBe("scaleY(0)");
    expect(part(trigger, "label").textContent).toBe("LT");
    expect(part(trigger, "value").hidden).toBe(true);

    const rightTrigger = createControl(
      { ...TRIGGER, id: "fire-r", channel: "rt" },
      freshContext(),
    );
    expect(part(rightTrigger, "label").textContent).toBe("RT");
  });

  it("[FR-8.1] the touchpad exposes both crosshair axes, a trail and a label", () => {
    const ctx = freshContext();
    const pad = createControl(TOUCHPAD, ctx);

    expect(pad.element.querySelector('[data-part="crosshair-x"]')).not.toBeNull();
    expect(pad.element.querySelector('[data-part="crosshair-y"]')).not.toBeNull();
    expect(part(pad, "knob").style.width).toBe("18%");
    expect(part(pad, "trail").hidden).toBe(true);
    expect(part(pad, "label").textContent).toBe("Look");
  });
});

describe("[FR-8.7] synchronous press state drives the shared classes", () => {
  it("[FR-8.7] stick press toggles is-pressed and the deadzone cue", () => {
    const ctx = freshContext();
    const stick = createControl(STICK, ctx);
    const deadzone = part(stick, "deadzone");
    const touch = binding(1, "move", 400, 200);

    expect(stick.element.classList.contains("is-pressed")).toBe(false);
    stick.onTouchStart(touch);
    expect(stick.element.classList.contains("is-pressed")).toBe(true);
    expect(deadzone.hidden).toBe(false);
    expect(ctx.input.snapshot(0).lx).toBe(0);

    stick.onTouchMove(binding(1, "move", 500, 200, 400, 200));
    expect(ctx.input.snapshot(0).lx).toBe(32767);

    stick.onTouchEnd(binding(1, "move", 500, 200, 400, 200));
    expect(stick.element.classList.contains("is-pressed")).toBe(false);
    expect(deadzone.hidden).toBe(true);
    expect(ctx.input.snapshot(0).lx).toBe(0);
  });

  it("[FR-8.7] a floating stick mounts its base and knob on the touch point", () => {
    const ctx = freshContext();
    const floating = createControl({ ...STICK, id: "float", mode: "floating" }, ctx);
    const base = part(floating, "base");
    const knob = part(floating, "knob");

    expect(base.hidden).toBe(true);
    floating.onTouchStart(binding(1, "float", 300, 150));
    expect(base.hidden).toBe(false);
    expect(base.style.transform).toBe(
      "translate(-50%, -50%) translate3d(-100px, -50px, 0)",
    );
    // The knob starts on the base at the touch point, not at the layout centre.
    expect(knob.style.transform).toBe("translate(-50%, -50%) translate3d(-100px, -50px, 0)");

    floating.onTouchMove(binding(1, "float", 340, 170, 300, 150));
    expect(knob.style.transform).toContain("translate3d(-60px, -30px, 0)");

    floating.onTouchEnd(binding(1, "float", 340, 170, 300, 150));
    expect(base.hidden).toBe(true);
  });

  it("[FR-8.7] trigger fill, readout and aria value change in one call", () => {
    const ctx = freshContext();
    const trigger = createControl(TRIGGER, ctx);
    const fill = part(trigger, "fill");
    const readout = part(trigger, "value");

    trigger.onTouchStart(binding(1, "fire", 736, 164));
    expect(trigger.element.classList.contains("is-pressed")).toBe(true);
    expect(fill.style.transform).toBe("scaleY(1)");
    expect(trigger.element.getAttribute("aria-valuenow")).toBe("255");
    expect(ctx.input.snapshot(0).lt).toBe(255);
    expect(readout.hidden).toBe(false);
    expect(readout.textContent).toBe("100%");
    expect(readout.style.transform).toContain("translate(-50%, -100%)");

    trigger.onTouchMove(binding(1, "fire", 736, 200, 736, 164));
    expect(fill.style.transform).toBe("scaleY(0.5)");
    expect(readout.textContent).toBe("50%");
    expect(trigger.element.getAttribute("aria-valuenow")).toBe("128");

    trigger.onTouchEnd(binding(1, "fire", 736, 200, 736, 164));
    expect(fill.style.transform).toBe("scaleY(0)");
    expect(readout.hidden).toBe(true);
    expect(ctx.input.snapshot(0).lt).toBe(0);
  });

  it("[FR-8.7] the trigger readout expires after 600 ms without dropping the press", () => {
    vi.useFakeTimers();
    const ctx = freshContext();
    const trigger = createControl(TRIGGER, ctx);
    const readout = part(trigger, "value");
    const touch = binding(1, "fire", 736, 200);

    trigger.onTouchStart(touch);
    expect(readout.hidden).toBe(false);
    vi.advanceTimersByTime(599);
    expect(readout.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(readout.hidden).toBe(true);

    // The readout is transient; the analog state stays live (CP-10).
    expect(trigger.element.classList.contains("is-pressed")).toBe(true);
    expect(ctx.input.snapshot(0).lt).toBe(128);

    trigger.onTouchEnd(touch);
    expect(ctx.input.snapshot(0).lt).toBe(0);
  });

  it("[FR-8.7] a horizontal trigger maps left to right and reads out the value", () => {
    const ctx = freshContext();
    const trigger = createControl({ ...TRIGGER, id: "fire-h", orientation: "horizontal" }, ctx);
    const fill = part(trigger, "fill");

    trigger.onTouchStart(binding(1, "fire-h", 700, 200));
    expect(fill.style.transform).toBe("scaleX(0)");

    trigger.onTouchMove(binding(1, "fire-h", 736, 200, 700, 200));
    expect(fill.style.transform).toBe("scaleX(0.5)");
    expect(ctx.input.snapshot(0).lt).toBe(128);
    expect(part(trigger, "value").textContent).toBe("50%");

    trigger.onTouchEnd(binding(1, "fire-h", 736, 200, 700, 200));
    expect(ctx.input.snapshot(0).lt).toBe(0);
  });
});

describe("[FR-7.7] touchpad absolute mapping with a visible trail", () => {
  it("[FR-7.7] center is zero, edges are +/-32767 and the trail tracks the knob", () => {
    const ctx = freshContext();
    const pad = createControl(TOUCHPAD, ctx);
    const knob = part(pad, "knob");
    const trail = part(pad, "trail");

    pad.onTouchStart(binding(1, "pad", 400, 200));
    expect(pad.element.classList.contains("is-pressed")).toBe(true);
    expect(trail.hidden).toBe(false);
    expect(ctx.input.snapshot(0).rx).toBe(0);
    expect(ctx.input.snapshot(0).ry).toBe(0);

    pad.onTouchMove(binding(1, "pad", 460, 200, 400, 200));
    expect(ctx.input.snapshot(0).rx).toBe(16384);
    expect(ctx.input.snapshot(0).ry).toBe(0);
    expect(knob.style.transform).toContain("translate3d(60.00px, 0.00px, 0)");
    expect(trail.style.transform).toContain("rotate(0.0000rad)");

    pad.onTouchMove(binding(1, "pad", 400, 160, 400, 200));
    expect(ctx.input.snapshot(0).rx).toBe(0);
    expect(ctx.input.snapshot(0).ry).toBe(-32767);
    expect(knob.style.transform).toContain("translate3d(0.00px, -40.00px, 0)");
    expect(trail.style.transform).toContain("rotate(-1.5708rad)");

    pad.onTouchEnd(binding(1, "pad", 400, 160, 400, 200));
    expect(trail.hidden).toBe(true);
    expect(ctx.input.snapshot(0).rx).toBe(0);
    expect(ctx.input.snapshot(0).ry).toBe(0);
  });
});

describe("[FR-8.3] renderers own geometry, styles.css owns colour", () => {
  it("[FR-8.3] no renderer writes inline colour or opacity and boxes never move", () => {
    const ctx = freshContext();
    const stick = createControl(STICK, ctx);
    const trigger = createControl(TRIGGER, ctx);
    const pad = createControl(TOUCHPAD, ctx);
    const controls = [stick, trigger, pad];

    for (const renderer of controls) {
      for (const node of [renderer.element, ...renderer.element.querySelectorAll<HTMLElement>("*")]) {
        expect(node.style.background, `${renderer.id} background`).toBe("");
        expect(node.style.backgroundColor, `${renderer.id} background-color`).toBe("");
        expect(node.style.backgroundImage, `${renderer.id} background-image`).toBe("");
        expect(node.style.border, `${renderer.id} border`).toBe("");
        expect(node.style.color, `${renderer.id} colour`).toBe("");
        expect(node.style.opacity, `${renderer.id} opacity`).toBe("");
      }
    }

    const boxes = controls.map((renderer) => [
      renderer.element.style.left,
      renderer.element.style.top,
      renderer.element.style.width,
      renderer.element.style.height,
    ]);

    stick.onTouchStart(binding(1, "move", 400, 200));
    stick.onTouchMove(binding(1, "move", 500, 250, 400, 200));
    stick.onTouchEnd(binding(1, "move", 500, 250, 400, 200));
    trigger.onTouchStart(binding(2, "fire", 736, 164));
    trigger.onTouchMove(binding(2, "fire", 736, 200, 736, 164));
    trigger.onTouchEnd(binding(2, "fire", 736, 200, 736, 164));
    pad.onTouchStart(binding(3, "pad", 460, 200));
    pad.onTouchMove(binding(3, "pad", 400, 160, 460, 200));
    pad.onTouchEnd(binding(3, "pad", 400, 160, 460, 200));

    expect(
      controls.map((renderer) => [
        renderer.element.style.left,
        renderer.element.style.top,
        renderer.element.style.width,
        renderer.element.style.height,
      ]),
    ).toEqual(boxes);
  });
});
