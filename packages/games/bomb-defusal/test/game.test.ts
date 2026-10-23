/**
 * Bomb Defusal host adapter (G5, FR-7.17, FR-8.2, SR-13, ER-24-01, ER-24-06).
 *
 * Each test drives the real `Game` through fixed `simulate` ticks with a
 * recording `GameContext`; there is no DOM and no socket. Panels are captured
 * per slot, so a test can assert that a rule page reached exactly one phone
 * and never the TV.
 */
import { describe, expect, test } from "vitest";
import { validatePanelContent, type GameControllerState } from "@lanpad/sdk";
import {
  KEYPAD_ALPHABET,
  WIRE_COLORS,
  allModulesSolved,
  buttonHoldTarget,
  keypadCode,
  wireSolution,
  type Bomb,
  type ButtonColor,
  type WireColor,
} from "../src/bomb.js";
import { BOMB_CONFIG } from "../src/config.js";
import { BD_DEFUSER_LAYOUT_ID, BD_MANUAL_LAYOUT_ID } from "../src/game.js";
import {
  STEP_MS,
  createFakePlayer,
  createHarness,
  panelText,
  type Harness,
} from "./harness.js";

const BUTTON_BIT = 1 << BOMB_CONFIG.buttonBit;

function bombOf(harness: Harness): Bomb {
  const bomb = harness.game.bomb;
  if (bomb === null) {
    throw new Error("the round has not generated a bomb yet");
  }
  return bomb;
}

/** Connected fake controllers for slots 1..count. */
function roster(count: number): GameControllerState[] {
  const players: GameControllerState[] = [];
  for (let slot = 1; slot <= count; slot += 1) {
    players.push(createFakePlayer(slot));
  }
  return players;
}

/** Patches one controller in place; the other players keep their state. */
function setPlayer(
  harness: Harness,
  slot: number,
  patch: Partial<GameControllerState>,
): void {
  harness.setPlayers(
    harness.input.snapshot.players.map((player) =>
      player.slot === slot ? { ...player, ...patch } : player,
    ),
  );
}

/** Sends one button state and advances exactly one fixed tick. */
function pressButton(harness: Harness, buttons: number, edges: number): void {
  setPlayer(harness, 1, { buttons, edges });
  harness.tick();
}

/**
 * Solves the button through the real input path: press, hold to the manual's
 * exact target, release. Blue is a tap, so it is press-and-release in one tick.
 */
function solveButton(harness: Harness, color: ButtonColor): void {
  if (color === "blue") {
    pressButton(harness, 0, BUTTON_BIT);
  } else {
    const target = buttonHoldTarget(color);
    pressButton(harness, BUTTON_BIT, BUTTON_BIT);
    for (let held = STEP_MS; held < target; held += STEP_MS) {
      pressButton(harness, BUTTON_BIT, 0);
    }
    pressButton(harness, 0, 0);
  }
  setPlayer(harness, 1, { buttons: 0, edges: 0 });
}

function wrongWireColor(bomb: Bomb): WireColor {
  const solution = wireSolution(bomb);
  const wrong = WIRE_COLORS.find((color) => color !== solution);
  if (wrong === undefined) {
    throw new Error("the wire palette must contain a second colour");
  }
  return wrong;
}

/** Draws one frame and returns every string the TV was asked to draw. */
function renderTv(harness: Harness): string {
  harness.game.render(0);
  return harness.renderer.texts.join("\n");
}

