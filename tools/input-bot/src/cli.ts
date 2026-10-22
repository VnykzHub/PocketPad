/**
 * input-bot CLI (D0-TOOL-01, D4-TOOL-01).
 *
 * Usage:
 *   node tools/input-bot/dist/cli.js --server http://host:port --code ABCD \
 *     [--pin 1234] [--clients 2] [--macro path.json] [--duration 5s]
 *   node tools/input-bot/dist/cli.js --server ... --code ABCD --pin 1234 \
 *     --scenario steady [--jitter-ms 30] [--loss 0.05] [--reconnect-every 60s] ...
 *
 * Without `--scenario` the D0 behaviour is unchanged (one macro file, N bots);
 * the D4 network knobs still apply. With `--scenario` the scenario definition
 * from `scenarios.ts` supplies clients, duration and macros, and any flag
 * given overrides it.
 *
 * Exit codes: 0 every bot met its contract, 1 a bot failed (join error, lost
 * slot, missing expected `roomFull`…), 2 usage or macro error. Output never
 * contains the PIN, the room token or a session token (SR-9).
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  MAX_CONTROLLERS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_PIN_LENGTH,
} from "@lanpad/protocol";
import {
  Bot,
  BotConfigError,
  createBots,
  realScheduler,
  serverToWsUrl,
  wsTransport,
} from "./bot.js";
import type { BotOptions, Scheduler, BotTransport } from "./bot.js";
import { MacroError, parseMacros } from "./macros.js";
import type { MacroAction } from "./macros.js";
import {
  SCENARIO_NAMES,
  createScenarioBots,
  parseIntervalMs,
  parseJitterMs,
  parseLoss,
  parseScenarioName,
  resolveScenario,
  scenarioExitCode,
  summarizeScenario,
} from "./scenarios.js";
import type { ScenarioName, ScenarioOverrides } from "./scenarios.js";

export interface BotCliOptions {
  server: string;
  code: string;
  pin: string | undefined;
  /** Explicit `--clients`; undefined means the mode's default. */
  clients: number | undefined;
  macroPath: string | undefined;
  /** Explicit `--duration`; undefined means the mode's default. */
  durationMs: number | undefined;
  /** D4-TOOL-01: a named scenario from `scenarios.ts`. */
  scenario: ScenarioName | undefined;
  jitterMs: number | undefined;
  loss: number | undefined;
  reconnectEveryMs: number | undefined;
  suspendEveryMs: number | undefined;
  churnEveryMs: number | undefined;
  watchdogMs: number | undefined;
}

export interface BotCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface BotCliDeps {
  transport?: BotTransport;
  scheduler?: Scheduler;
}

/** D0 defaults used when no scenario is selected. */
export const DEFAULT_CLIENTS = 1;
export const DEFAULT_DURATION_MS = 5000;

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const USAGE = `Usage: input-bot --server <url> --code <ABCD> [options]

Options:
  --server <url>          Server origin, e.g. http://192.168.1.20:8080 (required)
  --code <code>           Room code (required)
  --pin <pin>             Room PIN, when the room requires one
  --clients <n>           Independent controller bots (default: 1, or the scenario's)
  --macro <file>          Macro JSON file (not with --scenario)
  --duration <time>       Run time, e.g. 5000, 5s, 10m (default: 5s, or the scenario's)
  --scenario <name>       ${SCENARIO_NAMES.join(" | ")}
  --jitter-ms <ms>        Delay each packet by a uniform 0..ms
  --loss <p>              Drop this fraction of level-only packets (0.05 or 5%)
  --reconnect-every <t>   Close and rejoin with the session token every t
  --suspend-every <t>     Send suspend, wait 1 s, rejoin every t
  --churn-every <t>       Leave and join fresh every t
  --watchdog-ms <ms>      Reconnect after ms without a server frame (0 = off)
  --help                  Show this help

Macro JSON is an array like:
  [{"atMs":0,"type":"press","buttons":["A"]},
   {"atMs":80,"type":"release","buttons":["A"]},
   {"atMs":200,"type":"axis","lx":32767,"ly":0}]`;

