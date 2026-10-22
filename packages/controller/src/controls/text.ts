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
 * CP-16 design language (DESIGN.md `true-black-flat`): the field, placeholder,
 * radius, inverted send fill and blocked warning come from `.control-text`
 * rules in `styles.css`. This file only adds the state the stylesheet keys off:
 * `data-filled` (inverted send while composing), `.is-blocked` plus the
 * `Slow down a moment.` line when the queue refuses a send, the `maxLen`
 * counter above long fields, and the shared `.is-pressed` class on press.
 *
 * `font-size: 16px` avoids Android's focus-zoom (D5-CTRL-01 risk note).
 * Keyboard-facing behavior — maxLen on input/paste, IME composition, Enter,
 * submit/clear/blur, and keeping the input visible while the on-screen
 * keyboard resizes the viewport — lives in `textInput.ts` (D5-CTRL-03). The
 * additive optional layout flag `keepFocus` is read defensively until the SDK
 * types it.
 */
import type { TextControl } from "@lanpad/sdk";
import type { InputState } from "@lanpad/protocol";
import {
  applyControlClasses,
  applyControlElementStyle,
  createPart,
  measureControl,
  notifyDebugState,
  setPressedClass,
  type ControlContext,
  type ControlRenderer,
} from "./control.js";
import { emitControlEvent } from "./eventSink.js";
import { bindTextInput } from "./textInput.js";
import { setSafeText } from "../render/safeRender.js";
import type { TouchBinding } from "../touch/touchEngine.js";

/** Minimum send-button edge (AR-5). */
export const TEXT_SEND_BUTTON_WIDTH_PX = 44;

/** Field hint shown while the input is empty (CP-16). */
const PLACEHOLDER_TEXT = "Type here…";

/** A counter only helps when the field accepts more than this many chars. */
const COUNTER_MIN_MAX_LEN = 40;

/** Line shown when the event queue refuses a submission (CP-16). */
const BLOCKED_TEXT = "Slow down a moment.";

/** Movement past this many pixels turns a press into a cancelled press. */
const SEND_CANCEL_SLOP_PX = 8;

const IDLE_TRANSFORM = "scale(1)";
const PRESSED_TRANSFORM = "scale(0.96)";

export function createTextControl(control: TextControl, ctx: ControlContext): ControlRenderer {
  const box = measureControl(control, ctx.surfaceSize);
  const sendLeft = box.left + Math.max(0, box.width - TEXT_SEND_BUTTON_WIDTH_PX);
  const showCounter = control.maxLen > COUNTER_MIN_MAX_LEN;

  const element = document.createElement("div");
  applyControlElementStyle(element, control, box, ctx);
  applyControlClasses(element, "text");
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", "answer");

  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = control.maxLen;
  input.placeholder = PLACEHOLDER_TEXT;
  input.setAttribute("enterkeyhint", "send");
  input.setAttribute("autocapitalize", "sentences");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("aria-label", "answer text");
  element.append(input);

  const send = createPart("button", "send");
  send.type = "button";
  setSafeText(send, "Send", 16);
  send.setAttribute("aria-label", "send answer");
  send.style.width = `${TEXT_SEND_BUTTON_WIDTH_PX}px`;
  element.append(send);

  // Counter sits just above the field, right-aligned, and only for long
  // limits. It is absolute so it never changes the layout or the hit box.
  const counter = createPart("div", "counter");
  counter.hidden = !showCounter;
  element.append(counter);

  // Blocked line sits below the field; the field keeps its draft (CP-16).
  const blockedLine = createPart("div", "blocked");
  blockedLine.textContent = BLOCKED_TEXT;
  blockedLine.hidden = true;
  element.append(blockedLine);

  let activeIdentifier: number | null = null;
  let startX = 0;
  let startY = 0;
  let sendCandidate = false;
  let pressed = false;
  const valueListeners = new AbortController();

  /** Mirrors the draft into the stylesheet's filled/blocked affordances. */
  const syncValueState = (): void => {
    const length = input.value.length;
    element.dataset["filled"] = length > 0 ? "true" : "false";
    if (showCounter) {
      counter.textContent = `${length}/${control.maxLen}`;
    }
  };

  const applyBlocked = (blocked: boolean): void => {
    if (blocked) {
      element.dataset["eventBlocked"] = "true";
      element.classList.add("is-blocked");
      blockedLine.hidden = false;
    } else {
      delete element.dataset["eventBlocked"];
      element.classList.remove("is-blocked");
      blockedLine.hidden = true;
    }
  };

  const applyVisual = (active: boolean): void => {
    if (active === pressed) {
      return;
    }
    pressed = active;
    setPressedClass(element, active);
    send.classList.toggle("is-pressed", active);
    send.style.transform = active ? PRESSED_TRANSFORM : IDLE_TRANSFORM;
    notifyDebugState(ctx, control.id, active);
  };

  const keepFocus = (control as TextControl & { keepFocus?: unknown }).keepFocus === true;
  const textEntry = bindTextInput(input, {
    maxLen: control.maxLen,
    keepFocus,
    ...(ctx.viewport !== undefined ? { viewport: ctx.viewport } : {}),
    onSubmit: (value) => {
      const accepted = emitControlEvent(ctx.events, control.event, { value }, "high");
      applyBlocked(!accepted);
      return accepted;
    },
  });

  const submit = (): boolean => {
    const accepted = textEntry.submit();
    // A successful submit clears the field without dispatching an input event.
    syncValueState();
    return accepted;
  };

  input.addEventListener("input", syncValueState, { signal: valueListeners.signal });
  syncValueState();

  const isSendPoint = (clientX: number): boolean => clientX >= sendLeft;

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
      valueListeners.abort();
      textEntry.dispose();
      element.remove();
    },
  };
}
