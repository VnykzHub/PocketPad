/**
 * Procedural bomb rules, generator and manual (GAME-BD-DATA-02, HOST-02/04).
 *
 * One source per rule. The generator stores only the facts a player can see
 * (serial, wire colours, button colour, keypad letters); each solution is a
 * pure function over those facts, and the manual is rendered from the same
 * tables. There is no hidden rule state that the manual could contradict.
 *
 * "Solvable by construction": the wire list always contains both parity
 * colours, the button colour is always in the hold table, and the four shown
 * keypad letters are always in the mapping. `checkBombSolvable` re-derives
 * every expected action and is run on 10,000 seeds in the tests.
 */
import type { PanelContent } from "@lanpad/sdk";
import { BOMB_CONFIG } from "./config.js";

export type WireColor = "red" | "blue" | "yellow" | "white" | "black" | "green";

export const WIRE_COLORS: readonly WireColor[] = [
  "red",
  "blue",
  "yellow",
  "white",
  "black",
  "green",
];

export const WIRE_LABELS: Readonly<Record<WireColor, string>> = {
  red: "RED",
  blue: "BLUE",
  yellow: "YELLOW",
  white: "WHITE",
  black: "BLACK",
  green: "GREEN",
};

export type ButtonColor = "blue" | "yellow" | "red" | "white";

export const BUTTON_COLORS: readonly ButtonColor[] = ["blue", "yellow", "red", "white"];

export const BUTTON_LABELS: Readonly<Record<ButtonColor, string>> = {
  blue: "BLUE",
  yellow: "YELLOW",
  red: "RED",
  white: "WHITE",
};

/**
 * Manual table for the button module. Blue is a tap; the other colours are
 * hold durations. Tolerance lives in `BOMB_CONFIG.buttonHoldToleranceMs`.
 */
export const BUTTON_HOLD_MS: Readonly<Record<ButtonColor, number>> = {
  blue: 0,
  yellow: 1_000,
  red: 2_000,
  white: 4_000,
};

export const BUTTON_INSTRUCTIONS: Readonly<Record<ButtonColor, string>> = {
  blue: "tap, release under 0.5 s",
  yellow: "hold 1 second",
  red: "hold 2 seconds",
  white: "hold 4 seconds",
};

/** Keypad alphabet: eight letters, four of which are shown on the TV. */
export const KEYPAD_ALPHABET: readonly string[] = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
];

const SERIAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
const SERIAL_LENGTH = 5;
const KEYPAD_SYMBOLS_SHOWN = 4;
const INDICATOR_POOL: readonly string[] = ["FRK", "NSA", "SIG", "CAR", "TRN", "BOB"];
const KEYPAD_ENTRY_PATTERN = /^\d{4}$/;

/** Minimal RNG surface: `ctx.rng` and test seeds both satisfy it. */
export interface RngLike {
  next(): number;
  int(min: number, max: number): number;
}

export type ActionOutcome = "solved" | "strike" | "ignored";

export interface WireModule {
  readonly type: "wires";
  /** 4..6 distinct colours, in display order. */
  readonly wires: WireColor[];
  /** Cut this colour when the serial's last digit is even. */
  readonly evenColor: WireColor;
  /** Cut this colour when the serial's last digit is odd. */
  readonly oddColor: WireColor;
  solved: boolean;
}

export interface ButtonModule {
  readonly type: "button";
  readonly color: ButtonColor;
  solved: boolean;
}

export interface KeypadModule {
  readonly type: "keypad";
  /** The four letters shown on the TV, in code order. */
  readonly symbols: string[];
  /** Letter -> digit for all eight letters in `KEYPAD_ALPHABET`. */
  readonly mapping: Readonly<Record<string, string>>;
  solved: boolean;
}

export interface Bomb {
  readonly serial: string;
  readonly batteries: number;
  readonly indicators: string[];
  readonly wires: WireModule;
  readonly button: ButtonModule;
  readonly keypad: KeypadModule;
}

/** Fisher-Yates copy; generator-only, so allocating here is fine. */
export function shuffled<T>(rng: RngLike, values: readonly T[]): T[] {
  const copy = values.slice();
  shuffleInPlace(rng, copy);
  return copy;
}

function shuffleInPlace<T>(rng: RngLike, values: T[]): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const other = rng.int(0, index);
    const first = values[index];
    const second = values[other];
    if (first === undefined || second === undefined) continue;
    values[index] = second;
    values[other] = first;
  }
}

function pick<T>(rng: RngLike, values: readonly T[]): T {
  if (values.length === 0) {
    throw new RangeError("cannot pick from an empty list");
  }
  const value = values[rng.int(0, values.length - 1)];
  if (value === undefined) {
    throw new RangeError("rng returned an out-of-range index");
  }
  return value;
}

