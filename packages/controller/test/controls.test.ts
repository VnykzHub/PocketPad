/**
 * Control renderer tests (D2-CTRL-02; FR-8.1, FR-8.2, FR-8.3, FR-8.7, FR-7.4,
 * AR-5). jsdom provides the DOM; touch input is simulated by calling the
 * renderer handlers directly with `TouchBinding` objects, exactly as the
 * D2-CTRL-01 engine would.
 */
import { describe, expect, it } from "vitest";
import type { ButtonControl, Control, DpadControl, StickControl } from "@lanpad/sdk";
import { InputStore } from "../src/input/InputStore.js";
import {
  clampTouchTarget,
  controlHitRect,
  type ControlContext,
  type ControlRenderer,
  type SurfaceSize,
} from "../src/controls/control.js";
import { createControl, createControls, registerControl } from "../src/controls/registry.js";
import type { TouchBinding } from "../src/touch/touchEngine.js";

const SURFACE: SurfaceSize = { width: 800, height: 400 };

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
  bits: { up: 8, down: 9, left: 10, right: 11 },
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

function boxStyle(element: HTMLElement): string[] {
  return [element.style.left, element.style.top, element.style.width, element.style.height];
}

describe("[FR-8.7] same-frame pressed state", () => {
  it("[FR-8.7] button pressed class and input bit are applied synchronously on touchstart", () => {
    const ctx = freshContext();
    const renderer = createControl(BUTTON, ctx);
    const touch = binding(1, "jump", 656, 280);

    expect(renderer.element.classList.contains("is-pressed")).toBe(false);
    expect(ctx.input.snapshot(0).buttons).toBe(0);

    renderer.onTouchStart(touch);

    // Everything below is asserted after the handler returns with no frame
    // boundary in between: the state was visible during the event (FR-8.7).
    expect(renderer.element.classList.contains("is-pressed")).toBe(true);
    expect(renderer.element.style.transform).toContain("scale(0.92)");
    expect(renderer.element.style.opacity).toBe("0.72");
    expect(renderer.element.getAttribute("aria-pressed")).toBe("true");
    expect(ctx.input.snapshot(0).buttons).toBe(1 << BUTTON.bit);
    expect(ctx.input.snapshot(0).edges).toBe(1 << BUTTON.bit);
    expect(renderer.getState().buttons).toBe(1 << BUTTON.bit);

    renderer.onTouchEnd(touch);

    expect(renderer.element.classList.contains("is-pressed")).toBe(false);
    expect(renderer.element.style.transform).toContain("scale(1)");
    expect(ctx.input.snapshot(0).buttons).toBe(0);
    // The press edge survives the release until the host polls it (FR-7.3).
    expect(ctx.input.snapshot(0).edges).toBe(1 << BUTTON.bit);
  });

  it("[FR-8.7] a second finger keeps the button pressed until the last release", () => {
    const ctx = freshContext();
    const renderer = createControl(BUTTON, ctx);
    const first = binding(1, "jump", 656, 280);
    const second = binding(2, "jump", 680, 300);

    renderer.onTouchStart(first);
    renderer.onTouchStart(second);
    renderer.onTouchEnd(first);

    expect(renderer.element.classList.contains("is-pressed")).toBe(true);
    expect(ctx.input.snapshot(0).buttons).toBe(1 << BUTTON.bit);

    renderer.onTouchEnd(second);
    expect(renderer.element.classList.contains("is-pressed")).toBe(false);
    expect(ctx.input.snapshot(0).buttons).toBe(0);
  });
});

