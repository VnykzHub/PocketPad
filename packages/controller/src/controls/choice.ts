/**
 * Choice control renderer (D5-CTRL-01; FR-8.1, FR-8.3, FR-8.7, AR-5, SR-13).
 *
 * A list of option rows inside a clipped, scrollable box. A tap selects the
 * row under the finger and emits `{name, data:{value}}` through the D5 event
 * queue; the selected highlight is local state (the host owns what a pick
 * means). A vertical drag scrolls the list instead of selecting, because the
 * play surface consumes native scrolling (D2-CTRL-01 calls preventDefault on
 * every touch); the list is translated with `transform` while rows keep their
 * construction-time geometry (FR-8.3).
 *
 * Rows are exactly 44 px tall, satisfying AR-5 even when the layout asks for a
 * shorter box (the box itself is raised to 44 px by the shared measure step).
 * Labels are assigned with `textContent`; no markup path exists (SR-13).
 *
 * Visual grammar (CP-14, DESIGN.md): `.control` + `.control-choice` on the
 * card, `.is-pressed` on the container and on the candidate row, `.is-selected`
 * plus `aria-selected` on the chosen row. styles.css owns the inversion,
 * colours, fades and scrollbar; this file sets the scrollbar's geometry and
 * the list/scrollbar transforms only.
 */
import type { ChoiceControl } from "@lanpad/sdk";
import type { InputState } from "@lanpad/protocol";
import {
  applyControlClasses,
  applyControlElementStyle,
  createPart,
  measureControl,
  notifyDebugState,
  PRESSED_CLASS,
  setPressedClass,
  type ControlContext,
  type ControlRenderer,
} from "./control.js";
import { emitControlEvent } from "./eventSink.js";
import { setSafeText } from "../render/safeRender.js";
import type { TouchBinding } from "../touch/touchEngine.js";

/** Fixed row height. AR-5 floor for every option target. */
export const CHOICE_ROW_HEIGHT_PX = 44;

/** Longest option label rendered; keeps a hostile label from bloating a row. */
const MAX_OPTION_LABEL_CHARS = 120;

/** Movement past this many pixels turns a tap into a scroll drag. */
const TAP_SLOP_PX = 8;

/** Smallest scrollbar thumb, so the affordance stays visible. */
const MIN_SCROLLBAR_THUMB_PX = 24;

