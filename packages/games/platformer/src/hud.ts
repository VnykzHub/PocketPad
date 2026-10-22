/**
 * Coin Run HUD strings and results content (GAME-PF-05; PR-9.8, AR-4).
 *
 * Text is the only expensive part of a frame at TV distance, so every value
 * is cached and rebuilt only when the underlying number changes. The class
 * allocates its cache slots once; `coins`, `time`, `label` and `playerLine`
 * return the same string object until the value transitions.
 *
 * `buildResultsContent` runs only when the results phase opens (the renderer
 * caches it), so it may allocate its small content object there.
 */

/** Human-readable clock for the HUD, `mm:ss`; negative time clamps to zero. */
export function formatTime(elapsedMs: number): string {
  const safe = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  const mm = minutes < 10 ? `0${minutes}` : String(minutes);
  const ss = seconds < 10 ? `0${seconds}` : String(seconds);
  return `${mm}:${ss}`;
}

/** Display label for a 1-based slot. Cached by `HudCache`. */
export function slotLabel(slot: number): string {
  return `P${slot}`;
}

/** One cached HUD value with lazy invalidation. */
class CachedString {
  private value = Number.NaN;
  private cached = "";

  get(value: number, build: (value: number) => string): string {
    if (value !== this.value) {
      this.value = value;
      this.cached = build(value);
    }
    return this.cached;
  }

  invalidate(): void {
    this.value = Number.NaN;
    this.cached = "";
  }
}

/** Per-slot cache for labels and per-player coin counts. */
class CachedPair {
  private first = Number.NaN;
  private second = Number.NaN;
  private cached = "";

  get(first: number, second: number, build: (a: number, b: number) => string): string {
    if (first !== this.first || second !== this.second) {
      this.first = first;
      this.second = second;
      this.cached = build(first, second);
    }
    return this.cached;
  }

  invalidate(): void {
    this.first = Number.NaN;
    this.second = Number.NaN;
    this.cached = "";
  }
}

/** Cached HUD strings; one instance per game, reset on rematch. */
export class HudCache {
  private readonly coinsCache = new CachedPair();
  private readonly timeCache = new CachedString();
  private readonly labels: string[] = [];
  private readonly playerLines: CachedPair[] = [];

  constructor(maxSlots: number = 4) {
    const slots = Number.isInteger(maxSlots) && maxSlots > 0 ? maxSlots : 4;
    for (let index = 0; index < slots; index += 1) {
      this.labels.push(slotLabel(index + 1));
      this.playerLines.push(new CachedPair());
    }
  }

  /** `COINS n/20`; rebuilt only when either number changes. */
  coins(teamCoins: number, totalCoins: number): string {
    return this.coinsCache.get(teamCoins, totalCoins, (coins, total) => `COINS ${coins}/${total}`);
  }

  /** `TIME mm:ss`; rebuilt only when the displayed second changes. */
  time(elapsedMs: number): string {
    const displayed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? Math.floor(elapsedMs / 1000) : 0;
    return this.timeCache.get(displayed, (seconds) => `TIME ${formatTime(seconds * 1000)}`);
  }

  /** `P1`..`P4`; constant per slot and returned without rebuilding. */
  label(slot: number): string {
    const index = slot - 1;
    return this.labels[index] ?? slotLabel(slot);
  }

  /** `P1 3` for the per-player coin readout; cached per slot. */
  playerLine(slot: number, coins: number): string {
    const index = slot - 1;
    const cache = this.playerLines[index];
    if (cache === undefined) {
      return `${slotLabel(slot)} ${coins}`;
    }
    return cache.get(slot, coins, (slotNumber, count) => `${slotLabel(slotNumber)} ${count}`);
  }

  /** Drops every cached value; used when a level is rebuilt for a rematch. */
  invalidate(): void {
    this.coinsCache.invalidate();
    this.timeCache.invalidate();
    for (let index = 0; index < this.playerLines.length; index += 1) {
      this.playerLines[index]?.invalidate();
    }
  }
}

/** Results-screen content; strings are supplied to the host renderer. */
export interface ResultsContent {
  readonly title: string;
  readonly coinLine: string;
  readonly timeLine: string;
  /** One line per connected player, in slot order. */
  readonly playerLines: ReadonlyArray<string>;
  readonly rematchLine: string;
  readonly backLine: string;
}

/**
 * Builds the results content (GAME-PF-04; AR-4).
 *
 * `scores` is indexed by slot - 1. Only slots whose bit is in `connectedMask`
 * get a line, so a phone that left does not keep a ghost result row. The host
 * flow owns keyboard/remote navigation; the game supplies the strings and
 * accepts any A/B/X/Y press edge for the rematch.
 */
export function buildResultsContent(
  teamCoins: number,
  totalCoins: number,
  elapsedMs: number,
  scores: ReadonlyArray<number>,
  connectedMask: number,
): ResultsContent {
  const playerLines: string[] = [];
  for (let slot = 1; slot <= scores.length; slot += 1) {
    if ((connectedMask & (1 << slot)) === 0) continue;
    const count = scores[slot - 1] ?? 0;
    playerLines.push(`${slotLabel(slot)}  ${count}`);
  }
  return {
    title: "LEVEL COMPLETE",
    coinLine: `COINS ${teamCoins} / ${totalCoins}`,
    timeLine: `TIME ${formatTime(elapsedMs)}`,
    playerLines,
    rematchLine: "Press A to rematch",
    backLine: "Host: Back to start",
  };
}