describe("[FR-8.1] controls render and map from layout data", () => {
  it("[FR-8.1] button, dpad and stick render from layout data", () => {
    const ctx = freshContext();
    const button = createControl(BUTTON, ctx);
    const dpad = createControl(DPAD, ctx);
    const stick = createControl(STICK, ctx);

    expect(button.id).toBe("jump");
    expect(button.element.dataset["controlType"]).toBe("button");
    expect(button.element.getAttribute("role")).toBe("button");
    expect(button.element.getAttribute("aria-label")).toBe("Jump");
    expect(button.element.style.left).toBe("612px");
    expect(button.element.style.top).toBe("236px");
    expect(button.element.style.width).toBe("88px");
    expect(button.element.style.height).toBe("88px");
    expect(button.element.style.borderRadius).toBe("50%");
    expect(part(button, "label").textContent).toBe("Jump");

    expect(dpad.element.dataset["controlType"]).toBe("dpad");
    expect(dpad.element.style.left).toBe("100px");
    expect(dpad.element.style.top).toBe("240px");
    expect(dpad.element.style.width).toBe("120px");
    expect(dpad.element.style.height).toBe("120px");
    for (const direction of ["up", "right", "down", "left"]) {
      const zone = part(dpad, `zone-${direction}`);
      expect(zone.dataset["direction"]).toBe(direction);
    }

    expect(stick.element.dataset["controlType"]).toBe("stick");
    expect(stick.element.style.left).toBe("300px");
    expect(stick.element.style.top).toBe("100px");
    expect(stick.element.style.width).toBe("200px");
    expect(stick.element.style.height).toBe("200px");
    expect(part(stick, "base")).not.toBeNull();
    expect(part(stick, "knob")).not.toBeNull();

    expect(createControls([BUTTON, DPAD, STICK], freshContext()).map((control) => control.id)).toEqual([
      "jump",
      "move",
      "look",
    ]);
  });

  it("[FR-8.1] dpad cardinal presses set one bit and diagonals set exactly two", () => {
    const ctx = freshContext();
    const renderer = createControl(DPAD, ctx);
    const start = binding(1, "move", 160, 300);

    // Diagonal up-right: sectors name the nearest two zones.
    renderer.onTouchStart(binding(1, "move", 190, 270));
    expect(ctx.input.snapshot(0).buttons).toBe((1 << 8) | (1 << 11));
    expect(renderer.getState().buttons).toBe((1 << 8) | (1 << 11));
    expect(part(renderer, "zone-up").classList.contains("is-pressed")).toBe(true);
    expect(part(renderer, "zone-right").classList.contains("is-pressed")).toBe(true);

    // Cardinal right: only the right bit remains.
    ctx.input.clearEdges();
    renderer.onTouchMove(binding(1, "move", 200, 300, start.startX, start.startY));
    expect(ctx.input.snapshot(0).buttons).toBe(1 << 11);
    expect(part(renderer, "zone-up").classList.contains("is-pressed")).toBe(false);
    expect(part(renderer, "zone-right").classList.contains("is-pressed")).toBe(true);

    // Diagonal down-left: exactly two bits.
    renderer.onTouchMove(binding(1, "move", 130, 330, start.startX, start.startY));
    expect(ctx.input.snapshot(0).buttons).toBe((1 << 9) | (1 << 10));

    // Cardinal left, then a center press that sets no direction.
    renderer.onTouchMove(binding(1, "move", 130, 300, start.startX, start.startY));
    expect(ctx.input.snapshot(0).buttons).toBe(1 << 10);

    renderer.onTouchMove(binding(1, "move", 160, 300, start.startX, start.startY));
    expect(ctx.input.snapshot(0).buttons).toBe(0);
    expect(renderer.element.classList.contains("is-pressed")).toBe(false);

    renderer.onTouchEnd(binding(1, "move", 160, 300, start.startX, start.startY));
    expect(ctx.input.snapshot(0).buttons).toBe(0);
  });

  it("[FR-8.1] floating stick base appears at the touch point and fixed stick base does not move", () => {
    const floating: StickControl = { ...STICK, id: "float", mode: "floating" };
    const floatingRenderer = createControl(floating, freshContext());
    const floatBase = part(floatingRenderer, "base");
    expect(floatBase.style.opacity).toBe("0");

    floatingRenderer.onTouchStart(binding(1, "float", 300, 150));
    expect(floatBase.style.opacity).toBe("1");
    // Layout center is (400, 200); the base moved (-100, -50) to the touch.
    expect(floatBase.style.transform).toBe(
      "translate(-50%, -50%) translate3d(-100px, -50px, 0)",
    );

    const fixedRenderer = createControl(STICK, freshContext());
    const fixedBase = part(fixedRenderer, "base");
    const fixedTransform = fixedBase.style.transform;

    fixedRenderer.onTouchStart(binding(2, "look", 300, 150));
    fixedRenderer.onTouchMove(binding(2, "look", 350, 180, 300, 150));
    expect(fixedBase.style.transform).toBe(fixedTransform);
  });

  it("[FR-8.1] debug mode outlines the control bounds without moving them", () => {
    const ctx: ControlContext = {
      input: new InputStore(),
      surfaceSize: SURFACE,
      debug: { outline: true },
    };
    const renderer = createControl(BUTTON, ctx);

    expect(renderer.element.style.outline).toContain("dashed");
    expect(renderer.element.style.left).toBe("612px");
    expect(renderer.element.style.top).toBe("236px");
  });

  it("[FR-8.1] D5 types render and unknown control types fail with clear errors", () => {
    const ctx = freshContext();
    const panel: Control = {
      type: "panel",
      id: "secret",
      x: "30%",
      y: "10%",
      w: "40%",
      h: "30%",
    };
    // D5-CTRL-01 registered the remaining v1 types; panel now renders.
    expect(createControl(panel, ctx).element.dataset["controlType"]).toBe("panel");

    const unknown = { type: "hologram", id: "x", x: "0%", y: "0%" } as unknown as Control;
    expect(() => createControl(unknown, ctx)).toThrow(/Unknown control type/);
  });
});

