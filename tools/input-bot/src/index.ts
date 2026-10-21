/** @lanpad/input-bot — synthetic controller for local verification (D0-TOOL-01). */
export * from "./macros.js";
export * from "./bot.js";
export type { BotCliDeps, BotCliIo, BotCliOptions, ParsedBotArgs } from "./cli.js";
export { loadMacros, parseBotArgs, parseDuration, runBotCli } from "./cli.js";
