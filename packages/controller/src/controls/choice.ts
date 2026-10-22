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
 */
import type { ChoiceControl } from "@lanpad/sdk";
import type { InputState } from "@lanpad/protocol";
import {
  applyControlElementStyle,
  createPart,
  measureControl,
  notifyDebugState,
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

const IDLE_OPACITY = "1";
const PRESSED_OPACITY = "0.92";

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
  element.classList.add("control", "control-choice");
  element.setAttribute("role", "listbox");
  element.setAttribute("aria-label", "choices");
  element.style.overflow = "hidden";
  element.style.borderRadius = "12px";
  element.style.background = "rgba(255, 255, 255, 0.06)";
  element.style.border = "1px solid rgba(255, 255, 255, 0.30)";

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
    const row = document.createElement("div");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");
    row.style.position = "relative";
    row.style.height = `${CHOICE_ROW_HEIGHT_PX}px`;
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.padding = "0 12px";
    row.style.boxSizing = "border-box";
    row.style.borderBottom = "1px solid rgba(255, 255, 255, 0.10)";
    row.style.color = "#f4f4f5";
    row.style.font = "500 16px/1.2 system-ui, sans-serif";
    row.style.overflow = "hidden";
    row.style.textOverflow = "ellipsis";
    row.style.whiteSpace = "nowrap";
    row.dataset["part"] = "option";
    setSafeText(row, option.label, MAX_OPTION_LABEL_CHARS);
    rows.push(row);
    list.append(row);
  }

  const selection = createPart("div", "selection");
  selection.style.position = "absolute";
  selection.style.left = "0";
  selection.style.top = "0";
  selection.style.width = "100%";
  selection.style.height = `${CHOICE_ROW_HEIGHT_PX}px`;
  selection.style.background = "rgba(255, 255, 255, 0.24)";
  selection.style.opacity = "0";
  selection.style.transform = "translate3d(0, 0, 0)";
  selection.style.pointerEvents = "none";
  list.append(selection);

  const contentHeight = options.length * CHOICE_ROW_HEIGHT_PX;
  const minOffset = Math.min(0, box.height - contentHeight);

  let activeIdentifier: number | null = null;
  let startY = 0;
  let startOffset = 0;
  let offset = 0;
  let dragging = false;
  let candidateIndex = -1;
  let selectedValue: string | null = null;
  let pressed = false;

  const applyVisual = (active: boolean): void => {
    if (active === pressed) {
      return;
    }
    pressed = active;
    setPressedClass(element, active);
    element.style.opacity = active ? PRESSED_OPACITY : IDLE_OPACITY;
    notifyDebugState(ctx, control.id, active);
  };

  const applyOffset = (next: number): void => {
    offset = clamp(next, minOffset, 0);
    list.style.transform = `translate3d(0, ${offset.toFixed(2)}px, 0)`;
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
    selection.style.transform = `translate3d(0, ${index * CHOICE_ROW_HEIGHT_PX}px, 0)`;
    selection.style.opacity = "1";
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      rows[rowIndex]?.setAttribute("aria-selected", String(rowIndex === index));
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
      applyVisual(true);
    },

    onTouchMove(binding: TouchBinding): void {
      if (binding.identifier !== activeIdentifier) {
        return;
      }
      const delta = binding.lastY - startY;
      if (!dragging && Math.abs(delta) > TAP_SLOP_PX) {
        dragging = true;
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
      applyVisual(false);
      element.remove();
    },
  };
}