describe("Bomb Defusal round", () => {
  test("[ER-24-01] the lobby waits for the manifest minimum and then starts the round", () => {
    const harness = createHarness({ players: [createFakePlayer(1)] });

    harness.tick(3);
    expect(harness.game.phase).toBe("lobby");
    expect(harness.game.bomb).toBeNull();
    expect(harness.game.connectedCount).toBe(1);
    expect(panelText(harness.panels.last(1))).toContain("Waiting for 2 players");

    harness.setPlayers([createFakePlayer(1), createFakePlayer(2)]);
    harness.tick();
    expect(harness.game.phase).toBe("countdown");
    expect(harness.game.bomb).not.toBeNull();
    expect(harness.game.timerRemainingMs).toBe(60_000);
    expect(harness.layouts.lastFor(1)).toBe(BD_DEFUSER_LAYOUT_ID);
    expect(harness.layouts.lastFor(2)).toBe(BD_MANUAL_LAYOUT_ID);

    harness.tick();
    expect(harness.game.phase).toBe("playing");
    expect(harness.game.timerRemainingMs).toBe(59_950);
  });

  test("[ER-24-01] the countdown shows the bomb and manual while the timer is paused", () => {
    const harness = createHarness({ game: { countdownMs: 1_000 } });

    harness.tick();
    expect(harness.game.phase).toBe("countdown");
    expect(harness.game.bomb).not.toBeNull();
    expect(harness.game.timerRemainingMs).toBe(60_000);
    expect(panelText(harness.panels.last(2))).toContain("MANUAL 1/4 - START");

    harness.tick(19);
    expect(harness.game.phase).toBe("countdown");
    expect(harness.game.timerRemainingMs).toBe(60_000);

    harness.tick();
    expect(harness.game.phase).toBe("playing");
    expect(harness.game.timerRemainingMs).toBe(59_950);
  });

  test("[FR-8.2] the lowest connected slot defuses and every other phone holds the manual", () => {
    const harness = createHarness({ players: roster(4) });
    harness.advanceToPlaying();

    expect(harness.game.defuserSlot).toBe(1);
    expect(harness.game.connectedCount).toBe(4);
    expect(harness.game.connectedMask).toBe(0b11110);
    expect(harness.layouts.lastFor(1)).toBe(BD_DEFUSER_LAYOUT_ID);
    expect(panelText(harness.panels.last(1))).toContain("DEFUSER TOOL");

    for (const slot of [2, 3, 4]) {
      expect(harness.layouts.lastFor(slot)).toBe(BD_MANUAL_LAYOUT_ID);
      expect(panelText(harness.panels.last(slot))).toContain(
        "MANUAL 1/4 - START",
      );
    }
  });

  test("[G4] all eight controllers join, are laid out and receive a private panel", () => {
    const harness = createHarness({ players: roster(8) });
    harness.advanceToPlaying();

    expect(harness.game.connectedCount).toBe(8);
    expect(harness.game.connectedMask).toBe(510);
    expect(harness.game.defuserSlot).toBe(1);
    expect(harness.game.layoutErrors).toBe(0);
    expect(harness.game.panelErrors).toBe(0);
    expect(harness.debug.counters.get("players")).toBe(8);

    for (let slot = 1; slot <= 8; slot += 1) {
      expect(harness.layouts.lastFor(slot)).toBe(
        slot === 1 ? BD_DEFUSER_LAYOUT_ID : BD_MANUAL_LAYOUT_ID,
      );
      const content = harness.panels.last(slot);
      expect(content, `slot ${slot}`).toBeDefined();
      const result = validatePanelContent(content);
      expect(
        result.ok,
        `slot ${slot}: ${result.ok ? "" : result.errors.join("; ")}`,
      ).toBe(true);
    }
  });

  test("[SR-13] manual pages stay on their own phone and never reach the TV", () => {
    const harness = createHarness();
    harness.advanceToPlaying();
    const bomb = bombOf(harness);

    // Page the reader to the keypad table, the most sensitive private page.
    for (let page = 0; page < 3; page += 1) {
      setPlayer(harness, 2, { edges: 1 << BOMB_CONFIG.nextBit });
      harness.tick();
    }
    setPlayer(harness, 2, { edges: 0 });
    expect(harness.game.manualPages[1]).toBe(3);

    const defuserPanel = harness.panels.last(1);
    const readerPanel = harness.panels.last(2);
    expect(defuserPanel).toBeDefined();
    expect(readerPanel).toBeDefined();
    const defuserText = panelText(defuserPanel);
    const readerText = panelText(readerPanel);

    expect(validatePanelContent(defuserPanel).ok).toBe(true);
    expect(validatePanelContent(readerPanel).ok).toBe(true);
    expect(
      harness.panels.records.every(
        (record) => record.slot === 1 || record.slot === 2,
      ),
    ).toBe(true);
    expect(harness.panels.last(3)).toBeUndefined();

    expect(defuserText).toContain("DEFUSER TOOL");
    expect(defuserText).not.toMatch(/MANUAL \d\/\d/);
    expect(defuserText.toLowerCase()).not.toContain("last digit of the serial");
    expect(defuserText).not.toMatch(/^[A-H] = \d$/m);

    expect(readerText).toContain("MANUAL 4/4 - KEYPAD");
    expect(readerText).not.toContain("DEFUSER TOOL");
    for (const letter of KEYPAD_ALPHABET) {
      expect(readerText).toContain(`${letter} = ${bomb.keypad.mapping[letter]}`);
    }
    expect(readerText).not.toContain(keypadCode(bomb.keypad));

    const tv = renderTv(harness);
    expect(tv).toContain("BOMB DEFUSAL");
    expect(tv).toContain(`SERIAL ${bomb.serial}`);
    for (const color of bomb.wires.wires) {
      expect(tv).toContain(color.toUpperCase());
    }
    expect(tv).toContain(bomb.button.color.toUpperCase());
    for (const symbol of bomb.keypad.symbols) {
      expect(tv).toContain(symbol);
    }

    expect(tv).not.toMatch(/MANUAL \d\/\d/);
    expect(tv.toLowerCase()).not.toContain("last digit of the serial");
    expect(tv.toLowerCase()).not.toContain("you are the manual reader");
    expect(tv.toLowerCase()).not.toContain("hold 1 second");
    expect(tv).not.toContain("DEFUSER TOOL");
    expect(harness.renderer.texts).not.toContain(keypadCode(bomb.keypad));
    expect(harness.renderer.texts.some((value) => /^\d{4}$/.test(value))).toBe(
      false,
    );
  });

  test("[FR-8.2] manual readers page with their own buttons and clamp at both ends", () => {
    const harness = createHarness();
    harness.advanceToPlaying();
    const next = 1 << BOMB_CONFIG.nextBit;
    const prev = 1 << BOMB_CONFIG.prevBit;
    const readerPage = (): number => harness.game.manualPages[1] ?? -1;

    setPlayer(harness, 2, { edges: next });
    harness.tick();
    expect(readerPage()).toBe(1);
    expect(panelText(harness.panels.last(2))).toContain("MANUAL 2/4 - WIRES");

    setPlayer(harness, 2, { edges: next });
    harness.tick();
    expect(readerPage()).toBe(2);
    expect(panelText(harness.panels.last(2))).toContain("MANUAL 3/4 - BUTTON");

    setPlayer(harness, 2, { edges: prev });
    harness.tick();
    expect(readerPage()).toBe(1);

    // The defuser has no manual and cannot page a reader's phone.
    setPlayer(harness, 2, { edges: 0 });
    setPlayer(harness, 1, { edges: prev });
    harness.tick();
    expect(harness.game.manualPages[0] ?? -1).toBe(0);
    expect(harness.game.strikes).toBe(0);
    setPlayer(harness, 1, { edges: 0 });

    for (let index = 0; index < 4; index += 1) {
      setPlayer(harness, 2, { edges: next });
      harness.tick();
    }
    expect(readerPage()).toBe(3);
    expect(panelText(harness.panels.last(2))).toContain("MANUAL 4/4 - KEYPAD");

    for (let index = 0; index < 6; index += 1) {
      setPlayer(harness, 2, { edges: prev });
      harness.tick();
    }
    expect(readerPage()).toBe(0);
    expect(panelText(harness.panels.last(2))).toContain("MANUAL 1/4 - START");
  });

  test("[G5] three wrong wires explode the bomb", () => {
    const harness = createHarness();
    harness.advanceToPlaying();
    const bomb = bombOf(harness);
    const wrong = wrongWireColor(bomb);

    for (let strike = 1; strike <= BOMB_CONFIG.strikesAllowed; strike += 1) {
      harness.emitChoice(1, wrong);
      expect(harness.game.strikes).toBe(strike);
      expect(harness.game.phase, `strike ${strike}`).toBe(
        strike === BOMB_CONFIG.strikesAllowed ? "results" : "playing",
      );
    }
    expect(bomb.wires.solved).toBe(false);
    expect(harness.game.roundCause).toBe("strikes");

    const strikePulses = harness.haptics.pulses.filter(
      (pulse) => pulse.pattern.join(",") === "120,60,120",
    );
    expect(strikePulses).toHaveLength(3);
    const lostPulses = harness.haptics.pulses.filter(
      (pulse) => pulse.pattern.join(",") === "400,100,400",
    );
    expect(lostPulses).toHaveLength(1);

    const tv = renderTv(harness);
    expect(tv).toContain("BOMB EXPLODED");
    expect(tv).toContain("Three strikes.");
  });

  test("[G5] following the manual solves the wire, the button and the keypad", () => {
    const harness = createHarness();
    harness.advanceToPlaying();
    const bomb = bombOf(harness);

    harness.emitChoice(1, wireSolution(bomb));
    expect(bomb.wires.solved).toBe(true);
    expect(harness.game.phase).toBe("playing");

    solveButton(harness, bomb.button.color);
    expect(bomb.button.solved).toBe(true);
    expect(harness.game.phase).toBe("playing");

    harness.emitText(1, keypadCode(bomb.keypad));
    expect(bomb.keypad.solved).toBe(true);
    expect(allModulesSolved(bomb)).toBe(true);
    expect(harness.game.phase).toBe("results");
    expect(harness.game.roundCause).toBe("defused");
    expect(harness.game.resultTimeMs).toBeGreaterThan(0);

    const tv = renderTv(harness);
    expect(tv).toContain("BOMB DEFUSED");
    expect(tv).toContain("Every module is clear.");
    expect(tv).toContain("ALL MODULES CLEARED");

    const defusedPulses = harness.haptics.pulses.filter(
      (pulse) => pulse.pattern.join(",") === "60,40,60,40,160",
    );
    expect(defusedPulses).toHaveLength(1);
  });

  test("[G5] the timer expiring ends the round as an explosion", () => {
    const harness = createHarness({ game: { timerMs: 100 } });
    harness.advanceToPlaying();
    expect(harness.game.timerRemainingMs).toBe(50);

    harness.tick();
    expect(harness.game.phase).toBe("results");
    expect(harness.game.roundCause).toBe("timeout");
    expect(harness.game.timerRemainingMs).toBe(0);
    expect(harness.game.resultTimeMs).toBe(0);

    const tv = renderTv(harness);
    expect(tv).toContain("BOMB EXPLODED");
    expect(tv).toContain("The timer reached zero.");
  });

  test("[FR-7.17] a defuser disconnect starts the grace and a reconnect cancels it", () => {
    const harness = createHarness();
    harness.advanceToPlaying();
    expect(harness.game.timerRemainingMs).toBe(59_950);

    setPlayer(harness, 1, { connected: false });
    harness.tick();
    expect(harness.game.phase).toBe("playing");
    expect(harness.game.connectedCount).toBe(1);
    expect(harness.game.graceRemainingMs).toBe(950);
    expect(harness.game.timerRemainingMs).toBe(59_900);
    expect(harness.layouts.clears).toContain(1);

    harness.tick();
    expect(harness.game.graceRemainingMs).toBe(900);
    expect(harness.game.timerRemainingMs).toBe(59_850);

    setPlayer(harness, 1, { connected: true });
    harness.tick();
    expect(harness.game.phase).toBe("playing");
    expect(harness.game.graceRemainingMs).toBe(-1);
    expect(harness.game.timerRemainingMs).toBe(59_800);
    expect(harness.layouts.lastFor(1)).toBe(BD_DEFUSER_LAYOUT_ID);
  });

  test("[FR-7.17] the grace expiring loses the round", () => {
    const harness = createHarness({ game: { defuserGraceMs: 100 } });
    harness.advanceToPlaying();

    setPlayer(harness, 1, { connected: false });
    harness.tick();
    expect(harness.game.phase).toBe("playing");
    expect(harness.game.graceRemainingMs).toBe(50);

    harness.tick();
    expect(harness.game.phase).toBe("results");
    expect(harness.game.roundCause).toBe("defuser-lost");
    expect(harness.game.graceRemainingMs).toBe(-1);

    const tv = renderTv(harness);
    expect(tv).toContain("BOMB EXPLODED");
    expect(tv).toContain("The defuser did not return in time.");
  });

  test("[ER-24-01] results ignore input for the lockout, then any button starts a new bomb", () => {
    const harness = createHarness({ game: { timerMs: 100 } });
    harness.advanceToPlaying();
    harness.tick();
    expect(harness.game.phase).toBe("results");
    const firstBomb = harness.game.bomb;

    harness.tick(2);
    setPlayer(harness, 1, { edges: BUTTON_BIT });
    harness.tick();
    expect(harness.game.phase).toBe("results");
    setPlayer(harness, 1, { edges: 0 });

    harness.tick(17);
    expect(harness.game.phase).toBe("results");

    setPlayer(harness, 1, { edges: BUTTON_BIT });
    harness.tick();
    expect(harness.game.phase).toBe("countdown");
    expect(harness.game.bomb).not.toBe(firstBomb);
    expect(harness.game.strikes).toBe(0);
    expect(harness.game.roundCause).toBeNull();

    setPlayer(harness, 1, { edges: 0 });
    harness.tick();
    expect(harness.game.phase).toBe("playing");
    expect(harness.game.timerRemainingMs).toBe(50);
  });

  test("[ER-24-01] a kit event starts the next round after the lockout", () => {
    const harness = createHarness({ game: { timerMs: 100 } });
    harness.advanceToPlaying();
    harness.tick();
    expect(harness.game.phase).toBe("results");

    harness.tick(21);
    harness.bus.emit(1, "kit.text", { value: 42 });
    harness.tick();
    expect(harness.game.phase).toBe("results");

    harness.bus.emit(1, "kit.choice", { value: "red" });
    harness.tick();
    expect(harness.game.phase).toBe("countdown");
  });

  test("[ER-24-06] malformed, reader and lobby events are ignored", () => {
    const harness = createHarness();
    harness.advanceToPlaying();
    const bomb = bombOf(harness);

    harness.emitChoice(2, wireSolution(bomb));
    harness.bus.emit(1, "kit.choice", { value: "purple" });
    for (const malformed of ["12", "abcd", "12345"]) {
      harness.emitText(1, malformed);
    }
    harness.bus.emit(1, "kit.text", { value: 42 });
    harness.bus.emit(1, "kit.text", {});
    harness.bus.emit(1, "kit.text", null);

    expect(harness.game.phase).toBe("playing");
    expect(harness.game.strikes).toBe(0);
    expect(bomb.wires.solved).toBe(false);
    expect(bomb.button.solved).toBe(false);
    expect(bomb.keypad.solved).toBe(false);

    const waiting = createHarness({ players: [createFakePlayer(1)] });
    waiting.tick(3);
    waiting.bus.emit(1, "kit.choice", { value: "red" });
    expect(waiting.game.phase).toBe("lobby");
    expect(waiting.game.bomb).toBeNull();
    expect(waiting.game.strikes).toBe(0);
  });

  test("[FR-7.17] dispose unsubscribes, is idempotent and stops simulate and render", () => {
    const harness = createHarness();
    harness.advanceToPlaying();
    harness.game.render(0);
    expect(harness.renderer.frameCount).toBe(1);
    expect(harness.bus.subscriptionCount).toBeGreaterThan(0);
    const panelCount = harness.panels.records.length;
    const textCount = harness.renderer.texts.length;

    harness.game.dispose();
    expect(harness.bus.subscriptionCount).toBe(0);
    expect(harness.game.bomb).toBeNull();
    expect(harness.game.phase).toBe("lobby");
    expect(() => harness.game.dispose()).not.toThrow();

    harness.tick(2);
    harness.game.render(0);
    harness.bus.emit(1, "kit.choice", { value: "red" });
    harness.bus.emit(1, "kit.text", { value: "1234" });

    expect(harness.panels.records).toHaveLength(panelCount);
    expect(harness.renderer.frameCount).toBe(1);
    expect(harness.renderer.texts).toHaveLength(textCount);
  });
});
