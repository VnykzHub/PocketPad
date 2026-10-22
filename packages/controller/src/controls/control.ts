/**
 * Controller control renderer contract and shared geometry (D2-CTRL-02;
 * FR-8.1, FR-8.3, FR-8.7, AR-5).
 *
 * A control turns a validated layout entry into one absolutely positioned DOM
 * element and maps semantic `TouchBinding` events onto `InputStore` state. The
 * registry (`registry.ts`) owns construction; this module owns the interface
 * every later control type implements and the length/anchor math they share.
 *
 * Coordinate model (frozen by D2-LAYOUT-01 and documented in the schema):
 * - `x`/`y` percentages are relative to the surface width/height.
 * - `size`/`r` percentages are relative to `min(width, height)`.
 * - The renderer anchors a control at the layout point `(x, y)`: `x`/`y` is
 *   the center of the rendered box (D2-CTRL-02 states fixed sticks are
 *   "centered at layout position", and the same anchor keeps the SPEC §8.1
 *   example inside the viewport).
 *
 * AR-5: a rendered box is never smaller than 44x44 CSS px. Layouts that ask for
 * less are enlarged at render time; the hit rect uses the same box, so the
 * touch target and the visible control always agree.
 *
 * Feedback is applied synchronously inside the touch handlers and uses only
 * `transform`/`opacity`; nothing here changes `top`/`left`/`width`/`height`
 * after construction (FR-8.3, FR-8.7). There are no network calls, timers or
 * global listeners in this layer.
 */
import {
  parseLength,
  type ButtonControl,
  type Control,
  type DpadControl,
  type Length,
  type StickControl,
} from "@lanpad/sdk";
import type { InputState } from "@lanpad/protocol";
import type { InputStore } from "../input/InputStore.js";
import { MIN_TOUCH_TARGET_PX, type HitRect } from "../touch/hitTest.js";
import type { TouchBinding } from "../touch/touchEngine.js";
import type { ControlEventSink } from "./eventSink.js";
import type { ViewportTracker } from "../layout/viewport.js";

/** Surface size in CSS pixels; viewport dimensions for percent lengths. */
export interface SurfaceSize {
  readonly width: number;
  readonly height: number;
}

/** Optional hooks used by the `?layout=debug` overlay (D2-Ctrl-02 step 6). */
export interface ControlDebugHooks {
  /** Draw a dashed outline around every rendered control box. */
  outline?: boolean;
  /** Called synchronously after a pressed/axis state change. */
  onStateChange?: (controlId: string, pressed: boolean) => void;
}

/** Everything a renderer needs from the page shell. */
export interface ControlContext {
  /** Store the control writes its level contribution into. */
  input: InputStore;
  /** Current surface size, used to resolve percent lengths. */
  surfaceSize: SurfaceSize;
  debug?: ControlDebugHooks;
  /**
   * Event queue sink (D5-CTRL-05). Optional so input-only tests and the
   * pre-D5 shell keep working; an event-emitting control without a sink stays
   * interactive locally but sends nothing.
   */
  events?: ControlEventSink;
  /**
   * Visible-viewport tracker (D5-CTRL-03). Optional; text controls use it to
   * stay visible above the on-screen keyboard. The page shell owns and
   * disposes it.
   */
  viewport?: ViewportTracker;
}

/**
 * The extension point for every control type (frozen in D2-CTRL-02). D5 adds
 * trigger, touchpad, slider, gyro, choice, panel, text and canvas renderers
 * without changing this interface.
 */
export interface ControlRenderer {
  readonly id: string;
  readonly element: HTMLElement;
  /** Synchronous visual pressed state; `transform`/`opacity` only. */
  setPressed(active: boolean): void;
  onTouchStart(binding: TouchBinding): void;
  onTouchMove(binding: TouchBinding): void;
  onTouchEnd(binding: TouchBinding): void;
  onTouchCancel(binding: TouchBinding): void;
  /** Protocol-level contribution of this control (buttons and/or axes). */
  getState(): Partial<InputState>;
  dispose(): void;
}

/** Control types D2 renders; D5 extends the registry with the rest. */
export type RenderedControl = ButtonControl | DpadControl | StickControl;

/** Base class every rendered control carries, alongside one type class. */
export const CONTROL_CLASS = "control";

/** Prefix of the per-type grammar class; `button` becomes `control-button`. */
export const CONTROL_TYPE_CLASS_PREFIX = "control-";

/** Class toggled on a control (and dpad zones) while pressed. */
export const PRESSED_CLASS = "is-pressed";

