/**
 * Button control renderer (D2-CTRL-02; FR-8.1, FR-8.3, FR-8.7, AR-5).
 *
 * One absolutely positioned element in the layout's shape. A touch sets the
 * layout's button bit in the `InputStore` and paints the pressed state before
 * the handler returns; no animation frame or network round-trip is involved
 * (FR-8.7). The pressed visual is the shared `is-pressed` class: `styles.css`
 * owns the fill, label colour and 0.97 scale, so the renderer writes no colour,
 * opacity or transform and the layout box never changes (FR-8.3).
 *
 * PAGE-PLANS CP-07: the layout's `symbol` (a runtime-only display hint today)
 * is rendered as a drawn CSS glyph, never as text, and never as an emoji. The
 * required `label` stays the accessible name and the secondary mark (LP-01).
 */
import type { ButtonControl } from "@lanpad/sdk";
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

/** Runtime-only symbol hint shipped by game layouts (validated but untyped). */
type ButtonControlWithSymbol = ButtonControl & { readonly symbol?: string };

/** A geometric glyph drawn with `clip-path`; colour comes from `currentColor`. */
interface GlyphShape {
  readonly clipPath: string;
}

const GLYPH_SIZE_PX = 20;

/**
 * CSS-drawn equivalents of the geometric symbols layouts use today. Unknown
 * symbols are ignored rather than rendered as text, so layout data can never
 * smuggle an emoji or arbitrary characters onto the control surface.
 */
const GLYPH_SHAPES: Readonly<Record<string, GlyphShape>> = {
  "▲": { clipPath: "polygon(50% 0%, 100% 100%, 0% 100%)" },
  "▼": { clipPath: "polygon(50% 100%, 100% 0%, 0% 0%)" },
  "◀": { clipPath: "polygon(0% 50%, 100% 0%, 100% 100%)" },
  "▶": { clipPath: "polygon(100% 50%, 0% 0%, 0% 100%)" },
  "●": { clipPath: "circle(50%)" },
  "■": { clipPath: "inset(0)" },
  "◆": { clipPath: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)" },
  "✕": {
    clipPath:
      "polygon(20% 0%, 50% 30%, 80% 0%, 100% 20%, 70% 50%, 100% 80%, 80% 100%, 50% 70%, 20% 100%, 0% 80%, 30% 50%, 0% 20%)",
  },
  "×": {
    clipPath:
      "polygon(20% 0%, 50% 30%, 80% 0%, 100% 20%, 70% 50%, 100% 80%, 80% 100%, 50% 70%, 20% 100%, 0% 80%, 30% 50%, 0% 20%)",
  },
  "↑": { clipPath: "polygon(50% 0%, 100% 50%, 65% 50%, 65% 100%, 35% 100%, 35% 50%, 0% 50%)" },
  "↓": { clipPath: "polygon(50% 100%, 100% 50%, 65% 50%, 65% 0%, 35% 0%, 35% 50%, 0% 50%)" },
  "←": { clipPath: "polygon(0% 50%, 50% 0%, 50% 35%, 100% 35%, 100% 65%, 50% 65%, 50% 100%)" },
  "→": { clipPath: "polygon(100% 50%, 50% 0%, 50% 35%, 0% 35%, 0% 65%, 50% 65%, 50% 100%)" },
};

/**
 * Appends the drawn symbol glyph when the layout supplies a known symbol.
 * Returns true so the caller can stack the glyph above the label.
 */
function appendSymbolGlyph(element: HTMLElement, symbol: string | undefined): boolean {
  if (symbol === undefined) {
    return false;
  }
  const shape = GLYPH_SHAPES[symbol];
  if (shape === undefined) {
    return false;
  }

  const glyph = createPart("span", "symbol");
  glyph.setAttribute("aria-hidden", "true");
  glyph.style.display = "block";
  glyph.style.width = `${GLYPH_SIZE_PX}px`;
  glyph.style.height = `${GLYPH_SIZE_PX}px`;
  glyph.style.backgroundColor = "currentColor";
  glyph.style.clipPath = shape.clipPath;
  element.append(glyph);
  return true;
}

export function createButtonControl(
  control: ButtonControl,
  ctx: ControlContext,
): ControlRenderer {
  const box = measureControl(control, ctx.surfaceSize);
  const element = document.createElement("div");
  applyControlElementStyle(element, control, box, ctx);
  applyControlClasses(element, "button");
  element.dataset["shape"] = control.shape;
  element.setAttribute("role", "button");
  element.setAttribute("aria-label", control.label);
  element.setAttribute("aria-pressed", "false");

  if (appendSymbolGlyph(element, (control as ButtonControlWithSymbol).symbol)) {
    // The glyph is the primary mark and the label the secondary mark (LP-01).
    element.style.flexDirection = "column";
    element.style.gap = "2px";
  }

  const label = createPart("span", "label");
  label.textContent = control.label;
  element.append(label);

  /** Touch identifiers currently holding the button; supports two thumbs. */
  const activeTouches = new Set<number>();
  let pressed = false;

  const applyVisual = (active: boolean): void => {
    if (active === pressed) {
      return;
    }
    pressed = active;
    setPressed(element, active);
    element.setAttribute("aria-pressed", String(active));
    notifyDebugState(ctx, control.id, active);
  };

  const release = (binding: TouchBinding): void => {
    if (!activeTouches.delete(binding.identifier)) {
      return;
    }
    if (activeTouches.size === 0) {
      // Visual and store change in the same synchronous call (FR-8.7).
      applyVisual(false);
      ctx.input.setButton(control.bit, false);
    }
  };

  return {
    id: control.id,
    element,

    setPressed(active: boolean): void {
      applyVisual(active);
    },

    onTouchStart(binding: TouchBinding): void {
      if (activeTouches.has(binding.identifier)) {
        return;
      }
      const wasIdle = activeTouches.size === 0;
      activeTouches.add(binding.identifier);
      if (wasIdle) {
        applyVisual(true);
        ctx.input.setButton(control.bit, true);
      }
    },

    onTouchMove(): void {
      // A button has no drag behavior; the binding stays pressed until end.
    },

    onTouchEnd(binding: TouchBinding): void {
      release(binding);
    },

    onTouchCancel(binding: TouchBinding): void {
      release(binding);
    },

    getState(): Partial<InputState> {
      return { buttons: pressed ? 1 << control.bit : 0 };
    },

    dispose(): void {
      activeTouches.clear();
      if (pressed) {
        applyVisual(false);
        ctx.input.setButton(control.bit, false);
      }
      element.remove();
    },
  };
}
