/**
 * Bomb Defusal rules, generator and manual (G5).
 *
 * The central property is "solvable by construction": every generated bomb
 * exposes the facts its rules need, and applying the rules derived from those
 * facts clears all three modules. The 10,000-seed run below is the evidence.
 */
import { describe, expect, test } from "vitest";
import { validatePanelContent } from "@lanpad/sdk";
import {
  BUTTON_COLORS,
  BUTTON_HOLD_MS,
  BUTTON_INSTRUCTIONS,
  BUTTON_LABELS,
  KEYPAD_ALPHABET,
  MANUAL_PAGE_COUNT,
  WIRE_COLORS,
  WIRE_LABELS,
  allModulesSolved,
  applyButtonAction,
  applyKeypadAction,
  applyWireAction,
  buttonHoldIsCorrect,
  buttonHoldTarget,
  checkBombSolvable,
  formatTimer,
  generateBomb,
  keypadCode,
  manualPanelContent,
  solvedCount,
  wireSolution,
  type Bomb,
  type ButtonColor,
  type WireColor,
} from "../src/bomb.js";
import { BOMB_CONFIG } from "../src/config.js";
import { createSeededRng, panelText } from "./harness.js";

const SOLVABILITY_SEEDS = 10_000;

function generated(seed: number): Bomb {
  return generateBomb(createSeededRng(seed));
}

function wrongWireColor(bomb: Bomb): WireColor {
  const solution = wireSolution(bomb);
  const wrong = WIRE_COLORS.find((color) => color !== solution);
  if (wrong === undefined) {
    throw new Error("the wire palette must contain a second colour");
  }
  return wrong;
}

function wrongHoldMs(bomb: Bomb): number {
  const target = buttonHoldTarget(bomb.button.color);
  return bomb.button.color === "blue"
    ? BOMB_CONFIG.tapMaxMs + 1_000
    : target + BOMB_CONFIG.buttonHoldToleranceMs + 1;
}

function differentCode(bomb: Bomb): string {
  return keypadCode(bomb.keypad) === "0000" ? "1111" : "0000";
}