/** Class toggled by `setDisabled` (DESIGN: Disabled). */
export const DISABLED_CLASS = "is-disabled";

/** Class toggled by `setUnavailable` (DESIGN: Unavailable, e.g. gyro denied). */
export const UNAVAILABLE_CLASS = "is-unavailable";

/**
 * Fixed size of the gyro "Enable motion" prompt. The layout schema gives a
 * gyro control no size field (D2-LAYOUT-01), so the prompt uses a comfortable
 * 44 px-high pill centered on its layout position.
 */
export const GYRO_PROMPT_WIDTH_PX = 168;
export const GYRO_PROMPT_HEIGHT_PX = 44;

/** Resolved rendered box of a control, in viewport CSS pixels. */
export interface ControlBox {
  centerX: number;
  centerY: number;
  left: number;
  top: number;
  width: number;
  height: number;
  /**
   * True when AR-5 raised the requested box to the 44 px minimum. The debug
   * overlay paints these with a dotted warning outline (D5-CTRL-01 step 2).
   */
  undersized: boolean;
}

/** Parses and resolves one layout length against a pixel reference. */
export function resolveLength(length: Length, reference: number): number {
  const parsed = parseLength(length);
  return parsed.kind === "percent" ? (reference * parsed.value) / 100 : parsed.value;
}

/** Resolves `x` against the surface width. */
export function resolveX(length: Length, surface: SurfaceSize): number {
  return resolveLength(length, surface.width);
}

/** Resolves `y` against the surface height. */
export function resolveY(length: Length, surface: SurfaceSize): number {
  return resolveLength(length, surface.height);
}

/** Resolves `size`/`r` against `min(width, height)` as D2-LAYOUT-01 requires. */
export function resolveControlSize(length: Length, surface: SurfaceSize): number {
  return resolveLength(length, Math.min(surface.width, surface.height));
}

/**
 * Raises a rendered edge to the 44 px minimum (AR-5). Called for every control
 * box so an undersized layout still yields a tappable target.
 */
export function clampTouchTarget(edgePx: number): number {
  if (!Number.isFinite(edgePx) || edgePx <= 0) {
    return MIN_TOUCH_TARGET_PX;
  }
  return Math.max(MIN_TOUCH_TARGET_PX, edgePx);
}

/** The box a layout asks for, before the AR-5 44 px floor is applied. */
function requestedEdges(control: Control, surface: SurfaceSize): { width: number; height: number } {
  switch (control.type) {
    case "button": {
      const sizePx = resolveControlSize(control.r, surface);
      const edge = control.shape === "circle" ? sizePx * 2 : sizePx;
      return { width: edge, height: edge };
    }
    case "dpad":
    case "stick":
    case "trigger": {
      const edge = resolveControlSize(control.size, surface);
      return { width: edge, height: edge };
    }
    case "gyro":
      return { width: GYRO_PROMPT_WIDTH_PX, height: GYRO_PROMPT_HEIGHT_PX };
    default:
      return {
        width: resolveLength(control.w, surface.width),
        height: resolveLength(control.h, surface.height),
      };
  }
}

/**
 * Resolves the rendered box for any v1 control (D2 + D5).
 *
 * A circle's `r` is its radius, so its box is `2r` square; `rounded` and
 * `square` treat `r` as the edge length (the schema's "radius/size" wording).
 * `size` is square; `w`/`h` resolve against the surface width/height; a gyro
 * prompt has a fixed pill size. All boxes are clamped to the AR-5 minimum and
 * centered on `(x, y)`, so the visual box and the hit rect never disagree.
 */
export function measureControl(control: Control, surface: SurfaceSize): ControlBox {
  const requested = requestedEdges(control, surface);
  const width = clampTouchTarget(requested.width);
  const height = clampTouchTarget(requested.height);
  const centerX = resolveX(control.x, surface);
  const centerY = resolveY(control.y, surface);

  return {
    centerX,
    centerY,
    left: centerX - width / 2,
    top: centerY - height / 2,
    width,
    height,
    undersized: requested.width < MIN_TOUCH_TARGET_PX || requested.height < MIN_TOUCH_TARGET_PX,
  };
}

/**
 * The cached hit rect for a control, in the same space as `Touch.clientX/Y`.
 * The renderer and `TouchEngine.setControls` share this function so the visual
 * box and the hit area can never drift apart (AR-5).
 */
export function controlHitRect(control: Control, surface: SurfaceSize): HitRect {
  const box = measureControl(control, surface);
  return {
    controlId: control.id,
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    z: control.z ?? 0,
  };
}

