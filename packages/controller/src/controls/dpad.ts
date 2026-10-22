/**
 * D-pad control renderer (D2-CTRL-02; FR-8.1, FR-8.3, FR-8.7, AR-5).
 *
 * Four directional zones inside one square box. A touch is classified into one
 * of eight 45-degree sectors: cardinal sectors press one bit, diagonal sectors
 * press the nearest two bits, and a small center dead zone presses none. Each
 * zone highlights in the same call that sets its bit (FR-8.7); the highlight
 * is the shared `is-pressed` class, so no layout property moves (FR-8.3).
 *
 * PAGE-PLANS CP-08: every wedge carries a CSS-drawn arrow glyph, the hub is a
 * drawn disc, and two adjacent wedges lighting together is the diagonal cue.
 * `styles.css` owns every fill and colour; the renderer owns geometry, the
 * glyph shapes and the state classes.
 *
 * Multiple fingers on one d-pad are tracked independently and their direction
 * masks are ORed, so releasing one finger cannot clear a direction another
 * finger still holds.
 */
import type { DpadControl } from "@lanpad/sdk";
import type { InputState } from "@lanpad/protocol";
import {
  applyControlClasses,
  applyControlElementStyle,
  createPart,
  measureControl,
  notifyDebugState,
  setPressed,
  type ControlContext,
  type ControlRenderer,
} from "./control.js";
import type { TouchBinding } from "../touch/touchEngine.js";

type DirectionName = "up" | "right" | "down" | "left";

const DIRECTION_NAMES: readonly DirectionName[] = ["up", "right", "down", "left"];

/**
 * Angle sectors, clockwise from "east" in screen coordinates (y points down):
 * 0 = right, 1 = down-right, 2 = down, ... A diagonal sector names both of its
 * adjacent cardinal directions, which is the "nearest two zones" rule in
 * D2-CTRL-02.
 */
const SECTOR_DIRECTIONS: readonly (readonly DirectionName[])[] = [
  ["right"],
  ["right", "down"],
  ["down"],
  ["down", "left"],
  ["left"],
  ["left", "up"],
  ["up"],
  ["up", "right"],
];

/** Four 90-degree wedges meeting at the center, so diagonals light both. */
const ZONE_CLIP: Record<DirectionName, string> = {
  up: "polygon(50% 50%, 0% 0%, 100% 0%)",
  right: "polygon(50% 50%, 100% 0%, 100% 100%)",
  down: "polygon(50% 50%, 100% 100%, 0% 100%)",
  left: "polygon(50% 50%, 0% 100%, 0% 0%)",
};

/** Solid arrow drawn inside each wedge; colour inherits from the zone. */
const ARROW_CLIP: Record<DirectionName, string> = {
  up: "polygon(50% 0%, 100% 50%, 65% 50%, 65% 100%, 35% 100%, 35% 50%, 0% 50%)",
  right: "polygon(100% 50%, 50% 0%, 50% 35%, 0% 35%, 0% 65%, 50% 65%, 50% 100%)",
  down: "polygon(50% 100%, 100% 50%, 65% 50%, 65% 0%, 35% 0%, 35% 50%, 0% 50%)",
  left: "polygon(0% 50%, 50% 0%, 50% 35%, 100% 35%, 100% 65%, 50% 65%, 50% 100%)",
};

/**
 * Each arrow sits on its wedge, clear of the 24% hub at the centre. The
 * stylesheet supplies the translate(-50%, -50%) centring transform.
 */
const ARROW_POSITION: Record<DirectionName, { readonly left: string; readonly top: string }> = {
  up: { left: "50%", top: "30%" },
  right: { left: "70%", top: "50%" },
  down: { left: "50%", top: "70%" },
  left: { left: "30%", top: "50%" },
};

const ARROW_GLYPH_PX = 14;

/** Fraction of the radius around the center that presses no direction. */
const CENTER_DEAD_ZONE_RATIO = 0.12;
const CENTER_DEAD_ZONE_MIN_PX = 6;

interface DirectionState {
  readonly bit: number;
  readonly zone: HTMLElement;
  active: boolean;
}

