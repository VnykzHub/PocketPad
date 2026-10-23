# 24 — `@lanpad/game-kit`

**Status:** frozen contract for Wave 0. Stream F implements the package in Wave 1.
**Goal:** remove duplicated match lifecycle, scoring, player identity, pools, content packs and panel/event plumbing from every game. Games import the kit instead of copying a 500-line lifecycle.
**Non-goals:** a game engine, rendering, physics, networking, a UI framework, game-specific rules.

---

## 1. Package boundary

- Path `packages/game-kit/`, name `@lanpad/game-kit`, version `0.1.0`, private.
- Dependencies: `@lanpad/sdk` **only**. No runtime, controller, broker, engine or Babylon import.
- No DOM, `window`, `document`, `fetch` or timers. All time is passed in by the caller.
- Pure TypeScript, ESM, strict, zero runtime dependencies.
- Exports one entry point; tree-shakeable named exports.

## 2. Modules

### 2.1 Match lifecycle

Wraps the existing `RoundManager` flow in SDK-only code:

```ts
export type MatchPhase = "lobby" | "countdown" | "playing" | "results";

export interface MatchOptions {
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly countdownMs?: number;   // default 3000
  readonly roundsToWin?: number;   // default 3 (best of 5)
}

export interface Match {
  readonly phase: MatchPhase;
  readonly round: number;
  readonly countdownRemainingMs: number;
  readonly scores: ReadonlyMap<number, number>;
  readonly winnerSlot: number | null;
  /** Call once per fixed tick with the connected slots and host time. */
  update(nowMs: number, connectedSlots: readonly number[]): void;
  /** Starts when the roster is valid; false while still in lobby. */
  start(nowMs: number): boolean;
  /** Ends the current playing round; null is a draw. */
  finishRound(winnerSlot: number | null): void;
  /** Moves from results to the next countdown or lobby. */
  nextRound(nowMs: number): void;
  reset(): void;
}
```

Rules: only unique slots 1..8; a round can finish once; scores never go negative; `winnerSlot` is cleared on `reset`; no allocation in `update` (the caller's `connectedSlots` array is read only).

### 2.2 Scoreboard

```ts
export interface ScoreEntry { readonly slot: number; readonly score: number; }
export interface Scoreboard {
  set(slot: number, score: number): void;
  add(slot: number, delta: number): void;
  get(slot: number): number;
  /** Sorted by score desc, then slot asc; reuses the internal array. */
  readonly ranked: readonly ScoreEntry[];
  reset(): void;
}
```

### 2.3 Player identity

```ts
export function playerColor(slot: number): string;   // DESIGN tokens, 1..8
export function playerLabel(slot: number): string;   // "P1".."P8"
export function playerShape(slot: number): "circle" | "triangle" | "square" | "diamond";
```

State is never carried by colour alone: every UI use pairs colour with label and shape.

### 2.4 Content packs

```ts
export interface PackOptions<T> {
  readonly seed: number;
  readonly validate?: (value: unknown) => value is T;
}
export interface Pack<T> {
  readonly size: number;
  /** Draws without replacement; wraps when exhausted. Deterministic per seed. */
  draw(): T;
  drawUnique(count: number): T[];
  reset(): void;
}
export function createPack<T>(items: readonly T[], options: PackOptions<T>): Pack<T>;
```

Uses a mulberry32 seeded shuffle, never `Math.random`. `drawUnique` may allocate at pack creation only; the hot path reuses.

### 2.5 Pools

```ts
export interface Pool<T> {
  acquire(): T;
  release(item: T): void;
  readonly active: number;
  readonly capacity: number;
  forEachActive(fn: (item: T) => void): void;
  clear(): void;
}
export function createPool<T>(
  create: () => T,
  reset: (item: T) => void,
  capacity: number,
): Pool<T>;
```

Acquire after capacity throws `E_POOL_EXHAUSTED`; `release` of a foreign/double item is ignored and counted.

### 2.6 Panel, choice and text helpers

```ts
export interface ChoiceOption { readonly id: string; readonly label: string; }
export interface TextPrompt { readonly prompt: string; readonly maxLength: number; }

export function showChoice(ctx: GameContext, slot: number, options: readonly ChoiceOption[], prompt?: string): void;
export function showText(ctx: GameContext, slot: number, prompt: TextPrompt): void;
export function clearPanel(ctx: GameContext, slot: number): void;
export function onChoice(ctx: GameContext, handler: (slot: number, optionId: string) => void): () => void;
export function onText(ctx: GameContext, handler: (slot: number, text: string) => void): () => void;
export function onCanvas(ctx: GameContext, handler: (slot: number, data: JsonValue) => void): () => void;
```

Helpers validate payloads, ignore malformed events, and never throw into the game loop.

### 2.7 Countdown and results helpers

`countdownLabel(ms)` returns `"3"`, `"2"`, `"1"`, `"GO"`; `resultsRows(scores, winner)` returns a reused array of rows for the host HUD. Presentation-only.

## 3. Boundary and tests

- ESLint/import scan: `packages/game-kit/**` imports only `@lanpad/sdk` and its own modules.
- No file exceeds 300 lines without a documented reason.
- Unit tests cover every state transition, seeded determinism, pool exhaustion, malformed panel payloads and colour/shape mapping.
- A sample game (`packages/games/kit-sample/`, stream F) uses the kit only and stays under 200 lines.

## 4. Acceptance

| ID | Criterion |
|---|---|
| ER-24-01 | Match transitions lobby→countdown→playing→results→next are legal and illegal transitions throw |
| ER-24-02 | Scoreboard ordering, ties and reset are deterministic |
| ER-24-03 | Player colours match DESIGN tokens and always pair with label + shape |
| ER-24-04 | Pack draws are deterministic for a seed and wrap without replacement until reset |
| ER-24-05 | Pool acquire/release never allocates after warm-up; exhaustion throws the named error |
| ER-24-06 | Choice/text/canvas helpers ignore malformed payloads without throwing |
| ER-24-07 | The package imports only `@lanpad/sdk` (source scan) |
| ER-24-08 | The sample game is playable headlessly through the kit in under 200 lines |

## 5. File ownership

`packages/game-kit/**` — stream F. Wave 0 writes this spec only.