/**
 * Applies the fixed, construction-time style every control shares: absolute
 * position from the layout box, z-order, touch-action/user-select hardening
 * and the optional debug outline. Touch handlers must not touch these
 * positioning properties again (FR-8.3).
 */
export function applyControlElementStyle(
  element: HTMLElement,
  control: Control,
  box: ControlBox,
  ctx: ControlContext,
): void {
  const style = element.style;
  style.position = "absolute";
  style.left = `${box.left}px`;
  style.top = `${box.top}px`;
  style.width = `${box.width}px`;
  style.height = `${box.height}px`;
  style.zIndex = String(control.z ?? 0);
  style.touchAction = "none";
  style.userSelect = "none";
  style.setProperty("-webkit-user-select", "none");
  style.setProperty("-webkit-touch-callout", "none");

  // Layouts that ask for less than the AR-5 minimum are enlarged at render
  // time; the flag makes the debug overlay show where the layout is at fault.
  if (box.undersized) {
    element.dataset["targetClamped"] = "true";
  }

  if (ctx.debug?.outline === true) {
    style.outline = box.undersized
      ? "2px dotted rgba(255, 120, 120, 0.95)"
      : "1px dashed rgba(255, 255, 255, 0.65)";
    style.outlineOffset = "-1px";
  }

  element.dataset["controlId"] = control.id;
  element.dataset["controlType"] = control.type;
}

/** The per-type grammar class for `type`, e.g. `control-trigger`. */
export function controlTypeClass(type: Control["type"]): string {
  return `${CONTROL_TYPE_CLASS_PREFIX}${type}`;
}

/**
 * Applies the shared grammar classes — `control` plus `control-<type>` — used
 * by every renderer and by `styles.css`. Idempotent, so a hot-swap rebuild or a
 * second call cannot accumulate classes; one template string per call.
 */
export function applyControlClasses(element: HTMLElement, type: Control["type"]): void {
  element.classList.add(CONTROL_CLASS, controlTypeClass(type));
}

/** Toggles the shared pressed class without allocating a selector each time. */
export function setPressed(element: HTMLElement, pressed: boolean): void {
  element.classList.toggle(PRESSED_CLASS, pressed);
}

/** Existing name for `setPressed`, kept for the renderers that import it. */
export function setPressedClass(element: HTMLElement, pressed: boolean): void {
  setPressed(element, pressed);
}

/** Keeps `aria-disabled` true while either blocking state class is present. */
function syncAriaDisabled(element: HTMLElement): void {
  const blocked =
    element.classList.contains(DISABLED_CLASS) || element.classList.contains(UNAVAILABLE_CLASS);
  if (blocked) {
    element.setAttribute("aria-disabled", "true");
  } else {
    element.removeAttribute("aria-disabled");
  }
}

/**
 * Marks a control disabled (DESIGN: Disabled): neutral fill, label kept. This
 * is visual/assistive state only — gating touch handlers and clearing the
 * control's input contribution stays with the renderer.
 */
export function setDisabled(element: HTMLElement, disabled: boolean): void {
  element.classList.toggle(DISABLED_CLASS, disabled);
  if (disabled) {
    // A disabled control must not keep a stale press visual.
    setPressed(element, false);
  }
  syncAriaDisabled(element);
}

/**
 * Marks a control unavailable rather than disabled (DESIGN: Unavailable, e.g.
 * a denied gyro permission). The label stays; the one-line reason and fallback
 * control are the renderer's responsibility.
 */
export function setUnavailable(element: HTMLElement, unavailable: boolean): void {
  element.classList.toggle(UNAVAILABLE_CLASS, unavailable);
  syncAriaDisabled(element);
}

/**
 * Gives a control element a tab stop so an external keyboard or switch access
 * can reach it, which is what makes the native `:focus-visible` ring appear
 * (DESIGN: Focus and input; no JS focus class or listener is needed). Native
 * controls and elements with an explicit tabindex are left untouched, so
 * programmatic-only focus (`tabindex="-1"`) is preserved. Touch-only controls
 * simply never call this.
 */
export function makeControlFocusable(element: HTMLElement): void {
  if (element.tabIndex < 0 && !element.hasAttribute("tabindex")) {
    element.tabIndex = 0;
  }
}

/** Reports a state change to the optional debug overlay. */
export function notifyDebugState(ctx: ControlContext, controlId: string, pressed: boolean): void {
  ctx.debug?.onStateChange?.(controlId, pressed);
}

/** Adds a child element with a `data-part` marker used by tests and debugging. */
export function createPart<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  part: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.dataset["part"] = part;
  return element;
}
