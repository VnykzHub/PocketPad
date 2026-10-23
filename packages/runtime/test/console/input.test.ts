import { describe, expect, test } from "vitest";
import {
  ConsoleInput,
  GAMEPAD_BUTTONS,
  GAMEPAD_DEADZONE,
  GAMEPAD_REARM,
  keyToAction,
  remoteButtonToAction,
  type GamepadLike,
} from "../../src/ui/console/input.js";
import { asDocument, FakeDocument, FakeElement, keyEvent } from "./fakeDom.js";
import type { ConsoleAction, InputMode } from "../../src/ui/console/types.js";

function keyboard(event: ReturnType<typeof keyEvent>): KeyboardEvent {
  return event as unknown as KeyboardEvent;
}

function pad(
  options: {
    readonly buttons?: readonly number[];
    readonly axes?: readonly [number, number];
  } = {},
): GamepadLike {
  const pressed = new Set(options.buttons ?? []);
  const buttons = Array.from({ length: 16 }, (_, index) => ({
    pressed: pressed.has(index),
  }));
  return { axes: options.axes ?? [0, 0], buttons };
}

interface Harness {
  readonly doc: FakeDocument;
  readonly input: ConsoleInput;
  readonly actions: Array<{ action: ConsoleAction; mode: InputMode }>;
  readonly modes: InputMode[];
}

function setup(
  options: {
    gamepads?: () => ReadonlyArray<GamepadLike | null | undefined>;
  } = {},
): Harness {
  const doc = new FakeDocument();
  const actions: Array<{ action: ConsoleAction; mode: InputMode }> = [];
  const modes: InputMode[] = [];
  const input = new ConsoleInput(asDocument(doc), {
    onAction: (action, mode) => actions.push({ action, mode }),
    onModeChange: (mode) => modes.push(mode),
    ...(options.gamepads !== undefined ? { gamepads: options.gamepads } : {}),
  });
  return { doc, input, actions, modes };
}