/** styles.css insets the bar by 2 px at the top and right (CP-14). */
const SCROLLBAR_INSET_PX = 2;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function createChoiceControl(control: ChoiceControl, ctx: ControlContext): ControlRenderer {
  const box = measureControl(control, ctx.surfaceSize);
  const options = control.options;

  const element = document.createElement("div");
  applyControlElementStyle(element, control, box, ctx);
  applyControlClasses(element, "choice");
  element.setAttribute("role", "listbox");
  element.setAttribute("aria-label", "choices");

  const list = createPart("div", "list");
  list.style.position = "absolute";
  list.style.left = "0";
  list.style.top = "0";
  list.style.width = "100%";
  list.style.transform = "translate3d(0, 0, 0)";
  list.style.pointerEvents = "none";
  element.append(list);

  const rows: HTMLElement[] = [];
  for (const option of options) {
    const row = createPart("div", "option");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");
    row.style.position = "relative";
    row.style.height = `${CHOICE_ROW_HEIGHT_PX}px`;
    setSafeText(row, option.label, MAX_OPTION_LABEL_CHARS);
    rows.push(row);
    list.append(row);
  }

  const contentHeight = options.length * CHOICE_ROW_HEIGHT_PX;
  const minOffset = Math.min(0, box.height - contentHeight);
  const scrollable = contentHeight > box.height;
  const scrollbarTrack = Math.max(0, box.height - SCROLLBAR_INSET_PX * 2);
  const scrollbarThumbHeight = scrollable
    ? Math.max(MIN_SCROLLBAR_THUMB_PX, (scrollbarTrack * scrollbarTrack) / contentHeight)
    : 0;
  const scrollbarRange = scrollbarTrack - scrollbarThumbHeight;

  // CP-14 scroll affordance: a 2 px bar whose length tracks the visible
  // fraction. styles.css hides the bar when the card is not scrollable.
  const scrollbar = createPart("div", "scrollbar");
  scrollbar.hidden = !scrollable;
  if (scrollable) {
    element.dataset["scrollable"] = "true";
    scrollbar.style.height = `${scrollbarThumbHeight.toFixed(2)}px`;
    scrollbar.style.transform = "translate3d(0, 0, 0)";
  }
  element.append(scrollbar);

  let activeIdentifier: number | null = null;
  let startY = 0;
  let startOffset = 0;
  let offset = 0;
  let dragging = false;
  let candidateIndex = -1;
  let pressedRowIndex = -1;
  let selectedValue: string | null = null;
  let pressed = false;

  const setRowPressed = (index: number): void => {
    if (pressedRowIndex === index) {
      return;
    }
    if (pressedRowIndex >= 0) {
      rows[pressedRowIndex]?.classList.remove(PRESSED_CLASS);
    }
    pressedRowIndex = index;
    if (index >= 0) {
      rows[index]?.classList.add(PRESSED_CLASS);
    }
  };

  const applyVisual = (active: boolean): void => {
    if (active === pressed) {
      return;
    }
    pressed = active;
    setPressedClass(element, active);
    notifyDebugState(ctx, control.id, active);
  };

  const applyOffset = (next: number): void => {
    offset = clamp(next, minOffset, 0);
    list.style.transform = `translate3d(0, ${offset.toFixed(2)}px, 0)`;
    if (scrollable) {
      const progress = minOffset === 0 ? 0 : offset / minOffset;
      scrollbar.style.transform = `translate3d(0, ${(progress * scrollbarRange).toFixed(2)}px, 0)`;
    }
  };

  const indexAt = (clientY: number): number => {
    const localY = clientY - box.top - offset;
    const index = Math.floor(localY / CHOICE_ROW_HEIGHT_PX);
    return clamp(index, 0, options.length - 1);
  };

  const select = (index: number): void => {
    const option = options[index];
    if (option === undefined) {
      return;
    }
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const selected = rowIndex === index;
      const row = rows[rowIndex];
      row?.setAttribute("aria-selected", String(selected));
      row?.classList.toggle("is-selected", selected);
    }
    if (option.value === selectedValue) {
      return;
    }
    selectedValue = option.value;
    // High priority: the queue must not silently drop a pick (D5-CTRL-05).
    emitControlEvent(ctx.events, control.event, { value: option.value }, "high");
  };

  const release = (binding: TouchBinding, allowSelect: boolean): void => {
    if (binding.identifier !== activeIdentifier) {
      return;
    }
    activeIdentifier = null;
    applyVisual(false);
    setRowPressed(-1);
    const wasDragging = dragging;
    dragging = false;
    if (allowSelect && !wasDragging) {
      select(candidateIndex);
    }
    startOffset = offset;
    candidateIndex = -1;
  };

  return {
    id: control.id,
    element,

    setPressed(active: boolean): void {
      applyVisual(active);
    },

    onTouchStart(binding: TouchBinding): void {
      if (activeIdentifier !== null) {
        return;
      }
      activeIdentifier = binding.identifier;
      startY = binding.startY;
      startOffset = offset;
      dragging = false;
      candidateIndex = indexAt(binding.startY);
      setRowPressed(candidateIndex);
      applyVisual(true);
    },

    onTouchMove(binding: TouchBinding): void {
      if (binding.identifier !== activeIdentifier) {
        return;
      }
      const delta = binding.lastY - startY;
      if (!dragging && Math.abs(delta) > TAP_SLOP_PX) {
        dragging = true;
        // A scroll gesture is not a pick: drop the pressed row immediately.
        setRowPressed(-1);
      }
      if (dragging) {
        applyOffset(startOffset + delta);
      }
    },

    onTouchEnd(binding: TouchBinding): void {
      release(binding, true);
    },

    onTouchCancel(binding: TouchBinding): void {
      release(binding, false);
    },

    getState(): Partial<InputState> {
      return {};
    },

    dispose(): void {
      activeIdentifier = null;
      dragging = false;
      setRowPressed(-1);
      applyVisual(false);
      element.remove();
    },
  };
}