describe("Bomb Defusal rules", () => {
  test("[G5] 10,000 generated bombs are solvable by construction", () => {
    const buttonColors = new Set<ButtonColor>();
    const wireColorsSeen = new Set<WireColor>();

    for (let seed = 1; seed <= SOLVABILITY_SEEDS; seed += 1) {
      const bomb = generated(seed);
      const check = checkBombSolvable(bomb);
      expect(check.ok, `seed ${seed}: ${check.errors.join("; ")}`).toBe(true);

      expect(bomb.serial, `seed ${seed}`).toMatch(/^[A-Z0-9]{4}\d$/);
      expect(bomb.batteries, `seed ${seed}`).toBeGreaterThanOrEqual(1);
      expect(bomb.batteries, `seed ${seed}`).toBeLessThanOrEqual(4);
      expect(bomb.indicators, `seed ${seed}`).toHaveLength(2);
      expect(solvedCount(bomb), `seed ${seed}`).toBe(0);

      expect(
        applyWireAction(bomb, wireSolution(bomb)),
        `seed ${seed} wires`,
      ).toBe("solved");
      expect(
        applyButtonAction(bomb, buttonHoldTarget(bomb.button.color)),
        `seed ${seed} button`,
      ).toBe("solved");
      expect(
        applyKeypadAction(bomb, keypadCode(bomb.keypad)),
        `seed ${seed} keypad`,
      ).toBe("solved");
      expect(allModulesSolved(bomb), `seed ${seed}`).toBe(true);
      expect(solvedCount(bomb), `seed ${seed}`).toBe(BOMB_CONFIG.moduleCount);

      buttonColors.add(bomb.button.color);
      for (const color of bomb.wires.wires) wireColorsSeen.add(color);
    }

    // The generator must exercise the whole rule space, not one corner.
    expect(buttonColors.size).toBe(BUTTON_COLORS.length);
    expect(wireColorsSeen.size).toBe(WIRE_COLORS.length);
  }, 30_000);

  test("[G5] the wire rule depends only on the serial's last digit", () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const bomb = generated(seed);
      const lastDigit = Number(bomb.serial.charAt(bomb.serial.length - 1));
      expect(Number.isInteger(lastDigit), `seed ${seed}`).toBe(true);

      expect(bomb.wires.evenColor).not.toBe(bomb.wires.oddColor);
      expect(bomb.wires.wires).toContain(bomb.wires.evenColor);
      expect(bomb.wires.wires).toContain(bomb.wires.oddColor);
      expect(wireSolution(bomb)).toBe(
        lastDigit % 2 === 0 ? bomb.wires.evenColor : bomb.wires.oddColor,
      );

      expect(bomb.wires.wires.length).toBeGreaterThanOrEqual(
        BOMB_CONFIG.wiresMin,
      );
      expect(bomb.wires.wires.length).toBeLessThanOrEqual(
        BOMB_CONFIG.wiresMax,
      );
      expect(new Set(bomb.wires.wires).size).toBe(bomb.wires.wires.length);
      for (const color of bomb.wires.wires) {
        expect(WIRE_COLORS).toContain(color);
        expect(WIRE_LABELS[color].length).toBeGreaterThan(0);
      }
    }
  });

  test("[G5] the button rule accepts the target within tolerance only", () => {
    for (const color of BUTTON_COLORS) {
      const target = buttonHoldTarget(color);
      expect(target).toBe(BUTTON_HOLD_MS[color]);

      if (color === "blue") {
        expect(buttonHoldIsCorrect(color, 0)).toBe(true);
        expect(buttonHoldIsCorrect(color, BOMB_CONFIG.tapMaxMs - 1)).toBe(true);
        expect(buttonHoldIsCorrect(color, BOMB_CONFIG.tapMaxMs)).toBe(false);
      } else {
        expect(buttonHoldIsCorrect(color, target)).toBe(true);
        expect(
          buttonHoldIsCorrect(
            color,
            target - BOMB_CONFIG.buttonHoldToleranceMs,
          ),
        ).toBe(true);
        expect(
          buttonHoldIsCorrect(
            color,
            target + BOMB_CONFIG.buttonHoldToleranceMs,
          ),
        ).toBe(true);
        expect(
          buttonHoldIsCorrect(
            color,
            target - BOMB_CONFIG.buttonHoldToleranceMs - 1,
          ),
        ).toBe(false);
        expect(
          buttonHoldIsCorrect(
            color,
            target + BOMB_CONFIG.buttonHoldToleranceMs + 1,
          ),
        ).toBe(false);
      }
    }

    expect(buttonHoldIsCorrect("red", -1)).toBe(false);
    expect(buttonHoldIsCorrect("red", Number.NaN)).toBe(false);
    expect(buttonHoldIsCorrect("white", Number.POSITIVE_INFINITY)).toBe(false);
  });

  test("[G5] the keypad code is derived left to right from the shown letters", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const bomb = generated(seed);
      const module = bomb.keypad;

      expect(module.symbols).toHaveLength(4);
      expect(new Set(module.symbols).size).toBe(4);
      for (const symbol of module.symbols) {
        expect(KEYPAD_ALPHABET).toContain(symbol);
      }

      const digits = KEYPAD_ALPHABET.map((letter) => module.mapping[letter]);
      for (const digit of digits) {
        expect(digit).toMatch(/^\d$/);
      }
      expect(new Set(digits).size).toBe(KEYPAD_ALPHABET.length);

      const code = keypadCode(module);
      expect(code).toMatch(/^\d{4}$/);
      for (let index = 0; index < module.symbols.length; index += 1) {
        const symbol = module.symbols[index];
        if (symbol === undefined) {
          throw new Error("keypad symbol is missing");
        }
        expect(code.charAt(index)).toBe(module.mapping[symbol]);
      }
    }
  });

  test("[G5] wrong wire, hold or code strikes while malformed text is ignored", () => {
    const wireBomb = generated(11);
    expect(applyWireAction(wireBomb, wrongWireColor(wireBomb))).toBe("strike");
    expect(wireBomb.wires.solved).toBe(false);
    expect(applyWireAction(wireBomb, wireSolution(wireBomb))).toBe("solved");
    expect(applyWireAction(wireBomb, wrongWireColor(wireBomb))).toBe("ignored");

    const buttonBomb = generated(12);
    expect(applyButtonAction(buttonBomb, wrongHoldMs(buttonBomb))).toBe("strike");
    expect(buttonBomb.button.solved).toBe(false);
    expect(
      applyButtonAction(buttonBomb, buttonHoldTarget(buttonBomb.button.color)),
    ).toBe("solved");
    expect(applyButtonAction(buttonBomb, wrongHoldMs(buttonBomb))).toBe(
      "ignored",
    );

    const keypadBomb = generated(13);
    for (const malformed of ["12", "abcd", "12345", "", "   "]) {
      expect(applyKeypadAction(keypadBomb, malformed)).toBe("ignored");
    }
    expect(keypadBomb.keypad.solved).toBe(false);
    expect(applyKeypadAction(keypadBomb, differentCode(keypadBomb))).toBe(
      "strike",
    );
    expect(keypadBomb.keypad.solved).toBe(false);
    expect(applyKeypadAction(keypadBomb, keypadCode(keypadBomb.keypad))).toBe(
      "solved",
    );
    expect(applyKeypadAction(keypadBomb, differentCode(keypadBomb))).toBe(
      "ignored",
    );
  });

  test("[G5] manual pages follow the rule tables and omit the keypad code", () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const bomb = generated(seed);
      const code = keypadCode(bomb.keypad);

      const start = manualPanelContent(bomb, 0);
      const wires = manualPanelContent(bomb, 1);
      const button = manualPanelContent(bomb, 2);
      const keypad = manualPanelContent(bomb, 3);

      for (const content of [start, wires, button, keypad]) {
        const result = validatePanelContent(content);
        expect(
          result.ok,
          `seed ${seed}: ${result.ok ? "" : result.errors.join("; ")}`,
        ).toBe(true);
      }

      const startText = panelText(start);
      expect(startText).toContain("MANUAL 1/4 - START");
      expect(startText).toContain(bomb.serial);
      expect(startText).toContain(`Batteries: ${bomb.batteries}`);
      expect(startText).toContain(bomb.indicators.join(" / "));

      const wiresText = panelText(wires);
      expect(wiresText).toContain("MANUAL 2/4 - WIRES");
      expect(wiresText).toContain(WIRE_LABELS[bomb.wires.evenColor]);
      expect(wiresText).toContain(WIRE_LABELS[bomb.wires.oddColor]);
      expect(wiresText).toContain("even");
      expect(wiresText).toContain("odd");

      const buttonText = panelText(button);
      expect(buttonText).toContain("MANUAL 3/4 - BUTTON");
      for (const color of BUTTON_COLORS) {
        expect(buttonText).toContain(
          `${BUTTON_LABELS[color]} - ${BUTTON_INSTRUCTIONS[color]}`,
        );
      }

      const keypadText = panelText(keypad);
      expect(keypadText).toContain("MANUAL 4/4 - KEYPAD");
      for (const letter of KEYPAD_ALPHABET) {
        expect(keypadText).toContain(`${letter} = ${bomb.keypad.mapping[letter]}`);
      }
      // The reader converts letters themselves; the derived code stays hidden.
      expect(keypadText).not.toContain(code);

      expect(manualPanelContent(bomb, -1)).toEqual(start);
      expect(manualPanelContent(bomb, MANUAL_PAGE_COUNT)).toEqual(keypad);
      expect(manualPanelContent(bomb, 1.5)).toEqual(start);
    }
  });

  test("[G5] the three-module contract stays in sync with the rule tables", () => {
    expect([...BOMB_CONFIG.moduleTypes]).toEqual(["wires", "button", "keypad"]);
    expect(BOMB_CONFIG.moduleCount).toBe(BOMB_CONFIG.moduleTypes.length);
    expect(MANUAL_PAGE_COUNT).toBe(1 + BOMB_CONFIG.moduleTypes.length);
    expect(BOMB_CONFIG.strikesAllowed).toBe(3);

    for (const color of WIRE_COLORS) {
      expect(WIRE_LABELS[color].length).toBeGreaterThan(0);
    }
    for (const color of BUTTON_COLORS) {
      expect(BUTTON_LABELS[color].length).toBeGreaterThan(0);
      expect(BUTTON_INSTRUCTIONS[color].length).toBeGreaterThan(0);
      expect(BUTTON_HOLD_MS[color]).toBeGreaterThanOrEqual(0);
    }
    expect(KEYPAD_ALPHABET).toHaveLength(8);
  });

  test("[G5] formatTimer renders mm:ss and clamps invalid input", () => {
    expect(formatTimer(0)).toBe("00:00");
    expect(formatTimer(-5)).toBe("00:00");
    expect(formatTimer(Number.NaN)).toBe("00:00");
    expect(formatTimer(Number.POSITIVE_INFINITY)).toBe("00:00");
    expect(formatTimer(999)).toBe("00:00");
    expect(formatTimer(1_000)).toBe("00:01");
    expect(formatTimer(59_999)).toBe("00:59");
    expect(formatTimer(60_000)).toBe("01:00");
    expect(formatTimer(300_000)).toBe("05:00");
    expect(formatTimer(3_600_000)).toBe("60:00");
  });
});
