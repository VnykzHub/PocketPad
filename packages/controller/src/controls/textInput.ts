/**
 * Text entry behavior for the `text` control (D5-CTRL-03; FR-8.9, FR-7.8, SR-13, E16).
 *
 * `bindTextInput` attaches every keyboard-facing behavior to a real `<input>`
 * so `text.ts` only builds DOM and handles touches:
 * - `maxLen` and control-character stripping via `sanitizeText`, applied on
 *   input and paste but never mid-IME-composition (rewriting the value during
 *   composition breaks CJK/Android keyboards). Deletions (backspace) never
 *   rewrite the value, so the caret is untouched.
 * - Enter submits, except while composing (`isComposing` / keyCode 229).
 * - Submit trims, sends exactly one `{value}` through `onSubmit`, and clears
 *   the input only when the event was accepted. Focus is kept when the layout
 *   sets the additive `keepFocus` flag, otherwise the input blurs (closing the
 *   keyboard).
 * - While focused, the input is kept inside the visible viewport whenever the
 *   on-screen keyboard resizes it (`ViewportTracker`, E16).
 * - `dispose()` removes every listener, the viewport subscription and focus.
 */
import { sanitizeText } from "@lanpad/sdk";
import { ensureVisible, type ViewportTracker } from "../layout/viewport.js";

/** Android/legacy keyCode for "key event belongs to an IME composition". */
const IME_PROCESS_KEY_CODE = 229;

export interface TextInputOptions {
  maxLen: number;
  /** Keep focus (keyboard open) after a successful submit. */
  keepFocus?: boolean;
  /** Visible-viewport source; omit to skip keyboard scrolling. */
  viewport?: ViewportTracker;
  /** Receives the trimmed, truncated value; return true when it was queued. */
  onSubmit: (value: string) => boolean;
}

export interface TextInputBinding {
  /** Submits the current value; false when empty or not accepted. */
  submit(): boolean;
  /** True while an IME composition is in progress. */
  readonly composing: boolean;
  dispose(): void;
}

/** The exact value a submit sends: control chars stripped, maxLen, trimmed. */
export function prepareTextValue(raw: string, maxLen: number): string {
  // Trim after truncating so padding never counts against the limit twice.
  return sanitizeText(raw, maxLen).trim();
}

export function bindTextInput(input: HTMLInputElement, options: TextInputOptions): TextInputBinding {
  const listeners = new AbortController();
  const signal = listeners.signal;
  let composing = false;
  let unsubscribeViewport: (() => void) | null = null;
  let disposed = false;

  const enforceLimit = (): void => {
    const plain = sanitizeText(input.value, options.maxLen);
    if (plain === input.value) {
      return;
    }
    const caret = input.selectionStart ?? plain.length;
    input.value = plain;
    const position = Math.min(caret, plain.length);
    try {
      input.setSelectionRange(position, position);
    } catch {
      // Selection is cosmetic; some engines reject it for detached inputs.
    }
  };

  const keepVisible = (): void => {
    if (options.viewport !== undefined && document.activeElement === input) {
      ensureVisible(input, options.viewport.metrics());
    }
  };

  const stopTracking = (): void => {
    unsubscribeViewport?.();
    unsubscribeViewport = null;
  };

  const submit = (): boolean => {
    if (disposed) {
      return false;
    }
    const value = prepareTextValue(input.value, options.maxLen);
    if (value.length === 0 || !options.onSubmit(value)) {
      return false;
    }
    input.value = "";
    if (options.keepFocus !== true) {
      input.blur();
    }
    return true;
  };

  input.addEventListener(
    "input",
    () => {
      if (!composing) {
        enforceLimit();
      }
    },
    { signal },
  );
  input.addEventListener(
    "compositionstart",
    () => {
      composing = true;
    },
    { signal },
  );
  input.addEventListener(
    "compositionend",
    () => {
      composing = false;
      enforceLimit();
    },
    { signal },
  );
  input.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter") {
        return;
      }
      if (composing || event.isComposing || event.keyCode === IME_PROCESS_KEY_CODE) {
        return;
      }
      event.preventDefault();
      submit();
    },
    { signal },
  );
  input.addEventListener(
    "focus",
    () => {
      keepVisible();
      if (options.viewport !== undefined && unsubscribeViewport === null) {
        unsubscribeViewport = options.viewport.subscribe(keepVisible);
      }
    },
    { signal },
  );
  input.addEventListener(
    "blur",
    () => {
      composing = false;
      stopTracking();
    },
    { signal },
  );

  return {
    submit,
    get composing(): boolean {
      return composing;
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      listeners.abort();
      stopTracking();
      if (document.activeElement === input) {
        input.blur();
      }
    },
  };
}