export function createDpadControl(control: DpadControl, ctx: ControlContext): ControlRenderer {
  const box = measureControl(control, ctx.surfaceSize);
  const element = document.createElement("div");
  applyControlElementStyle(element, control, box, ctx);
  applyControlClasses(element, "dpad");
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", `d-pad ${control.id}`);

  const directions = {} as Record<DirectionName, DirectionState>;
  for (const name of DIRECTION_NAMES) {
    const zone = createPart("div", `zone-${name}`);
    zone.dataset["direction"] = name;
    zone.setAttribute("aria-hidden", "true");
    zone.style.position = "absolute";
    zone.style.left = "0";
    zone.style.top = "0";
    zone.style.width = "100%";
    zone.style.height = "100%";
    zone.style.clipPath = ZONE_CLIP[name];
    zone.style.pointerEvents = "none";

    const glyph = createPart("span", "glyph");
    glyph.setAttribute("aria-hidden", "true");
    glyph.style.display = "block";
    glyph.style.width = `${ARROW_GLYPH_PX}px`;
    glyph.style.height = `${ARROW_GLYPH_PX}px`;
    glyph.style.left = ARROW_POSITION[name].left;
    glyph.style.top = ARROW_POSITION[name].top;
    glyph.style.backgroundColor = "currentColor";
    glyph.style.clipPath = ARROW_CLIP[name];
    zone.append(glyph);

    element.append(zone);
    directions[name] = { bit: control.bits[name], zone, active: false };
  }

  const hub = createPart("div", "hub");
  hub.setAttribute("aria-hidden", "true");
  element.append(hub);

  /** Direction mask per active touch identifier. */
  const directionTouches = new Map<number, number>();
  let pressed = false;

  const unionMask = (): number => {
    let mask = 0;
    for (const touchMask of directionTouches.values()) {
      mask |= touchMask;
    }
    return mask;
  };

  const maskForPoint = (x: number, y: number): number => {
    const dx = x - box.centerX;
    const dy = y - box.centerY;
    const radius = box.width / 2;
    const distance = Math.hypot(dx, dy);
    const deadZonePx = Math.max(CENTER_DEAD_ZONE_MIN_PX, radius * CENTER_DEAD_ZONE_RATIO);
    if (distance <= deadZonePx) {
      return 0;
    }

    const sector = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
    const names = SECTOR_DIRECTIONS[sector] ?? [];
    let mask = 0;
    for (const name of names) {
      mask |= 1 << directions[name].bit;
    }
    return mask;
  };

  const applyVisual = (active: boolean): void => {
    if (active === pressed) {
      return;
    }
    pressed = active;
    setPressed(element, active);
    notifyDebugState(ctx, control.id, active);
  };

  const applyUnion = (previous: number): void => {
    const next = unionMask();
    if (next === previous) {
      return;
    }

    for (const name of DIRECTION_NAMES) {
      const direction = directions[name];
      const mask = 1 << direction.bit;
      const before = (previous & mask) !== 0;
      const after = (next & mask) !== 0;
      if (before === after) {
        continue;
      }

      direction.active = after;
      setPressed(direction.zone, after);
      ctx.input.setButton(direction.bit, after);
    }

    applyVisual(next !== 0);
  };

  const setTouchMask = (binding: TouchBinding, mask: number): void => {
    const previous = unionMask();
    directionTouches.set(binding.identifier, mask);
    applyUnion(previous);
  };

  const clearTouch = (binding: TouchBinding): void => {
    if (!directionTouches.has(binding.identifier)) {
      return;
    }
    const previous = unionMask();
    directionTouches.delete(binding.identifier);
    applyUnion(previous);
  };

  return {
    id: control.id,
    element,

    setPressed(active: boolean): void {
      applyVisual(active);
    },

    onTouchStart(binding: TouchBinding): void {
      if (directionTouches.has(binding.identifier)) {
        return;
      }
      setTouchMask(binding, maskForPoint(binding.startX, binding.startY));
    },

    onTouchMove(binding: TouchBinding): void {
      if (!directionTouches.has(binding.identifier)) {
        return;
      }
      setTouchMask(binding, maskForPoint(binding.lastX, binding.lastY));
    },

    onTouchEnd(binding: TouchBinding): void {
      clearTouch(binding);
    },

    onTouchCancel(binding: TouchBinding): void {
      clearTouch(binding);
    },

    getState(): Partial<InputState> {
      return { buttons: unionMask() };
    },

    dispose(): void {
      directionTouches.clear();
      for (const name of DIRECTION_NAMES) {
        const direction = directions[name];
        if (direction.active) {
          direction.active = false;
          setPressed(direction.zone, false);
          ctx.input.setButton(direction.bit, false);
        }
      }
      applyVisual(false);
      element.remove();
    },
  };
}
