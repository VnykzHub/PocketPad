/**
 * Console input mapping (ER-25-04; BUILD-BRIEF launcher).
 *
 * Keyboard, gamepad and phone remote collapse into six `ConsoleAction`s
 * (`prev`, `next`, `first`, `last`, `confirm`, `back`). Mapping is synchronous:
 * no timer, no debounce and no animation gate stands between a press and the
 * callback. The shell decides what an action means in the current phase.
 *
 * Native controls keep their own behaviour: Enter/Space on the QR button or a
 * lobby button is left to the browser (no `confirm`), and keystrokes inside a
 * text field are never stolen. The game row's tiles opt in with
 * `data-console-tile="true"`, so Enter/Space there maps to `confirm` and the
 * shell launches the focused game.
 *
 * Gamepads are polled, not evented: the host calls `pollGamepad()` from its
 * frame loop. The launcher owns no `requestAnimationFrame` and therefore no
 * hidden frame loop to leak. Axis edges use a 0.5 press / 0.35 re-arm
 * hysteresis so a resting stick cannot repeat.
 */
import type { ConsoleAction, InputMode } from "./types.js";

export const GAMEPAD_DEADZONE = 0.5;
export const GAMEPAD_REARM = 0.35;

/** Standard-mapping button indices used by the launcher. */
export const GAMEPAD_BUTTONS = {
  confirm: 0,
  back: 1,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
} as const;

export interface GamepadButtonLike {
  readonly pressed: boolean;
}

export interface GamepadLike {
  readonly axes: ReadonlyArray<number>;
  readonly buttons: ReadonlyArray<GamepadButtonLike>;
}

export type RemoteButton = "up" | "down" | "left" | "right" | "ok" | "back";

const REMOTE_ACTIONS: Readonly<Record<string, ConsoleAction>> = {
  up: "prev",
  left: "prev",
  down: "next",
  right: "next",
  ok: "confirm",
  confirm: "confirm",
  back: "back",
  cancel: "back",
};

/** Maps a remote button id (case/`-`/`_` insensitive) to an action. */
export function remoteButtonToAction(button: string): ConsoleAction | null {
  const key = button.trim().toLowerCase().replace(/[-_\s]+/g, "");
  return REMOTE_ACTIONS[key] ?? null;
}

/** Legacy `keyCode` fallback for TV browsers that omit `event.key`. */
const KEYCODE_ACTIONS: Readonly<Record<number, ConsoleAction>> = {
  13: "confirm",
  27: "back",
  32: "confirm",
  37: "prev",
  38: "prev",
  39: "next",
  40: "next",
  35: "last",
  36: "first",
};

/** Maps a key name to an action; `keyCode` is used only when `key` is empty. */
export function keyToAction(key: string, keyCode = 0): ConsoleAction | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowUp":
      return "prev";
    case "ArrowRight":
    case "ArrowDown":
      return "next";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "Enter":
    case " ":
    case "Spacebar":
      return "confirm";
    case "Escape":
    case "Esc":
      return "back";
    default:
      return key.length === 0 ? KEYCODE_ACTIONS[keyCode] ?? null : null;
  }
}

interface PadEdge {
  armedX: boolean;
  armedY: boolean;
  readonly pressed: boolean[];
}

export interface ConsoleInputOptions {
  /** Keyboard target; defaults to `doc.defaultView`. */
  readonly target?: EventTarget | null;
  /** Called synchronously for every mapped action. */
  readonly onAction: (action: ConsoleAction, mode: InputMode) => void;
  /** Called when the driving source changes (hint bar). */
  readonly onModeChange?: (mode: InputMode) => void;
  /** Injectable for tests; defaults to `navigator.getGamepads`. */
  readonly gamepads?: () => ReadonlyArray<GamepadLike | null | undefined>;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (target === null) return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  const tag = typeof el.tagName === "string" ? el.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return el.isContentEditable === true;
}

/**
 * True for focused anchors and buttons that are not game tiles. Those keep
 * their native Enter/Space activation, so the shell must not also confirm.
 */
function isNativeActivationControl(target: EventTarget | null): boolean {
  if (target === null) return false;
  const el = target as {
    tagName?: unknown;
    dataset?: Readonly<Record<string, string | undefined>>;
  };
  const tag = typeof el.tagName === "string" ? el.tagName.toLowerCase() : "";
  if (tag === "a") return true;
  if (tag !== "button") return false;
  return el.dataset?.["consoleTile"] !== "true";
}

export class ConsoleInput {
  readonly target: EventTarget | null;

  private readonly onAction: (action: ConsoleAction, mode: InputMode) => void;
  private readonly onModeChange: ((mode: InputMode) => void) | undefined;
  private readonly readGamepads:
    | (() => ReadonlyArray<GamepadLike | null | undefined>)
    | undefined;
  private readonly padEdges = new Map<number, PadEdge>();
  private mode: InputMode = "keyboard";
  private attachedFlag = false;
  private destroyed = false;

  constructor(doc: Document, options: ConsoleInputOptions) {
    this.target =
      options.target !== undefined ? options.target : doc.defaultView;
    this.onAction = options.onAction;
    this.onModeChange = options.onModeChange;
    this.readGamepads = options.gamepads;
  }

