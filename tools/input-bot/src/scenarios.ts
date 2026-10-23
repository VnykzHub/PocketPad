/**
 * Input-bot scenarios (D4-TOOL-01).
 *
 * Scenarios are data/config, not code paths: the same definitions are reused
 * by the D4 exit run, D7 soak tests and P5 load tests. Everything here is
 * pure except `loadMacroFile`, which reads the shared `macros/*.json` files.
 *
 * Credentials never appear in a scenario config, summary or failure message.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAX_CONTROLLERS } from "@lanpad/protocol";
import { Bot, BotConfigError } from "./bot.js";
import type { BotOptions, BotSummary, Scheduler, BotTransport } from "./bot.js";
import { parseMacros } from "./macros.js";
import type { MacroAction } from "./macros.js";

const MACRO_DIR = new URL("../macros/", import.meta.url);
const macroCache = new Map<string, MacroAction[]>();

/** Loads and validates `macros/<name>.json`; results are cached per name. */
export function loadMacroFile(name: string): MacroAction[] {
  const cached = macroCache.get(name);
  if (cached !== undefined) return cached;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new BotConfigError(`invalid macro name ${JSON.stringify(name)}`);
  }
  const path = fileURLToPath(new URL(`${name}.json`, MACRO_DIR));
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new BotConfigError(`cannot read scenario macro ${name}: ${String(error)}`);
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new BotConfigError(`invalid JSON in scenario macro ${name}: ${String(error)}`);
  }
  const actions = parseMacros(document, `macros/${name}.json`);
  macroCache.set(name, actions);
  return actions;
}

export const SCENARIO_NAMES = [
  "steady",
  "taps",
  "sticks",
  "churn",
  "full-room",
  "four-players",
  "eight-players",
] as const;

export type ScenarioName = (typeof SCENARIO_NAMES)[number];

const SCENARIO_NAME_SET: ReadonlySet<string> = new Set(SCENARIO_NAMES);

export function isScenarioName(value: string): value is ScenarioName {
  return SCENARIO_NAME_SET.has(value);
}

/** Case-insensitive scenario name parsing for CLI flags. */
export function parseScenarioName(text: string): ScenarioName {
  const name = text.trim().toLowerCase();
  if (!isScenarioName(name)) {
    throw new BotConfigError(
      `unknown scenario ${JSON.stringify(text)}; expected one of ${SCENARIO_NAMES.join(", ")}`,
    );
  }
  return name;
}

/** `1500`, `500ms`, `5s`, `2m` -> milliseconds; must be > 0. */
export function parseIntervalMs(text: string, flag = "interval"): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(text.trim());
  if (match === null) {
    throw new BotConfigError(`invalid ${flag} ${JSON.stringify(text)}; use e.g. 60s or 500ms`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const factor = unit === "m" ? 60_000 : unit === "s" ? 1000 : 1;
  const ms = amount * factor;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new BotConfigError(`${flag} must be greater than zero`);
  }
  return ms;
}

/** `0`, `30`, `30ms` -> a non-negative jitter in milliseconds. */
export function parseJitterMs(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms)?$/.exec(text.trim());
  if (match === null) {
    throw new BotConfigError(
      `invalid --jitter-ms ${JSON.stringify(text)}; use a non-negative number of milliseconds`,
    );
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) {
    throw new BotConfigError("--jitter-ms must be a finite number >= 0");
  }
  return value;
}

/** A probability in 0..1 for `--loss`. `5%` is accepted as 0.05. */
export function parseLoss(text: string): number {
  const trimmed = text.trim();
  const percent = trimmed.endsWith("%");
  const value = Number(percent ? trimmed.slice(0, -1) : trimmed);
  if (!Number.isFinite(value) || value < 0) {
    throw new BotConfigError("--loss must be a finite number >= 0 (0.05 or 5%)");
  }
  const fraction = percent ? value / 100 : value;
  if (fraction > 1) {
    throw new BotConfigError("--loss must be at most 1 (or 100%)");
  }
  return fraction;
}

interface ScenarioDefinition {
  clients: number;
  durationMs: number;
  macroFiles: readonly string[];
  macroLoopMs: number | null;
  jitterMs: number;
  loss: number;
  reconnectEveryMs: number | null;
  suspendEveryMs: number | null;
  churnEveryMs: number | null;
  watchdogMs: number;
  /** The last client is expected to be rejected with `roomFull`. */
  expectRoomFull: boolean;
}

