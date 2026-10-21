/**
 * input-bot CLI (D0-TOOL-01).
 *
 * Usage:
 *   node tools/input-bot/dist/cli.js --server http://host:port --code ABCD \
 *     [--pin 1234] [--clients 2] [--macro path.json] [--duration 5s]
 *
 * Exit codes: 0 bots ran, 1 a bot failed to join/connect, 2 usage or macro
 * error. Normal output never contains the PIN or any token.
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

export interface BotCliOptions {
  server: string;
  code: string;
  pin: string | undefined;
  clients: number;
  macroPath: string | undefined;
  durationMs: number;
}

export interface BotCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface BotCliDeps {
  transport?: BotTransport;
  scheduler?: Scheduler;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const USAGE = `Usage: input-bot --server <url> --code <ABCD> [options]

Options:
  --server <url>      Server origin, e.g. http://192.168.1.20:8080 (required)
  --code <code>       Room code (required)
  --pin <pin>         Room PIN, when the room requires one
  --clients <n>       Independent controller bots, 1..${MAX_CONTROLLERS} (default: 1)
  --macro <file>      Macro JSON file
  --duration <time>   Run time, e.g. 5000, 5s, 500ms (default: 5000)
  --help              Show this help

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

function parseClients(text: string): number {
  const clients = Number(text);
  if (!Number.isInteger(clients) || clients < 1 || clients > MAX_CONTROLLERS) {
    throw new UsageError(`--clients must be an integer in 1..${MAX_CONTROLLERS}`);
  }
  return clients;
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

/** Parses argv without touching the network or filesystem. */
export function parseBotArgs(argv: readonly string[]): ParsedBotArgs {
  let server: string | null = null;
  let code: string | null = null;
  let pin: string | undefined;
  let clients = 1;
  let macroPath: string | undefined;
  let durationMs = 5000;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = equals === -1 ? token : token.slice(0, equals);
    const inlineValue = equals === -1 ? null : token.slice(equals + 1);

    const take = (): { value: string; next: number } =>
      inlineValue === null ? readValue(argv, index, flag) : { value: inlineValue, next: index };

    switch (flag) {
      case "--help":
      case "-h":
        help = true;
        break;
      case "--server": {
        const { value, next } = take();
        server = value;
        index = next;
        break;
      }
      case "--code": {
        const { value, next } = take();
        code = value;
        index = next;
        break;
      }
      case "--pin": {
        const { value, next } = take();
        pin = parsePin(value);
        index = next;
        break;
      }
      case "--clients": {
        const { value, next } = take();
        clients = parseClients(value);
        index = next;
        break;
      }
      case "--macro": {
        const { value, next } = take();
        macroPath = value;
        index = next;
        break;
      }
      case "--duration": {
        const { value, next } = take();
        durationMs = parseDuration(value);
        index = next;
        break;
      }
      default:
        throw new UsageError(`unknown option "${token}"`);
    }
  }

  if (help) return { help: true, options: null };
  if (server === null) throw new UsageError("--server is required");
  if (code === null) throw new UsageError("--code is required");

  // Validate the origin up front so a typo fails before any socket opens.
  serverToWsUrl(server);

  return {
    help: false,
    options: { server, code: parseCode(code), pin, clients, macroPath, durationMs },
  };
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

/** Resolves after `durationMs`, or early on SIGINT. */
function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, durationMs);
    function finish(): void {
      clearTimeout(timer);
      process.off("SIGINT", finish);
      resolve();
    }
    process.once("SIGINT", finish);
  });
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

  let macros: MacroAction[] = [];
  try {
    if (options.macroPath !== undefined) macros = loadMacros(options.macroPath);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const scheduler = deps.scheduler ?? realScheduler;
  const transport = deps.transport ?? wsTransport;
  const base: BotOptions = {
    server: options.server,
    code: options.code,
    ...(options.pin !== undefined ? { pin: options.pin } : {}),
    macros,
    transport,
    scheduler,
  };

  let bots: Bot[];
  try {
    bots = createBots(base, options.clients);
  } catch (error) {
    if (error instanceof BotConfigError) {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  for (const bot of bots) {
    try {
      bot.start();
    } catch (error) {
      if (error instanceof BotConfigError) {
        io.stderr(`${error.message}\n`);
        return 2;
      }
      throw error;
    }
  }

  await wait(options.durationMs);

  for (const bot of bots) bot.stop();

  const summaries = bots.map((bot) => bot.summary());
  const payload = {
    server: options.server,
    clients: options.clients,
    durationMs: options.durationMs,
    bots: summaries,
  };
  io.stdout(`${JSON.stringify(payload, null, 2)}\n`);

  const failed = bots.some((bot) => bot.joinError !== null || !bot.joined);
  return failed ? 1 : 0;
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  void runBotCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
