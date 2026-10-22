/** @lanpad/input-bot — synthetic controller for local verification (D0-TOOL-01, D4-TOOL-01). */
export * from "./macros.js";
export * from "./bot.js";
export * from "./scenarios.js";
export type { BotCliDeps, BotCliIo, BotCliOptions, ParsedBotArgs } from "./cli.js";
export {
  DEFAULT_CLIENTS,
  DEFAULT_DURATION_MS,
  loadMacros,
  parseBotArgs,
  parseDuration,
  runBotCli,
} from "./cli.js";
