/**
 * D-pad control renderer (D2-CTRL-02; FR-8.1, FR-8.3, FR-8.7, AR-5).
 *
 * Four directional zones inside one square box. A touch is classified into one
 * of eight 45-degree sectors: cardinal sectors press one bit, diagonal sectors
 * press the nearest two bits, and a small center dead zone presses none. Each
 * zone highlights in the same call that sets its bit (FR-8.7); highlight is an
 * opacity change, so no layout property moves (FR-8.3).
 *
 * Multiple fingers on one d-pad are tracked independently and their direction
 * masks are ORed, so releasing one finger cannot clear a direction another
 * finger still holds.
 */
import type { DpadControl } from "@lanpad/sdk";
import type { InputState } from "@lanpad/protocol";
import {
  applyControlElementStyle,
  createPart,
  measureControl,
  notifyDebugState,
  PRESSED_CLASS,
  setPressedClass,
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

const IDLE_ZONE_OPACITY = "0.35";
const PRESSED_ZONE_OPACITY = "1";
const IDLE_TRANSFORM = "scale(1)";
const PRESSED_TRANSFORM = "scale(0.98)";
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
  element.classList.add("control", "control-dpad");
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", `d-pad ${control.id}`);
  element.style.borderRadius = "18%";
  element.style.background = "rgba(255, 255, 255, 0.06)";
  element.style.border = "1px solid rgba(255, 255, 255, 0.35)";
  element.style.overflow = "hidden";

  const directions = {} as Record<DirectionName, DirectionState>;
  for (const name of DIRECTION_NAMES) {
    const zone = createPart("div", `zone-${name}`);
    zone.dataset["direction"] = name;
    zone.style.position = "absolute";
    zone.style.left = "0";
    zone.style.top = "0";
    zone.style.width = "100%";
    zone.style.height = "100%";
    zone.style.clipPath = ZONE_CLIP[name];
    zone.style.background = "rgba(255, 255, 255, 0.32)";
    zone.style.opacity = IDLE_ZONE_OPACITY;
    zone.style.pointerEvents = "none";
    element.append(zone);
    directions[name] = { bit: control.bits[name], zone, active: false };
  }

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
    setPressedClass(element, active);
    element.style.transform = active ? PRESSED_TRANSFORM : IDLE_TRANSFORM;
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
      direction.zone.classList.toggle(PRESSED_CLASS, after);
      direction.zone.style.opacity = after ? PRESSED_ZONE_OPACITY : IDLE_ZONE_OPACITY;
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
          direction.zone.style.opacity = IDLE_ZONE_OPACITY;
          ctx.input.setButton(direction.bit, false);
        }
      }
      applyVisual(false);
      element.remove();
    },
  };
}
