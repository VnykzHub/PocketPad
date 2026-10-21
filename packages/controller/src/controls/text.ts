/**
 * Text control renderer (D5-CTRL-01; FR-8.1, FR-8.3, FR-8.7, SR-13, AR-5).
 *
 * A real `<input type="text">` plus an always-visible 44 px send button. The
 * value is sent exactly once per submit — Enter or the send button — never
 * per keystroke; `sanitizeText` strips control characters and enforces
 * `maxLen` in code points before the event leaves the phone (SR-13).
 *
 * The play surface calls `preventDefault()` on every touch, which is why the
 * control focuses the input from its own touch handler (inside the gesture, so
 * the Android keyboard opens) and hit-tests the send button from touch
 * coordinates instead of relying on a native `click`. The `click` listener is
 * still present for keyboard/assistive activation.
 *
 * `font-size: 16px` avoids Android's focus-zoom (D5-CTRL-01 risk note). The
 * full on-screen-keyboard viewport management lives in D5-CTRL-03; this
 * renderer keeps the control and send button inside its own box so that work
 * can resize the surface without losing the input.
 */
import { sanitizeText, type TextControl } from "@lanpad/sdk";
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
import type { TouchBinding } from "../touch/touchEngine.js";

/** Minimum send-button edge (AR-5). */
export const TEXT_SEND_BUTTON_WIDTH_PX = 44;

/** Movement past this many pixels turns a press into a cancelled press. */
const SEND_CANCEL_SLOP_PX = 8;

const IDLE_TRANSFORM = "scale(1)";
const PRESSED_TRANSFORM = "scale(0.96)";
const IDLE_OPACITY = "1";
const PRESSED_OPACITY = "0.8";

export function createTextControl(control: TextControl, ctx: ControlContext): ControlRenderer {
  const box = measureControl(control, ctx.surfaceSize);
  const sendLeft = box.left + Math.max(0, box.width - TEXT_SEND_BUTTON_WIDTH_PX);

  const element = document.createElement("div");
  applyControlElementStyle(element, control, box, ctx);
  element.classList.add("control", "control-text");
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", "answer");
  element.style.display = "flex";
  element.style.alignItems = "stretch";
  element.style.gap = "8px";

  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = control.maxLen;
  input.setAttribute("enterkeyhint", "send");
  input.setAttribute("autocapitalize", "sentences");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("aria-label", "answer text");
  input.style.flex = "1 1 auto";
  input.style.minWidth = "0";
  input.style.width = "100%";
  input.style.height = "100%";
  input.style.boxSizing = "border-box";
  input.style.padding = "0 12px";
  // 16 px minimum: smaller text makes Android zoom the page on focus.
  input.style.font = "16px/1.2 system-ui, sans-serif";
  input.style.color = "#f4f4f5";
  input.style.background = "rgba(255, 255, 255, 0.10)";
  input.style.border = "1px solid rgba(255, 255, 255, 0.35)";
  input.style.borderRadius = "10px";
  input.style.outline = "none";
  input.style.touchAction = "none";
  element.append(input);

  const send = createPart("button", "send");
  send.type = "button";
  send.textContent = "Send";
  send.setAttribute("aria-label", "send answer");
  send.style.flex = `0 0 ${TEXT_SEND_BUTTON_WIDTH_PX}px`;
  send.style.width = `${TEXT_SEND_BUTTON_WIDTH_PX}px`;
  send.style.minWidth = `${TEXT_SEND_BUTTON_WIDTH_PX}px`;
  send.style.height = "100%";
  send.style.border = "1px solid rgba(255, 255, 255, 0.45)";
  send.style.borderRadius = "10px";
  send.style.background = "rgba(255, 255, 255, 0.20)";
  send.style.color = "#f4f4f5";
  send.style.font = "600 15px/1 system-ui, sans-serif";
  send.style.touchAction = "none";
  element.append(send);

  let activeIdentifier: number | null = null;
  let startX = 0;
  let startY = 0;
  let sendCandidate = false;
  let pressed = false;

  const applyVisual = (active: boolean): void => {
    if (active === pressed) {
      return;
    }
    pressed = active;
    setPressedClass(element, active);
    send.style.transform = active ? PRESSED_TRANSFORM : IDLE_TRANSFORM;
    send.style.opacity = active ? PRESSED_OPACITY : IDLE_OPACITY;
    notifyDebugState(ctx, control.id, active);
  };

  const submit = (): boolean => {
    // Trim after sanitizing so whitespace padding is never charged to maxLen.
    const value = sanitizeText(input.value, control.maxLen).trim();
    if (value.length === 0) {
      return false;
    }
    const accepted = emitControlEvent(ctx.events, control.event, { value }, "high");
    if (accepted) {
      input.value = "";
      delete element.dataset["eventBlocked"];
    } else {
      // Keep the text so nothing is silently lost without a queue.
      element.dataset["eventBlocked"] = "true";
    }
    return accepted;
  };

  const isSendPoint = (clientX: number): boolean => clientX >= sendLeft;

  input.addEventListener("input", () => {
    // Paste is allowed but truncated; this never sends (FR-7.8).
    const plain = sanitizeText(input.value, control.maxLen);
    if (plain !== input.value) {
      input.value = plain;
    }
  });

  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) {
      return;
    }
    event.preventDefault();
    submit();
  });

  // Keyboard and assistive-technology activation path; touch uses the
  // coordinate handler below because the surface consumes native clicks.
  send.addEventListener("click", () => {
    submit();
  });

  const release = (binding: TouchBinding, allowSend: boolean): void => {
    if (binding.identifier !== activeIdentifier) {
      return;
    }
    activeIdentifier = null;
    const shouldSend = allowSend && sendCandidate;
    sendCandidate = false;
    applyVisual(false);
    if (shouldSend) {
      submit();
    }
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
      startX = binding.startX;
      startY = binding.startY;
      sendCandidate = isSendPoint(binding.startX);

      if (sendCandidate) {
        applyVisual(true);
        return;
      }

      // Focus inside the gesture so the on-screen keyboard opens, even though
      // the surface's preventDefault suppresses the browser's default focus.
      const alreadyFocused = document.activeElement === input;
      input.focus();
      if (!alreadyFocused) {
        const end = input.value.length;
        try {
          input.setSelectionRange(end, end);
        } catch {
          // Some engines reject selection on certain input types; focus is
          // the important part.
        }
      }
    },

    onTouchMove(binding: TouchBinding): void {
      if (binding.identifier !== activeIdentifier || !sendCandidate) {
        return;
      }
      if (
        Math.abs(binding.lastX - startX) > SEND_CANCEL_SLOP_PX ||
        Math.abs(binding.lastY - startY) > SEND_CANCEL_SLOP_PX
      ) {
        sendCandidate = false;
        applyVisual(false);
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
      sendCandidate = false;
      applyVisual(false);
      input.blur();
      element.remove();
    },
  };
}