describe("[FR-7.4] stick deadzone, normalization and i16 clamping", () => {
  it("[FR-7.4] stick deadzone is 8% by default and clamps to i16", () => {
    const ctx = freshContext();
    const renderer = createControl(STICK, ctx);
    const origin = binding(1, "look", 400, 200);

    renderer.onTouchStart(origin);
    expect(ctx.input.snapshot(0).lx).toBe(0);
    expect(ctx.input.snapshot(0).ly).toBe(0);

    // 100% deflection: radius is 100 px.
    renderer.onTouchMove(binding(1, "look", 500, 200, 400, 200));
    expect(ctx.input.snapshot(0).lx).toBe(32767);
    expect(ctx.input.snapshot(0).ly).toBe(0);
    expect(renderer.getState().lx).toBe(32767);

    // 7% deflection is inside the 8% deadzone.
    renderer.onTouchMove(binding(1, "look", 407, 200, 400, 200));
    expect(ctx.input.snapshot(0).lx).toBe(0);

    // 20% deflection is outside the deadzone and rescaled, not clamped.
    renderer.onTouchMove(binding(1, "look", 420, 200, 400, 200));
    expect(ctx.input.snapshot(0).lx).toBe(4274);
    expect(renderer.getState().lx).toBe(4274);

    // Pulling far past the radius still clamps to the i16 maximum.
    renderer.onTouchMove(binding(1, "look", 900, 200, 400, 200));
    expect(ctx.input.snapshot(0).lx).toBe(32767);

    renderer.onTouchMove(binding(1, "look", 0, 200, 400, 200));
    expect(ctx.input.snapshot(0).lx).toBe(-32767);

    renderer.onTouchEnd(binding(1, "look", 0, 200, 400, 200));
    expect(ctx.input.snapshot(0).lx).toBe(0);
    expect(ctx.input.snapshot(0).ly).toBe(0);
    expect(renderer.getState()).toEqual({ lx: 0, ly: 0 });
    expect(part(renderer, "knob").style.transition).toContain("120ms");
  });

  it("[FR-7.4] a right-axis stick writes rx/ry and honors a custom deadzone", () => {
    const right: StickControl = { ...STICK, id: "right", axis: "right", deadzone: 0.2 };
    const ctx = freshContext();
    const renderer = createControl(right, ctx);

    renderer.onTouchStart(binding(1, "right", 400, 200));
    renderer.onTouchMove(binding(1, "right", 410, 204, 400, 200));

    // 10.8 px of a 100 px radius is inside the custom 20% deadzone.
    expect(ctx.input.snapshot(0).rx).toBe(0);
    expect(ctx.input.snapshot(0).ry).toBe(0);
    expect(ctx.input.snapshot(0).lx).toBe(0);
    expect(renderer.getState()).toEqual({ rx: 0, ry: 0 });

    renderer.onTouchMove(binding(1, "right", 500, 200, 400, 200));
    expect(ctx.input.snapshot(0).rx).toBe(32767);
    expect(ctx.input.snapshot(0).lx).toBe(0);
  });
});

describe("[FR-8.3] feedback stays on transform and opacity", () => {
  it("[FR-8.3] control feedback uses transform and opacity only", () => {
    const ctx = freshContext();
    const button = createControl(BUTTON, ctx);
    const dpad = createControl(DPAD, ctx);
    const stick = createControl(STICK, ctx);

    const buttonBox = boxStyle(button.element);
    const dpadBox = boxStyle(dpad.element);
    const stickBox = boxStyle(stick.element);

    button.onTouchStart(binding(1, "jump", 656, 280));
    button.onTouchEnd(binding(1, "jump", 656, 280));

    dpad.onTouchStart(binding(2, "move", 190, 270));
    dpad.onTouchMove(binding(2, "move", 130, 330, 190, 270));
    dpad.onTouchEnd(binding(2, "move", 130, 330, 190, 270));

    stick.onTouchStart(binding(3, "look", 400, 200));
    stick.onTouchMove(binding(3, "look", 450, 230, 400, 200));
    stick.onTouchEnd(binding(3, "look", 450, 230, 400, 200));

    expect(boxStyle(button.element)).toEqual(buttonBox);
    expect(boxStyle(dpad.element)).toEqual(dpadBox);
    expect(boxStyle(stick.element)).toEqual(stickBox);

    // Pressed feedback is expressed with transform/opacity on the control or
    // its parts, and the knob moved through transform only.
    expect(button.element.style.transform).toContain("scale(1)");
    expect(part(stick, "knob").style.transform).toContain("translate3d");
    expect(part(stick, "knob").style.transition).toContain("120ms");
  });
});

