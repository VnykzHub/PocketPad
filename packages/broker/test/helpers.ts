/**
 * Shared broker test fixtures: fake peers, a recording logger, an injected
 * clock and a seeded byte source. No production data or secrets here.
 */
import { expect } from "vitest";
import { parseJsonMessage, type JsonControlMessage } from "@lanpad/protocol";
import {
  RoomRegistry,
  type Logger,
  type Peer,
  type RegistryJoinRateLimiter,
} from "../src/index.js";

/** One structured log call captured by the test logger. */
export interface LogCall {
  event: string;
  fields: Record<string, string | number>;
}

/** In-memory `Peer` capturing every frame and close call. */
export class FakePeer implements Peer {
  readonly sent: (string | Uint8Array)[] = [];
  readonly closes: { code: number; reason: string }[] = [];
  readonly remoteAddress: string;
  bufferedAmount: number;

  constructor(options: { remoteAddress?: string; bufferedAmount?: number } = {}) {
    this.remoteAddress = options.remoteAddress ?? "127.0.0.1";
    this.bufferedAmount = options.bufferedAmount ?? 0;
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }

  /** JSON frames parsed back into the protocol union. */
  jsonMessages(): JsonControlMessage[] {
    return this.sent
      .filter((frame): frame is string => typeof frame === "string")
      .map((frame) => parseJsonMessage(frame));
  }

  /** Binary frames only (InputFwd/Pong), in send order. */
  binaryFrames(): Uint8Array[] {
    return this.sent.filter((frame): frame is Uint8Array => typeof frame !== "string");
  }
}

export interface TestLogger {
  logger: Logger;
  calls: LogCall[];
}

/** Logger that records structured events for SR-9 assertions. */
export function createTestLogger(): TestLogger {
  const calls: LogCall[] = [];
  const logger: Logger = {
    info(event, fields) {
      calls.push({ event, fields: { ...fields } });
    },
    debug(event, fields) {
      calls.push({ event, fields: { ...fields } });
    },
  };
  return { logger, calls };
}

export interface TestClock {
  now: () => number;
  advance(ms: number): void;
  set(ms: number): void;
}

export function createClock(start = 1_700_000_000_000): TestClock {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
    set(ms) {
      current = ms;
    },
  };
}

/**
 * Deterministic byte source (mulberry32). Producing the same stream on every
 * run keeps generated codes/PINs stable without touching `node:crypto`.
 */
export function seededRandomBytes(seed: number): (n: number) => Uint8Array {
  let state = seed >>> 0;
  const nextByte = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) & 0xff;
  };
  return (n) => Uint8Array.from({ length: n }, nextByte);
}

export interface RegistryHarness {
  registry: RoomRegistry;
  clock: TestClock;
  calls: LogCall[];
}

export interface RegistryOptions {
  seed?: number;
  maxBufferedBytes?: number;
  rateLimiter?: RegistryJoinRateLimiter;
}

export function makeRegistry(options: RegistryOptions = {}): RegistryHarness {
  const clock = createClock();
  const { logger, calls } = createTestLogger();
  const registry = new RoomRegistry({
    now: clock.now,
    randomBytes: seededRandomBytes(options.seed ?? 7),
    logger,
    ...(options.maxBufferedBytes === undefined
      ? {}
      : { maxBufferedBytes: options.maxBufferedBytes }),
    ...(options.rateLimiter === undefined ? {} : { rateLimiter: options.rateLimiter }),
  });
  return { registry, clock, calls };
}

/**
 * SR-9: no log field may be named like a credential, and no logged value may
 * carry a token or equal a PIN. The room code is public and is skipped.
 */
export function assertNoSecretsLogged(calls: LogCall[], secrets: readonly string[]): void {
  for (const call of calls) {
    for (const [key, value] of Object.entries(call.fields)) {
      expect(key, `${call.event} logged credential-shaped field ${key}`).not.toMatch(
        /token|pin|session/i,
      );
      if (key === "code") {
        continue;
      }
      const text = String(value);
      for (const secret of secrets) {
        if (secret.length >= 8) {
          expect(text, `${call.event}.${key} contains a token`).not.toContain(secret);
        } else {
          expect(text, `${call.event}.${key} equals a PIN`).not.toBe(secret);
        }
      }
    }
  }
}