const SCENARIOS: Record<ScenarioName, ScenarioDefinition> = {
  steady: {
    clients: MAX_CONTROLLERS,
    durationMs: 600_000,
    macroFiles: ["move"],
    macroLoopMs: 4000,
    jitterMs: 0,
    loss: 0,
    reconnectEveryMs: null,
    suspendEveryMs: null,
    churnEveryMs: null,
    watchdogMs: 0,
    expectRoomFull: false,
  },
  taps: {
    clients: 1,
    durationMs: 10_000,
    macroFiles: ["tap"],
    macroLoopMs: 1000,
    jitterMs: 0,
    loss: 0,
    reconnectEveryMs: null,
    suspendEveryMs: null,
    churnEveryMs: null,
    watchdogMs: 0,
    expectRoomFull: false,
  },
  sticks: {
    clients: 1,
    durationMs: 10_000,
    macroFiles: ["move"],
    macroLoopMs: 4000,
    jitterMs: 0,
    loss: 0,
    reconnectEveryMs: null,
    suspendEveryMs: null,
    churnEveryMs: null,
    watchdogMs: 0,
    expectRoomFull: false,
  },
  churn: {
    clients: MAX_CONTROLLERS,
    durationMs: 60_000,
    macroFiles: ["tap"],
    macroLoopMs: 1000,
    jitterMs: 0,
    loss: 0,
    reconnectEveryMs: null,
    suspendEveryMs: null,
    churnEveryMs: 15_000,
    watchdogMs: 0,
    expectRoomFull: false,
  },
  "full-room": {
    clients: MAX_CONTROLLERS + 1,
    durationMs: 10_000,
    macroFiles: ["tap"],
    macroLoopMs: 1000,
    jitterMs: 0,
    loss: 0,
    reconnectEveryMs: null,
    suspendEveryMs: null,
    churnEveryMs: null,
    watchdogMs: 0,
    expectRoomFull: true,
  },
  // Game e2e scenarios: every bot moves and presses every face button, so a
  // game test can assert 4 or 8 distinct slots all producing input.
  "four-players": {
    clients: 4,
    durationMs: 10_000,
    macroFiles: ["move", "tap"],
    macroLoopMs: 4000,
    jitterMs: 0,
    loss: 0,
    reconnectEveryMs: null,
    suspendEveryMs: null,
    churnEveryMs: null,
    watchdogMs: 0,
    expectRoomFull: false,
  },
  "eight-players": {
    clients: MAX_CONTROLLERS,
    durationMs: 10_000,
    macroFiles: ["move", "tap"],
    macroLoopMs: 4000,
    jitterMs: 0,
    loss: 0,
    reconnectEveryMs: null,
    suspendEveryMs: null,
    churnEveryMs: null,
    watchdogMs: 0,
    expectRoomFull: false,
  },
};

/** CLI-level overrides applied on top of a scenario's defaults. */
export interface ScenarioOverrides {
  clients?: number;
  durationMs?: number;
  jitterMs?: number;
  loss?: number;
  macroLoopMs?: number | null;
  reconnectEveryMs?: number | null;
  suspendEveryMs?: number | null;
  churnEveryMs?: number | null;
  watchdogMs?: number;
}

export interface ScenarioConfig {
  name: ScenarioName;
  clients: number;
  durationMs: number;
  jitterMs: number;
  loss: number;
  macroFiles: readonly string[];
  macros: MacroAction[];
  macroLoopMs: number | null;
  reconnectEveryMs: number | null;
  suspendEveryMs: number | null;
  churnEveryMs: number | null;
  watchdogMs: number;
  expectRoomFull: boolean;
}

function optionalInterval(
  value: number | null | undefined,
  fallback: number | null,
  flag: string,
): number | null {
  const resolved = value === undefined ? fallback : value;
  if (resolved === null) return null;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new BotConfigError(`${flag} must be a finite number > 0`);
  }
  return resolved;
}

function requireClients(clients: number, definition: ScenarioDefinition): number {
  if (definition.expectRoomFull) {
    if (clients !== MAX_CONTROLLERS + 1) {
      throw new BotConfigError(
        `full-room requires ${MAX_CONTROLLERS + 1} clients (${MAX_CONTROLLERS} joined + 1 rejected)`,
      );
    }
    return clients;
  }
  if (!Number.isInteger(clients) || clients < 1 || clients > MAX_CONTROLLERS) {
    throw new BotConfigError(`clients must be an integer in 1..${MAX_CONTROLLERS}`);
  }
  return clients;
}

/**
 * Resolves a scenario name plus CLI overrides into a concrete config.
 * Macro JSON is loaded and validated here, so a broken macro fails before any
 * socket opens.
 */