describe("[AR-5] minimum touch targets", () => {
  it("[AR-5] rendered control boxes meet the 44px minimum", () => {
    const ctx = freshContext();
    const tinyCircle: ButtonControl = { ...BUTTON, id: "tiny-circle", r: "10px" };
    const tinySquare: ButtonControl = { ...BUTTON, id: "tiny-square", shape: "square", r: "10px" };
    const tinyDpad: DpadControl = { ...DPAD, id: "tiny-dpad", size: "10px" };
    const tinyStick: StickControl = { ...STICK, id: "tiny-stick", size: "10px" };

    for (const control of [tinyCircle, tinySquare, tinyDpad, tinyStick]) {
      const renderer = createControl(control, ctx);
      const rect = controlHitRect(control, SURFACE);
      expect(Number.parseFloat(renderer.element.style.width)).toBeGreaterThanOrEqual(44);
      expect(Number.parseFloat(renderer.element.style.height)).toBeGreaterThanOrEqual(44);
      expect(rect.width).toBeGreaterThanOrEqual(44);
      expect(rect.height).toBeGreaterThanOrEqual(44);
      expect(rect.width).toBe(Number.parseFloat(renderer.element.style.width));
      expect(rect.height).toBe(Number.parseFloat(renderer.element.style.height));
    }

    expect(clampTouchTarget(10)).toBe(44);
    expect(clampTouchTarget(88)).toBe(88);
  });

  it("[AR-5] a circle uses r as its radius and a square uses r as its edge", () => {
    const ctx = freshContext();
    const circle = createControl({ ...BUTTON, id: "c", r: "10px" }, ctx);
    const square = createControl({ ...BUTTON, id: "s", shape: "square", r: "100px" }, ctx);

    // Circle: 2 * 10 px, raised to the 44 px target floor.
    expect(circle.element.style.width).toBe("44px");
    // Square: the 100 px edge is already above the floor.
    expect(square.element.style.width).toBe("100px");
  });
});

describe("[FR-8.2] layout hot-swap", () => {
  it("[FR-8.2] controls can be disposed and rebuilt for a new layout without a reload", () => {
    const surface = document.createElement("div");
    document.body.append(surface);
    const ctx = freshContext();

    const oldControls = createControls([BUTTON, STICK], ctx);
    for (const control of oldControls) {
      surface.append(control.element);
    }
    oldControls[0]?.onTouchStart(binding(1, "jump", 656, 280));
    expect(ctx.input.snapshot(0).buttons).toBe(1);

    for (const control of oldControls) {
      control.dispose();
    }

    // The old layout released its bits and left the DOM; the store is clean.
    expect(ctx.input.snapshot(0).buttons).toBe(0);
    expect(ctx.input.snapshot(0).lx).toBe(0);
    expect(oldControls.every((control) => !control.element.isConnected)).toBe(true);
    expect(surface.childElementCount).toBe(0);

    const newControls = createControls([DPAD], ctx);
    for (const control of newControls) {
      surface.append(control.element);
    }
    newControls[0]?.onTouchStart(binding(2, "move", 160, 240));

    expect(newControls[0]?.id).toBe("move");
    expect(surface.childElementCount).toBe(1);
    expect(ctx.input.snapshot(0).buttons).toBe(1 << 8);

    newControls[0]?.dispose();
    surface.remove();
  });

  it("[FR-8.2] the registry can accept a renderer for a later control type", () => {
    const ctx = freshContext();
    let builtId: string | null = null;

    registerControl("gyro", (control) => {
      builtId = control.id;
      const element = document.createElement("div");
      return {
        id: control.id,
        element,
        setPressed: () => {},
        onTouchStart: () => {},
        onTouchMove: () => {},
        onTouchEnd: () => {},
        onTouchCancel: () => {},
        getState: () => ({}),
        dispose: () => element.remove(),
      };
    });

    const gyro: Control = { type: "gyro", id: "aim", x: "50%", y: "50%" };
    const renderer = createControl(gyro, ctx);
    expect(renderer.id).toBe("aim");
    expect(builtId).toBe("aim");
  });
});
