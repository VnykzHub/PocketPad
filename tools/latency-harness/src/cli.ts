#!/usr/bin/env node
/**
 * `lanpad-latency` CLI (D3-TOOL-01).
 *
 *   lanpad-latency live --server http://127.0.0.1:8080 [--taps 100] [--interval 100] [--out run.json]
 *   lanpad-latency analyze <log.json> [more.json ...]
 *
 * Output goes to stdout and, with `--out`, to a local file only. Nothing is
 * uploaded. Room code, PIN and host token are never printed (SR-7, SR-9).
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { analyzeSamples, formatReportTable, parseLatencyLog, type LatencySample } from "./analyze.js";
import { runLiveLatency, type LiveLatencyOptions, type LiveLatencyResult } from "./live.js";

export interface LatencyCliIo {
  out(line: string): void;
  err(line: string): void;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  runLive(options: LiveLatencyOptions): Promise<LiveLatencyResult>;
}

const USAGE = [
  "usage:",
  "  lanpad-latency live --server <http://host:port> [--taps N] [--interval MS] [--out FILE]",
  "  lanpad-latency analyze <log.json> [more.json ...]",
].join("\n");

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positiveNumber(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

/** Returns the process exit code. */
export async function runLatencyCli(argv: readonly string[], io: LatencyCliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "analyze") {
      const files = rest.filter((arg) => !arg.startsWith("--"));
      if (files.length === 0) throw new Error("analyze needs at least one log file");
      const samples: LatencySample[] = [];
      for (const file of files) samples.push(...parseLatencyLog(await io.readText(file)));
      const report = analyzeSamples(samples);
      io.out(formatReportTable(report));
      io.out(JSON.stringify(report, null, 2));
      return 0;
    }
    if (command === "live") {
      const server = flag(rest, "--server");
      if (server === undefined) throw new Error("live needs --server");
      const result = await io.runLive({
        server,
        taps: positiveNumber(flag(rest, "--taps"), "--taps", 100),
        intervalMs: positiveNumber(flag(rest, "--interval"), "--interval", 100),
        log: (line) => io.err(line),
      });
      io.out(formatReportTable(result.report));
      const json = JSON.stringify(result, null, 2);
      const outPath = flag(rest, "--out");
      if (outPath !== undefined) {
        await io.writeText(outPath, `${json}\n`);
        io.err(`latency: wrote ${outPath}`);
      } else {
        io.out(json);
      }
      return result.samples.length > 0 ? 0 : 1;
    }
    io.err(USAGE);
    return 2;
  } catch (error) {
    io.err(`latency: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const nodeIo: LatencyCliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  readText: (path) => readFile(path, "utf8"),
  writeText: (path, text) => writeFile(path, text, "utf8"),
  runLive: runLiveLatency,
};

function normalizeEntryPath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  normalizeEntryPath(entry) === normalizeEntryPath(fileURLToPath(import.meta.url))
) {
  runLatencyCli(process.argv.slice(2), nodeIo).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