export function resolveScenario(
  name: ScenarioName,
  overrides: ScenarioOverrides = {},
): ScenarioConfig {
  const definition = SCENARIOS[name];
  const clients = requireClients(overrides.clients ?? definition.clients, definition);

  const durationMs = overrides.durationMs ?? definition.durationMs;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new BotConfigError("durationMs must be a finite number > 0");
  }

  const jitterMs = overrides.jitterMs ?? definition.jitterMs;
  if (!Number.isFinite(jitterMs) || jitterMs < 0) {
    throw new BotConfigError("jitterMs must be a finite number >= 0");
  }

  const loss = overrides.loss ?? definition.loss;
  if (!Number.isFinite(loss) || loss < 0 || loss > 1) {
    throw new BotConfigError("loss must be a finite number in 0..1");
  }

  const watchdogMs = overrides.watchdogMs ?? definition.watchdogMs;
  if (!Number.isFinite(watchdogMs) || watchdogMs < 0) {
    throw new BotConfigError("watchdogMs must be a finite number >= 0");
  }

  return {
    name,
    clients,
    durationMs,
    jitterMs,
    loss,
    macroFiles: definition.macroFiles,
    // Bot.applyDueMacros breaks on the first future action, so actions merged
    // from several macro files must be in time order (stable sort keeps
    // same-tick composition intact).
    macros: definition.macroFiles
      .flatMap((file) => loadMacroFile(file))
      .sort((a, b) => a.atMs - b.atMs),
    macroLoopMs: optionalInterval(
      overrides.macroLoopMs,
      definition.macroLoopMs,
      "macroLoopMs",
    ),
    reconnectEveryMs: optionalInterval(
      overrides.reconnectEveryMs,
      definition.reconnectEveryMs,
      "reconnectEveryMs",
    ),
    suspendEveryMs: optionalInterval(
      overrides.suspendEveryMs,
      definition.suspendEveryMs,
      "suspendEveryMs",
    ),
    churnEveryMs: optionalInterval(
      overrides.churnEveryMs,
      definition.churnEveryMs,
      "churnEveryMs",
    ),
    watchdogMs,
    expectRoomFull: definition.expectRoomFull,
  };
}

/** Bot options for every client in the scenario; the scenario owns D4 knobs. */
export function scenarioBotOptions(
  config: ScenarioConfig,
  base: Omit<BotOptions, "index">,
): BotOptions[] {
  return Array.from({ length: config.clients }, (_, index) => {
    const expectRoomFull = config.expectRoomFull && index === config.clients - 1;
    return {
      ...base,
      index,
      macros: config.macros,
      macroLoopMs: config.macroLoopMs,
      jitterMs: config.jitterMs,
      loss: config.loss,
      reconnectEveryMs: config.reconnectEveryMs,
      suspendEveryMs: config.suspendEveryMs,
      churnEveryMs: config.churnEveryMs,
      watchdogMs: config.watchdogMs,
      ...(expectRoomFull ? { expectJoinError: "roomFull" as const } : {}),
    };
  });
}

/**
 * Creates every bot for a scenario. `full-room` needs 9 clients, which is one
 * more than `createBots` allows, so bots are constructed directly here.
 */
export function createScenarioBots(
  config: ScenarioConfig,
  base: Omit<BotOptions, "index">,
): Bot[] {
  return scenarioBotOptions(config, base).map((options) => new Bot(options));
}

export interface ScenarioSummary {
  scenario: ScenarioName;
  clients: number;
  durationMs: number;
  jitterMs: number;
  loss: number;
  ok: boolean;
  failures: string[];
  bots: BotSummary[];
}

function describeFailure(bot: Bot): string | null {
  if (bot.failureDetails.length > 0) return bot.failureDetails.join("; ");
  if (!bot.joined) return "never joined";
  if (bot.expectedError !== null && !bot.expectedErrorSeen) {
    return `expected joinError ${bot.expectedError} was not received`;
  }
  return "not ok";
}

/** Machine-readable summary; exit non-zero when a bot missed its contract. */
export function summarizeScenario(config: ScenarioConfig, bots: readonly Bot[]): ScenarioSummary {
  const failures: string[] = [];
  for (const bot of bots) {
    if (bot.ok) continue;
    failures.push(`bot ${bot.index}: ${describeFailure(bot) ?? "not ok"}`);
  }
  return {
    scenario: config.name,
    clients: config.clients,
    durationMs: config.durationMs,
    jitterMs: config.jitterMs,
    loss: config.loss,
    ok: failures.length === 0,
    failures,
    bots: bots.map((bot) => bot.summary()),
  };
}

/** 0 when the scenario met its contract, 1 otherwise. */
export function scenarioExitCode(summary: ScenarioSummary): number {
  return summary.ok ? 0 : 1;
}

/**
 * Transport and scheduler injection point for tests and the CLI. Typed here so
 * callers do not need to import Bot's option types separately.
 */
export interface ScenarioRunDeps {
  transport?: BotTransport;
  scheduler?: Scheduler;
}