  get currentMode(): InputMode {
    return this.mode;
  }

  get attached(): boolean {
    return this.attachedFlag;
  }

  attach(): void {
    if (this.destroyed || this.attachedFlag || this.target === null) return;
    this.target.addEventListener("keydown", this.handleKeyDown as EventListener);
    this.attachedFlag = true;
  }

  detach(): void {
    if (this.target !== null) {
      this.target.removeEventListener(
        "keydown",
        this.handleKeyDown as EventListener,
      );
    }
    this.attachedFlag = false;
  }

  /**
   * Maps one keyboard event. Returns true when an action was emitted (and the
   * browser default was prevented). Repeats are allowed for movement and
   * suppressed for `confirm`, so holding Enter launches once.
   */
  handleKey(event: KeyboardEvent): boolean {
    if (this.destroyed) return false;
    if (
      event.ctrlKey === true ||
      event.metaKey === true ||
      event.altKey === true
    ) {
      return false;
    }
    const action = keyToAction(event.key, event.keyCode);
    if (action === null) return false;
    if (isTextEntry(event.target)) return false;
    if (action === "confirm" && isNativeActivationControl(event.target)) {
      return false;
    }
    if (action === "confirm" && event.repeat === true) return false;
    if (typeof event.preventDefault === "function") event.preventDefault();
    this.emit(action, "keyboard");
    return true;
  }

  /** Maps a phone-remote button id; unknown ids are ignored. */
  handleRemote(button: string): boolean {
    if (this.destroyed) return false;
    const action = remoteButtonToAction(button);
    if (action === null) return false;
    this.emit(action, "remote");
    return true;
  }

  /**
   * Reads every connected pad once and emits at most one action. Returns the
   * actions emitted, which lets tests and the host observe edges.
   */
  pollGamepad(): ConsoleAction[] {
    if (this.destroyed) return [];
    const pads = this.readPads();
    if (pads.length === 0) {
      this.padEdges.clear();
      return [];
    }

    const emitted: ConsoleAction[] = [];
    const seen = new Set<number>();
    for (let index = 0; index < pads.length; index += 1) {
      const pad = pads[index];
      if (pad === null || pad === undefined) continue;
      seen.add(index);
      let edge = this.padEdges.get(index);
      if (edge === undefined) {
        edge = { armedX: true, armedY: true, pressed: [] };
        this.padEdges.set(index, edge);
      }
      const action = this.pollPad(pad, edge);
      if (action !== null) emitted.push(action);
    }

    for (const index of this.padEdges.keys()) {
      if (!seen.has(index)) this.padEdges.delete(index);
    }
    const first = emitted[0];
    if (first !== undefined) this.emit(first, "gamepad");
    return emitted;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.detach();
    this.padEdges.clear();
  }

  private emit(action: ConsoleAction, mode: InputMode): void {
    if (this.mode !== mode) {
      this.mode = mode;
      this.onModeChange?.(mode);
    }
    this.onAction(action, mode);
  }

  private readPads(): ReadonlyArray<GamepadLike | null | undefined> {
    if (this.readGamepads !== undefined) return this.readGamepads();
    const nav = (
      globalThis as {
        navigator?: { getGamepads?: () => ReadonlyArray<GamepadLike | null> };
      }
    ).navigator;
    return nav?.getGamepads?.() ?? [];
  }

  private pollPad(pad: GamepadLike, edge: PadEdge): ConsoleAction | null {
    const buttons = pad.buttons ?? [];
    let action: ConsoleAction | null = null;

    const buttonAction = (index: number, mapped: ConsoleAction): void => {
      const pressed = buttons[index]?.pressed === true;
      if (pressed && edge.pressed[index] !== true && action === null) {
        action = mapped;
      }
      edge.pressed[index] = pressed;
    };

    buttonAction(GAMEPAD_BUTTONS.confirm, "confirm");
    buttonAction(GAMEPAD_BUTTONS.back, "back");
    buttonAction(GAMEPAD_BUTTONS.up, "prev");
    buttonAction(GAMEPAD_BUTTONS.down, "next");
    buttonAction(GAMEPAD_BUTTONS.left, "prev");
    buttonAction(GAMEPAD_BUTTONS.right, "next");

    const axisX = pad.axes[0] ?? 0;
    const axisY = pad.axes[1] ?? 0;
    if (action === null) {
      if (axisX >= GAMEPAD_DEADZONE && edge.armedX) {
        action = "next";
        edge.armedX = false;
      } else if (axisX <= -GAMEPAD_DEADZONE && edge.armedX) {
        action = "prev";
        edge.armedX = false;
      } else if (Math.abs(axisX) <= GAMEPAD_REARM) {
        edge.armedX = true;
      }
    }
    if (action === null) {
      if (axisY >= GAMEPAD_DEADZONE && edge.armedY) {
        action = "next";
        edge.armedY = false;
      } else if (axisY <= -GAMEPAD_DEADZONE && edge.armedY) {
        action = "prev";
        edge.armedY = false;
      } else if (Math.abs(axisY) <= GAMEPAD_REARM) {
        edge.armedY = true;
      }
    }
    return action;
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    this.handleKey(event);
  };
}