describe("console input", () => {
  test("[ER-25-04] keys map to a small action set, including legacy keyCodes", () => {
    expect(keyToAction("ArrowLeft")).toBe("prev");
    expect(keyToAction("ArrowUp")).toBe("prev");
    expect(keyToAction("ArrowRight")).toBe("next");
    expect(keyToAction("ArrowDown")).toBe("next");
    expect(keyToAction("Home")).toBe("first");
    expect(keyToAction("End")).toBe("last");
    expect(keyToAction("Enter")).toBe("confirm");
    expect(keyToAction(" ")).toBe("confirm");
    expect(keyToAction("Spacebar")).toBe("confirm");
    expect(keyToAction("Escape")).toBe("back");
    expect(keyToAction("Esc")).toBe("back");
    expect(keyToAction("a")).toBeNull();
    expect(keyToAction("", 13)).toBe("confirm");
    expect(keyToAction("", 27)).toBe("back");
    expect(keyToAction("", 37)).toBe("prev");
    expect(keyToAction("", 39)).toBe("next");
    expect(keyToAction("", 36)).toBe("first");
    expect(keyToAction("", 35)).toBe("last");
    expect(keyToAction("", 65)).toBeNull();
    expect(keyToAction("Enter", 65)).toBe("confirm");
  });

  test("[ER-25-04] remote button ids normalize case and separators", () => {
    expect(remoteButtonToAction("up")).toBe("prev");
    expect(remoteButtonToAction("LEFT")).toBe("prev");
    expect(remoteButtonToAction("down")).toBe("next");
    expect(remoteButtonToAction("Right")).toBe("next");
    expect(remoteButtonToAction("ok")).toBe("confirm");
    expect(remoteButtonToAction("confirm")).toBe("confirm");
    expect(remoteButtonToAction("back")).toBe("back");
    expect(remoteButtonToAction("cancel")).toBe("back");
    expect(remoteButtonToAction(" d_pad ")).toBeNull();
    expect(remoteButtonToAction("volume")).toBeNull();
  });

  test("[ER-25-04] keyboard actions fire synchronously and prevent scrolling", () => {
    const harness = setup();
    harness.input.attach();
    const event = harness.doc.defaultView.dispatch("keydown", {
      key: "ArrowRight",
    });
    expect(harness.actions).toEqual([{ action: "next", mode: "keyboard" }]);
    expect(event.defaultPrevented).toBe(true);

    const enter = harness.doc.defaultView.dispatch("keydown", { key: " " });
    expect(enter.defaultPrevented).toBe(true);
    expect(harness.actions[1]).toEqual({
      action: "confirm",
      mode: "keyboard",
    });
    expect(harness.modes).toEqual([]);
  });

  test("[ER-25-04] modifier chords and text entry are never stolen", () => {
    const harness = setup();
    for (const modifiers of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
    ]) {
      expect(
        harness.input.handleKey(keyboard(keyEvent("ArrowRight", modifiers))),
      ).toBe(false);
    }
    expect(harness.actions).toEqual([]);

    for (const tag of ["input", "textarea", "select"]) {
      expect(
        harness.input.handleKey(
          keyboard(
            keyEvent("Enter", { target: harness.doc.createElement(tag) }),
          ),
        ),
      ).toBe(false);
    }
    const editable = new FakeElement("div");
    editable.isContentEditable = true;
    expect(
      harness.input.handleKey(keyboard(keyEvent("Enter", { target: editable }))),
    ).toBe(false);
    expect(harness.actions).toEqual([]);
  });

  test("[ER-25-04] native buttons keep Enter/Space; game tiles opt into confirm", () => {
    const harness = setup();
    const nativeButton = harness.doc.createElement("button");
    const anchor = harness.doc.createElement("a");
    const tile = harness.doc.createElement("button");
    tile.dataset["consoleTile"] = "true";

    expect(
      harness.input.handleKey(
        keyboard(keyEvent("Enter", { target: nativeButton })),
      ),
    ).toBe(false);
    expect(
      harness.input.handleKey(keyboard(keyEvent(" ", { target: anchor }))),
    ).toBe(false);
    expect(harness.actions).toEqual([]);

    expect(
      harness.input.handleKey(keyboard(keyEvent("Enter", { target: tile }))),
    ).toBe(true);
    expect(harness.actions).toEqual([{ action: "confirm", mode: "keyboard" }]);
  });

  test("[ER-25-04] holding a movement key repeats but holding Enter launches once", () => {
    const harness = setup();
    expect(
      harness.input.handleKey(keyboard(keyEvent("ArrowDown", { repeat: true }))),
    ).toBe(true);
    expect(
      harness.input.handleKey(keyboard(keyEvent("Enter", { repeat: true }))),
    ).toBe(false);
    expect(harness.actions.map((entry) => entry.action)).toEqual(["next"]);
  });

  test("[ER-25-04] phone remotes emit the same actions with their own hint mode", () => {
    const harness = setup();
    expect(harness.input.handleRemote("up")).toBe(true);
    expect(harness.input.handleRemote("down")).toBe(true);
    expect(harness.input.handleRemote("ok")).toBe(true);
    expect(harness.input.handleRemote("back")).toBe(true);
    expect(harness.input.handleRemote("volume-up")).toBe(false);
    expect(harness.actions.map((entry) => entry.action)).toEqual([
      "prev",
      "next",
      "confirm",
      "back",
    ]);
    expect(harness.actions.every((entry) => entry.mode === "remote")).toBe(true);
    expect(harness.modes).toEqual(["remote"]);
    expect(harness.input.currentMode).toBe("remote");
  });

  test("[ER-25-04] gamepad buttons emit on the press edge only", () => {
    let pads: Array<GamepadLike | null> = [
      pad({ buttons: [GAMEPAD_BUTTONS.confirm] }),
    ];
    const harness = setup({ gamepads: () => pads });
    expect(harness.input.pollGamepad()).toEqual(["confirm"]);
    expect(harness.actions).toEqual([{ action: "confirm", mode: "gamepad" }]);
    expect(harness.input.pollGamepad()).toEqual([]);

    pads = [pad()];
    expect(harness.input.pollGamepad()).toEqual([]);
    pads = [pad({ buttons: [GAMEPAD_BUTTONS.confirm] })];
    expect(harness.input.pollGamepad()).toEqual(["confirm"]);

    const buttons: Array<[number, ConsoleAction]> = [
      [GAMEPAD_BUTTONS.back, "back"],
      [GAMEPAD_BUTTONS.up, "prev"],
      [GAMEPAD_BUTTONS.down, "next"],
      [GAMEPAD_BUTTONS.left, "prev"],
      [GAMEPAD_BUTTONS.right, "next"],
    ];
    for (const [index, action] of buttons) {
      pads = [pad({ buttons: [index] })];
      expect(harness.input.pollGamepad()).toEqual([action]);
      pads = [pad()];
      harness.input.pollGamepad();
    }
    expect(harness.modes).toEqual(["gamepad"]);
  });

  test("[ER-25-04] gamepad stick edges use 0.5 press / 0.35 re-arm hysteresis", () => {
    let pads: Array<GamepadLike | null> = [pad({ axes: [GAMEPAD_DEADZONE, 0] })];
    const harness = setup({ gamepads: () => pads });
    expect(harness.input.pollGamepad()).toEqual(["next"]);
    expect(harness.input.pollGamepad()).toEqual([]);

    pads = [pad({ axes: [GAMEPAD_DEADZONE - 0.01, 0] })];
    expect(harness.input.pollGamepad()).toEqual([]);
    pads = [pad({ axes: [GAMEPAD_DEADZONE, 0] })];
    expect(harness.input.pollGamepad()).toEqual([]);

    pads = [pad({ axes: [0, 0] })];
    expect(harness.input.pollGamepad()).toEqual([]);
    pads = [pad({ axes: [GAMEPAD_DEADZONE, 0] })];
    expect(harness.input.pollGamepad()).toEqual(["next"]);

    pads = [pad({ axes: [0, 0] })];
    harness.input.pollGamepad();
    pads = [pad({ axes: [0, -GAMEPAD_DEADZONE] })];
    expect(harness.input.pollGamepad()).toEqual(["prev"]);

    pads = [pad({ axes: [-GAMEPAD_REARM, 0] })];
    harness.input.pollGamepad();
    pads = [pad({ axes: [-GAMEPAD_DEADZONE, 0] })];
    expect(harness.input.pollGamepad()).toEqual(["prev"]);
  });

  test("[ER-25-04] at most one action is emitted per poll across several pads", () => {
    const pads: Array<GamepadLike | null> = [
      pad({ buttons: [GAMEPAD_BUTTONS.confirm] }),
      pad({ buttons: [GAMEPAD_BUTTONS.up] }),
      null,
    ];
    const harness = setup({ gamepads: () => pads });
    expect(harness.input.pollGamepad()).toEqual(["confirm", "prev"]);
    expect(harness.actions).toEqual([{ action: "confirm", mode: "gamepad" }]);
    expect(harness.input.pollGamepad()).toEqual([]);
  });

  test("[ER-25-04] attach is idempotent, detach stops keys, destroy releases everything", () => {
    const harness = setup();
    harness.input.attach();
    harness.input.attach();
    expect(harness.doc.defaultView.listenerCount("keydown")).toBe(1);
    harness.doc.defaultView.dispatch("keydown", { key: "ArrowLeft" });
    expect(harness.actions).toHaveLength(1);

    harness.input.detach();
    expect(harness.doc.defaultView.listenerCount("keydown")).toBe(0);
    harness.doc.defaultView.dispatch("keydown", { key: "ArrowLeft" });
    expect(harness.actions).toHaveLength(1);

    harness.input.attach();
    harness.input.destroy();
    expect(harness.doc.defaultView.listenerCount("keydown")).toBe(0);
    expect(harness.input.attached).toBe(false);
    expect(harness.input.pollGamepad()).toEqual([]);
    expect(harness.input.handleRemote("ok")).toBe(false);
  });
});