function readValue(
  argv: readonly string[],
  index: number,
  flag: string,
): { value: string; next: number } {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a value`);
  }
  return { value, next: index + 1 };
}

/** Parses `1500`, `500ms`, `5s` or `2m` into milliseconds. */
export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(text.trim());
  if (match === null) {
    throw new UsageError(`invalid --duration ${JSON.stringify(text)}; use e.g. 5s or 500ms`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const factor = unit === "m" ? 60_000 : unit === "s" ? 1000 : 1;
  const ms = amount * factor;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new UsageError("--duration must be greater than zero");
  }
  return ms;
}

/** Range is checked once the mode is known (`full-room` needs 9). */
function parseClients(text: string): number {
  const clients = Number(text);
  if (!Number.isInteger(clients) || clients < 1) {
    throw new UsageError("--clients must be a positive integer");
  }
  return clients;
}

function parseWatchdogMs(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms)?$/.exec(text.trim());
  const value = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isFinite(value) || value < 0) {
    throw new UsageError("--watchdog-ms must be a number of milliseconds >= 0");
  }
  return value;
}

function parseCode(text: string): string {
  const code = text.trim().toUpperCase();
  const allowed = new Set(ROOM_CODE_ALPHABET);
  if (code.length !== ROOM_CODE_LENGTH || [...code].some((char) => !allowed.has(char))) {
    throw new UsageError(
      `--code must be ${ROOM_CODE_LENGTH} characters from ${ROOM_CODE_ALPHABET}`,
    );
  }
  return code;
}

function parsePin(text: string): string {
  if (text.length !== ROOM_PIN_LENGTH || !/^\d+$/.test(text)) {
    throw new UsageError(`--pin must be ${ROOM_PIN_LENGTH} digits`);
  }
  return text;
}

export interface ParsedBotArgs {
  help: boolean;
  options: BotCliOptions | null;
}

/**
 * Parses argv without touching the network or filesystem. Throws a usage
 * error (or `BotConfigError` from the shared scenario parsers) on bad input.
 */
export function parseBotArgs(argv: readonly string[]): ParsedBotArgs {
  let server: string | null = null;
  let code: string | null = null;
  const options: Omit<BotCliOptions, "server" | "code"> = {
    pin: undefined,
    clients: undefined,
    macroPath: undefined,
    durationMs: undefined,
    scenario: undefined,
    jitterMs: undefined,
    loss: undefined,
    reconnectEveryMs: undefined,
    suspendEveryMs: undefined,
    churnEveryMs: undefined,
    watchdogMs: undefined,
  };
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = equals === -1 ? token : token.slice(0, equals);
    const inlineValue = equals === -1 ? null : token.slice(equals + 1);

    const take = (): string => {
      if (inlineValue !== null) return inlineValue;
      const { value, next } = readValue(argv, index, flag);
      index = next;
      return value;
    };

    switch (flag) {
      case "--help":
      case "-h":
        help = true;
        break;
      case "--server":
        server = take();
        break;
      case "--code":
        code = take();
        break;
      case "--pin":
        options.pin = parsePin(take());
        break;
      case "--clients":
        options.clients = parseClients(take());
        break;
      case "--macro":
        options.macroPath = take();
        break;
      case "--duration":
        options.durationMs = parseDuration(take());
        break;
      case "--scenario":
        options.scenario = parseScenarioName(take());
        break;
      case "--jitter-ms":
        options.jitterMs = parseJitterMs(take());
        break;
      case "--loss":
        options.loss = parseLoss(take());
        break;
      case "--reconnect-every":
        options.reconnectEveryMs = parseIntervalMs(take(), "--reconnect-every");
        break;
      case "--suspend-every":
        options.suspendEveryMs = parseIntervalMs(take(), "--suspend-every");
        break;
      case "--churn-every":
        options.churnEveryMs = parseIntervalMs(take(), "--churn-every");
        break;
      case "--watchdog-ms":
        options.watchdogMs = parseWatchdogMs(take());
        break;
      default:
        throw new UsageError(`unknown option "${token}"`);
    }
  }

  if (help) return { help: true, options: null };
  if (server === null) throw new UsageError("--server is required");
  if (code === null) throw new UsageError("--code is required");
  if (options.scenario !== undefined && options.macroPath !== undefined) {
    throw new UsageError("--macro cannot be combined with --scenario (scenarios own their macros)");
  }
  if (
    options.scenario === undefined &&
    options.clients !== undefined &&
    options.clients > MAX_CONTROLLERS
  ) {
    throw new UsageError(`--clients must be an integer in 1..${MAX_CONTROLLERS}`);
  }

  // Validate the origin up front so a typo fails before any socket opens.
  serverToWsUrl(server);

  return { help: false, options: { server, code: parseCode(code), ...options } };
}

/** Reads and validates a macro file; throws MacroError with the file path. */
export function loadMacros(path: string): MacroAction[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new MacroError(path, `cannot read macro file: ${String(error)}`);
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new MacroError(path, `invalid JSON: ${String(error)}`);
  }
  return parseMacros(document, path);
}

/**
 * Resolves after `durationMs` on the injected scheduler (so tests drive it
 * with a fake clock), or early on SIGINT.
 */
function wait(durationMs: number, scheduler: Scheduler): Promise<void> {
  return new Promise((resolve) => {
    let handle: unknown = null;
    function finish(): void {
      if (handle !== null) {
        if (scheduler.clearTimeout !== undefined) scheduler.clearTimeout(handle);
        else clearTimeout(handle as ReturnType<typeof setTimeout>);
      }
      process.off("SIGINT", finish);
      resolve();
    }
    handle =
      scheduler.setTimeout !== undefined
        ? scheduler.setTimeout(finish, durationMs)
        : setTimeout(finish, durationMs);
    process.once("SIGINT", finish);
  });
}

/** The D4 network knobs shared by both modes; absent flags stay absent. */
function networkOverrides(options: BotCliOptions): ScenarioOverrides {
  const overrides: ScenarioOverrides = {};
  if (options.jitterMs !== undefined) overrides.jitterMs = options.jitterMs;
  if (options.loss !== undefined) overrides.loss = options.loss;
  if (options.reconnectEveryMs !== undefined) overrides.reconnectEveryMs = options.reconnectEveryMs;
  if (options.suspendEveryMs !== undefined) overrides.suspendEveryMs = options.suspendEveryMs;
  if (options.churnEveryMs !== undefined) overrides.churnEveryMs = options.churnEveryMs;
  if (options.watchdogMs !== undefined) overrides.watchdogMs = options.watchdogMs;
  return overrides;
}

function startAll(bots: readonly Bot[]): void {
  for (const bot of bots) bot.start();
}

/** Runs the CLI. Returns the process exit code. */
export async function runBotCli(
  argv: readonly string[],
  deps: BotCliDeps = {},
  io: BotCliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<number> {
  let parsed: ParsedBotArgs;
  try {
    parsed = parseBotArgs(argv);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }

  const options = parsed.options;
  if (options === null) return 2;

  const scheduler = deps.scheduler ?? realScheduler;
  const transport = deps.transport ?? wsTransport;
  const credentials: Omit<BotOptions, "index"> = {
    server: options.server,
    code: options.code,
    ...(options.pin !== undefined ? { pin: options.pin } : {}),
    transport,
    scheduler,
  };

  // Everything that can reject the configuration runs before any socket opens.
  let bots: Bot[];
  let finish: () => { payload: unknown; exitCode: number };
  try {
    if (options.scenario !== undefined) {
      const overrides = networkOverrides(options);
      if (options.clients !== undefined) overrides.clients = options.clients;
      if (options.durationMs !== undefined) overrides.durationMs = options.durationMs;
      const config = resolveScenario(options.scenario, overrides);
      bots = createScenarioBots(config, credentials);
      finish = () => {
        const summary = summarizeScenario(config, bots);
        return { payload: summary, exitCode: scenarioExitCode(summary) };
      };
      startAll(bots);
      await wait(config.durationMs, scheduler);
    } else {
      const macros = options.macroPath !== undefined ? loadMacros(options.macroPath) : [];
      const clients = options.clients ?? DEFAULT_CLIENTS;
      const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
      bots = createBots({ ...credentials, ...networkOverrides(options), macros }, clients);
      finish = () => ({
        payload: {
          server: options.server,
          clients,
          durationMs,
          bots: bots.map((bot) => bot.summary()),
        },
        // `ok` also fails a bot that lost its slot or saw an unexpected error.
        exitCode: bots.every((bot) => bot.ok) ? 0 : 1,
      });
      startAll(bots);
      await wait(durationMs, scheduler);
    }
  } catch (error) {
    if (error instanceof BotConfigError || error instanceof MacroError) {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  for (const bot of bots) bot.stop();

  const { payload, exitCode } = finish();
  io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
  return exitCode;
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  void runBotCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