function generateSerial(rng: RngLike): string {
  let serial = "";
  for (let index = 0; index < SERIAL_LENGTH - 1; index += 1) {
    serial += SERIAL_ALPHABET[rng.int(0, SERIAL_ALPHABET.length - 1)] ?? "A";
  }
  // The parity rule needs a digit at the end.
  serial += String(rng.int(0, 9));
  return serial;
}

function generateWires(rng: RngLike): WireModule {
  const colors = shuffled(rng, WIRE_COLORS);
  const evenColor = colors[0];
  const oddColor = colors[1];
  if (evenColor === undefined || oddColor === undefined) {
    throw new RangeError("wire palette must contain at least two colours");
  }
  const count =
    BOMB_CONFIG.wiresMin + rng.int(0, BOMB_CONFIG.wiresMax - BOMB_CONFIG.wiresMin);
  const wires = colors.slice(0, count);
  shuffleInPlace(rng, wires);
  return { type: "wires", wires, evenColor, oddColor, solved: false };
}

function generateButton(rng: RngLike): ButtonModule {
  return { type: "button", color: pick(rng, BUTTON_COLORS), solved: false };
}

function generateKeypad(rng: RngLike): KeypadModule {
  const digits = shuffled(rng, ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  const mapping: Record<string, string> = {};
  for (let index = 0; index < KEYPAD_ALPHABET.length; index += 1) {
    const letter = KEYPAD_ALPHABET[index];
    const digit = digits[index];
    if (letter === undefined || digit === undefined) {
      throw new RangeError("keypad table must have eight letters and eight digits");
    }
    mapping[letter] = digit;
  }
  const symbols = shuffled(rng, KEYPAD_ALPHABET).slice(0, KEYPAD_SYMBOLS_SHOWN);
  return { type: "keypad", symbols, mapping, solved: false };
}

/** Generates one complete, solvable bomb. The only random source is `rng`. */
export function generateBomb(rng: RngLike): Bomb {
  const indicators = shuffled(rng, INDICATOR_POOL).slice(0, 2);
  return {
    serial: generateSerial(rng),
    batteries: rng.int(1, 4),
    indicators,
    wires: generateWires(rng),
    button: generateButton(rng),
    keypad: generateKeypad(rng),
  };
}

function lastSerialDigit(bomb: Bomb): number {
  return bomb.serial.charCodeAt(bomb.serial.length - 1) - 48;
}

/** The one wire the manual tells the defuser to cut. */
export function wireSolution(bomb: Bomb): WireColor {
  return lastSerialDigit(bomb) % 2 === 0 ? bomb.wires.evenColor : bomb.wires.oddColor;
}

/** Target hold in milliseconds; blue's target 0 means "tap". */
export function buttonHoldTarget(color: ButtonColor): number {
  return BUTTON_HOLD_MS[color];
}

/** True when a release at `heldMs` matches the manual's table. */
export function buttonHoldIsCorrect(color: ButtonColor, heldMs: number): boolean {
  if (!Number.isFinite(heldMs) || heldMs < 0) return false;
  if (color === "blue") return heldMs < BOMB_CONFIG.tapMaxMs;
  return (
    Math.abs(heldMs - buttonHoldTarget(color)) <= BOMB_CONFIG.buttonHoldToleranceMs
  );
}

/** Code derived from the shown letters; never stored in the module. */
export function keypadCode(module: KeypadModule): string {
  let code = "";
  for (let index = 0; index < module.symbols.length; index += 1) {
    const symbol = module.symbols[index];
    if (symbol === undefined) return "";
    const digit = module.mapping[symbol];
    if (digit === undefined) return "";
    code += digit;
  }
  return code;
}

/** Applies a wire choice. Mutates `solved` only; the caller owns strikes. */
export function applyWireAction(bomb: Bomb, color: WireColor): ActionOutcome {
  if (bomb.wires.solved) return "ignored";
  if (color === wireSolution(bomb)) {
    bomb.wires.solved = true;
    return "solved";
  }
  return "strike";
}

/** Applies a completed button press. `heldMs` is measured on release. */
export function applyButtonAction(bomb: Bomb, heldMs: number): ActionOutcome {
  if (bomb.button.solved) return "ignored";
  if (buttonHoldIsCorrect(bomb.button.color, heldMs)) {
    bomb.button.solved = true;
    return "solved";
  }
  return "strike";
}

/**
 * Applies a keypad submission. A malformed entry (not exactly four digits) is
 * ignored rather than struck: partial text is not a deliberate wrong action.
 */
export function applyKeypadAction(bomb: Bomb, entry: string): ActionOutcome {
  if (bomb.keypad.solved) return "ignored";
  if (typeof entry !== "string") return "ignored";
  const text = entry.trim();
  if (!KEYPAD_ENTRY_PATTERN.test(text)) return "ignored";
  if (text === keypadCode(bomb.keypad)) {
    bomb.keypad.solved = true;
    return "solved";
  }
  return "strike";
}

export function solvedCount(bomb: Bomb): number {
  let solved = 0;
  if (bomb.wires.solved) solved += 1;
  if (bomb.button.solved) solved += 1;
  if (bomb.keypad.solved) solved += 1;
  return solved;
}

export function allModulesSolved(bomb: Bomb): boolean {
  return bomb.wires.solved && bomb.button.solved && bomb.keypad.solved;
}

/** `mm:ss`, clamped at zero. Shared by the TV HUD and the private status. */
export function formatTimer(remainingMs: number): string {
  const safe = Number.isFinite(remainingMs) && remainingMs > 0 ? remainingMs : 0;
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  const mm = minutes < 10 ? `0${minutes}` : String(minutes);
  const ss = seconds < 10 ? `0${seconds}` : String(seconds);
  return `${mm}:${ss}`;
}

export const MANUAL_PAGE_COUNT = 4;

function clampPage(pageIndex: number): number {
  if (!Number.isInteger(pageIndex)) return 0;
  if (pageIndex < 0) return 0;
  if (pageIndex >= MANUAL_PAGE_COUNT) return MANUAL_PAGE_COUNT - 1;
  return pageIndex;
}

/**
 * Builds one private manual page as blocks. The cover repeats only public
 * facts; the rule pages are generated from the same tables the checker uses.
 * The keypad code is deliberately absent: the reader converts the letters.
 */
export function manualPanelContent(bomb: Bomb, pageIndex: number): PanelContent {
  const page = clampPage(pageIndex);
  if (page === 1) {
    return {
      kind: "blocks",
      blocks: [
        { type: "heading", text: `MANUAL 2/${MANUAL_PAGE_COUNT} - WIRES` },
        {
          type: "paragraph",
          text:
            `If the last digit of the serial is even, cut the ${WIRE_LABELS[bomb.wires.evenColor]} wire. ` +
            `If it is odd, cut the ${WIRE_LABELS[bomb.wires.oddColor]} wire.`,
        },
        {
          type: "paragraph",
          text: "Cut exactly one wire. Only cut a wire that is shown on the bomb.",
        },
      ],
    };
  }
  if (page === 2) {
    const rows: string[] = [];
    for (let index = 0; index < BUTTON_COLORS.length; index += 1) {
      const color = BUTTON_COLORS[index];
      if (color === undefined) continue;
      rows.push(`${BUTTON_LABELS[color]} - ${BUTTON_INSTRUCTIONS[color]}`);
    }
    return {
      kind: "blocks",
      blocks: [
        { type: "heading", text: `MANUAL 3/${MANUAL_PAGE_COUNT} - BUTTON` },
        {
          type: "paragraph",
          text: "Look at the button colour on the TV, then press and release the big button:",
        },
        { type: "list", items: rows },
        {
          type: "paragraph",
          text: "For yellow, red and white, release within 0.3 s of the target. A wrong release adds a strike.",
        },
      ],
    };
  }
  if (page === 3) {
    const rows: string[] = [];
    for (let index = 0; index < KEYPAD_ALPHABET.length; index += 1) {
      const letter = KEYPAD_ALPHABET[index];
      if (letter === undefined) continue;
      const digit = bomb.keypad.mapping[letter];
      if (digit === undefined) continue;
      rows.push(`${letter} = ${digit}`);
    }
    return {
      kind: "blocks",
      blocks: [
        { type: "heading", text: `MANUAL 4/${MANUAL_PAGE_COUNT} - KEYPAD` },
        {
          type: "paragraph",
          text: "The TV keypad shows four letters. Convert them to digits, left to right:",
        },
        { type: "list", items: rows },
        {
          type: "paragraph",
          text: "Type exactly four digits on the defuser phone and press Send.",
        },
      ],
    };
  }
  return {
    kind: "blocks",
    blocks: [
      { type: "heading", text: `MANUAL 1/${MANUAL_PAGE_COUNT} - START` },
      {
        type: "paragraph",
        text: "You are the manual reader. Keep this screen to yourself and read only the page the defuser asks for.",
      },
      {
        type: "list",
        items: [
          `Serial: ${bomb.serial}`,
          `Batteries: ${bomb.batteries}`,
          `Indicators: ${bomb.indicators.join(" / ")}`,
        ],
      },
      {
        type: "paragraph",
        text: "PREV and NEXT turn pages: 2 WIRES, 3 BUTTON, 4 KEYPAD.",
      },
    ],
  };
}

/** Generation contract check; a failed check is a game-breaking bug. */
export interface BombCheck {
  readonly ok: boolean;
  readonly errors: string[];
}

/**
 * Re-derives every solution from the public facts and confirms it is
 * reachable. Called by the 10,000-seed solvability test before any action.
 */
export function checkBombSolvable(bomb: Bomb): BombCheck {
  const errors: string[] = [];
  const serialPattern = /^[A-Z0-9]{4}\d$/;
  if (!serialPattern.test(bomb.serial)) {
    errors.push(`serial ${JSON.stringify(bomb.serial)} must end with a digit`);
  }
  if (!Number.isInteger(bomb.batteries) || bomb.batteries < 1 || bomb.batteries > 4) {
    errors.push("batteries must be an integer in 1..4");
  }
  if (bomb.indicators.length !== 2) {
    errors.push("two indicators are required");
  }

  if (bomb.wires.solved || bomb.button.solved || bomb.keypad.solved) {
    errors.push("a freshly generated bomb must start with every module unsolved");
  }

  if (
    bomb.wires.wires.length < BOMB_CONFIG.wiresMin ||
    bomb.wires.wires.length > BOMB_CONFIG.wiresMax
  ) {
    errors.push(
      `the wire list must contain ${BOMB_CONFIG.wiresMin}..${BOMB_CONFIG.wiresMax} wires`,
    );
  }
  const seenWires = new Set<WireColor>();
  for (let index = 0; index < bomb.wires.wires.length; index += 1) {
    const color = bomb.wires.wires[index];
    if (color === undefined || !WIRE_COLORS.includes(color)) {
      errors.push(`wire ${index} is not a known colour`);
      continue;
    }
    if (seenWires.has(color)) {
      errors.push(`wire colour ${color} appears twice`);
    }
    seenWires.add(color);
  }
  if (bomb.wires.evenColor === bomb.wires.oddColor) {
    errors.push("the even and odd parity colours must differ");
  }
  if (!seenWires.has(bomb.wires.evenColor)) {
    errors.push("the even parity colour must be present on the bomb");
  }
  if (!seenWires.has(bomb.wires.oddColor)) {
    errors.push("the odd parity colour must be present on the bomb");
  }
  if (!seenWires.has(wireSolution(bomb))) {
    errors.push("the wire solution is not present on the bomb");
  }

  if (!BUTTON_COLORS.includes(bomb.button.color)) {
    errors.push(`button colour ${String(bomb.button.color)} is not in the hold table`);
  } else {
    const target = buttonHoldTarget(bomb.button.color);
    if (!Number.isFinite(target) || target < 0) {
      errors.push("the button hold target must be a non-negative number");
    }
    if (!buttonHoldIsCorrect(bomb.button.color, target)) {
      errors.push("the button target does not satisfy its own rule");
    }
  }

  if (bomb.keypad.symbols.length !== KEYPAD_SYMBOLS_SHOWN) {
    errors.push(`the keypad must show exactly ${KEYPAD_SYMBOLS_SHOWN} letters`);
  }
  const seenSymbols = new Set<string>();
  for (let index = 0; index < bomb.keypad.symbols.length; index += 1) {
    const symbol = bomb.keypad.symbols[index];
    if (symbol === undefined || !KEYPAD_ALPHABET.includes(symbol)) {
      errors.push(`keypad symbol ${index} is not in the alphabet`);
      continue;
    }
    if (seenSymbols.has(symbol)) {
      errors.push(`keypad symbol ${symbol} appears twice`);
    }
    seenSymbols.add(symbol);
    if (!/^\d$/.test(bomb.keypad.mapping[symbol] ?? "")) {
      errors.push(`keypad symbol ${symbol} has no digit mapping`);
    }
  }
  for (let index = 0; index < KEYPAD_ALPHABET.length; index += 1) {
    const letter = KEYPAD_ALPHABET[index];
    if (letter === undefined) continue;
    if (!/^\d$/.test(bomb.keypad.mapping[letter] ?? "")) {
      errors.push(`the manual has no digit for keypad letter ${letter}`);
    }
  }
  if (!KEYPAD_ENTRY_PATTERN.test(keypadCode(bomb.keypad))) {
    errors.push("the derived keypad code must be exactly four digits");
  }

  return { ok: errors.length === 0, errors };
}
