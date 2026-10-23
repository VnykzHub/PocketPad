// @vitest-environment jsdom
// @req ER-23-01, ER-22-01, ER-22-10, FR-9.11
/**
 * Host-integration proof for specs 22/23 (stream G).
 *
 * Runs the real `createStage` against the real `loadGame`, `GameAssetLibrary`,
 * `GameHost` and `StartScreen`, with three injected edges only:
 *
 * - `fetch` reads the committed stream-B fixture game (real GLB/OGG bytes)
 *   or a small in-memory variant for failure cases;
 * - `AudioBus` gets a fake `AudioContext`, so "a registered sound played"
 *   is observable without hardware;
 * - `createRenderer` returns a fake renderer/world, so no GPU is needed.
 *
 * The GLB -> AssetContainer path itself is exercised by stream A's browser
 * evidence and the renderer adapter suite; here we prove the stage passes the
 * eager mesh declarations to the world factory and threads the resulting
 * `ctx.world` into the fixed loop.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { Game, GameContext, GameWorld3D } from "@lanpad/sdk";
import { AudioBus } from "../../src/audio/AudioBus.js";
import { createDebugCounters } from "../../src/game/GameContext.js";
import { EventRouter } from "../../src/game/EventRouter.js";
import { LayoutApi } from "../../src/game/LayoutApi.js";
import { InputMapper } from "../../src/input/InputMapper.js";
import type { HostClient } from "../../src/net/hostClient.js";
import type { Renderer3D } from "../../src/render/Renderer.js";
import {
  createStage,
  type GameRendererChoice,
  type HostStage,
  type StageDeps,
} from "../../src/host/stage.js";
import type { HostChrome } from "../../src/host/chrome.js";
import type { HostNotices } from "../../src/host/notices.js";
import type { HostOverlay } from "../../src/host/overlay.js";
import type { HostRoster } from "../../src/host/roster.js";

const VIRTUAL_ORIGIN = "https://virtual.test";
const FIXTURE_BASE_URL = "https://fixture.test/games/fixture/";
const FIXTURE_MANIFEST_URL = `${FIXTURE_BASE_URL}game.manifest.json`;

/**
 * The stream-B fixture helper derives its directory from `import.meta.url`,
 * which jsdom reports as an http URL; read from the repo root instead.
 */
function fixtureGameDir(): string {
  const candidates = [
    join(process.cwd(), "packages/runtime/test/assets/fixtures/fixture-game"),
    join(process.cwd(), "test/assets/fixtures/fixture-game"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "game.manifest.json"))) return candidate;
  }
  throw new Error(`fixture game not found from ${process.cwd()}`);
}

const FIXTURE_GAME_DIR = fixtureGameDir();
const LAYOUT_JSON = readFileSync(join(FIXTURE_GAME_DIR, "layout.json"), "utf8");

/** Resolves a fixture URL to bytes, or null when the URL is not in the game. */
function fixtureFileForUrl(url: string): Uint8Array | null {
  if (!url.startsWith(FIXTURE_BASE_URL)) return null;
  const path = join(FIXTURE_GAME_DIR, url.slice(FIXTURE_BASE_URL.length));
  if (!existsSync(path)) return null;
  return new Uint8Array(readFileSync(path));
}

interface VirtualFile {
  readonly body: string | Uint8Array;
}

/** URL -> bytes for virtual games; fixture URLs fall through to disk. */
const served = new Map<string, VirtualFile>();
const requests: string[] = [];
let importCalls = 0;

function virtualBase(slug: string): string {
  return `${VIRTUAL_ORIGIN}/games/${slug}/`;
}

function serveVirtual(
  slug: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): string {
  const base = virtualBase(slug);
  for (const [name, body] of Object.entries(files)) {
    served.set(`${base}${name}`, { body });
  }
  return `${base}game.manifest.json`;
}

function gameManifest(
  slug: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    name: slug,
    description: "integration fixture",
    entry: "game.js",
    layouts: ["layout.json"],
    assetBudget: { initialBytes: 65536, totalBytes: 131072 },
    minPlayers: 1,
    maxPlayers: 2,
    needsGyro: false,
    ...overrides,
  });
}

const LEDGER_HEADER = "file,source,author,licence,date,attribution\n";

interface TestResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

function makeResponse(
  body: string | Uint8Array | null,
  status = 200,
): TestResponse {
  const ok = status >= 200 && status < 300;
  if (body === null) {
    return {
      ok,
      status,
      headers: { get: () => null },
      body: null,
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => "",
      json: async () => {
        throw new Error("no body");
      },
    };
  }
  const bytes =
    typeof body === "string" ? new TextEncoder().encode(body) : body;
  const text = new TextDecoder().decode(bytes);
  return {
    ok,
    status,
    headers: {
      get: (name) =>
        name.toLowerCase() === "content-length"
          ? String(bytes.byteLength)
          : null,
    },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    arrayBuffer: async () => bytes.slice().buffer,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<TestResponse> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : String((input as { url?: unknown }).url ?? input);
      requests.push(url);
      const virtual = served.get(url);
      if (virtual !== undefined) return makeResponse(virtual.body);
      if (url.startsWith("https://fixture.test/")) {
        const bytes = fixtureFileForUrl(url);
        return bytes === null ? makeResponse(null, 404) : makeResponse(bytes);
      }
      return makeResponse(null, 404);
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  document.body.replaceChildren();
  served.clear();
  requests.length = 0;
  importCalls = 0;
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeFrames {
  readonly pending: number;
  step(ms: number): void;
}

class ManualFrames implements FakeFrames {
  private nowMs = 0;
  private nextId = 1;
  private readonly callbacks = new Map<number, (time: number) => void>();

  readonly now = (): number => this.nowMs;

  readonly raf = (callback: (time: number) => void): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.callbacks.set(id, callback);
    return id;
  };

  readonly cancel = (id: number): void => {
    this.callbacks.delete(id);
  };

  get pending(): number {
    return this.callbacks.size;
  }

  step(ms: number): void {
    this.nowMs += ms;
    const due = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of due) callback(this.nowMs);
  }
}

interface FakeRenderer extends Renderer3D {
  readonly disposeCalls: number;
}

function createFakeRenderer(): FakeRenderer {
  let disposeCalls = 0;
  const renderer = {
    backend: "canvas2d" as const,
    get drawCalls(): number {
      return 0;
    },
    get textureMemoryMB(): number {
      return 0;
    },
    async init(): Promise<{ maxTextureSize: number; compressedFormats: string[] }> {
      return { maxTextureSize: 0, compressedFormats: [] };
    },
    resize(): void {},
    beginFrame(): void {},
    endFrame(): void {},
    setCamera(): void {},
    drawCube(): void {},
    dispose(): void {
      disposeCalls += 1;
    },
    get disposeCalls(): number {
      return disposeCalls;
    },
  };
  return renderer as unknown as FakeRenderer;
}

interface FakeWorld extends GameWorld3D {
  readonly updates: number[];
  readonly disposedCount: number;
}

function createFakeWorld(order: string[]): FakeWorld {
  const updates: number[] = [];
  let disposedCount = 0;
  const world = {
    get updates(): number[] {
      return updates;
    },
    get disposedCount(): number {
      return disposedCount;
    },
    update(dt: number): void {
      updates.push(dt);
      order.push("world");
    },
    dispose(): void {
      disposedCount += 1;
    },
  };
  return world as unknown as FakeWorld;
}

interface FakeAudio {
  readonly audio: AudioBus;
  readonly started: unknown[];
}

/** Minimal Web Audio surface AudioBus uses; records source `start()` calls. */
function createFakeAudio(): FakeAudio {
  const started: unknown[] = [];
  const makeGain = () => ({
    gain: {
      value: 0,
      setValueAtTime(): void {},
      linearRampToValueAtTime(): void {},
      cancelScheduledValues(): void {},
    },
    connect(): void {},
    disconnect(): void {},
  });
  const context = {
    state: "running",
    currentTime: 0,
    baseLatency: 0,
    destination: {},
    createGain: makeGain,
    createBufferSource() {
      let buffer: unknown = null;
      return {
        get buffer(): unknown {
          return buffer;
        },
        set buffer(value: unknown) {
          buffer = value;
        },
        loop: false,
        playbackRate: { setValueAtTime(): void {} },
        connect(): void {},
        start(): void {
          started.push(buffer);
        },
        stop(): void {},
      };
    },
    async decodeAudioData(): Promise<unknown> {
      return { duration: 0.25 };
    },
    async resume(): Promise<void> {},
    async suspend(): Promise<void> {},
    async close(): Promise<void> {},
  };
  const audio = new AudioBus({
    createContext: () => context as unknown as AudioContext,
  });
  return { audio, started };
}

interface RecordedGame extends Game {
  readonly initCalls: number;
  readonly simulateCalls: number;
  readonly disposeCalls: number;
  context(): GameContext | null;
}

function createRecordedGame(
  order: string[],
  manifest: Game["manifest"],
): RecordedGame {
  let captured: GameContext | null = null;
  let initCalls = 0;
  let simulateCalls = 0;
  let disposeCalls = 0;
  const game = {
    manifest,
    get initCalls(): number {
      return initCalls;
    },
    get simulateCalls(): number {
      return simulateCalls;
    },
    get disposeCalls(): number {
      return disposeCalls;
    },
    context(): GameContext | null {
      return captured;
    },
    init(ctx: GameContext): void {
      initCalls += 1;
      captured = ctx;
    },
    simulate(): void {
      simulateCalls += 1;
      order.push("simulate");
    },
    render(): void {
      order.push("render");
    },
    dispose(): void {
      disposeCalls += 1;
    },
  };
  return game as unknown as RecordedGame;
}

// ---------------------------------------------------------------------------
// Stage harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly stage: HostStage;
  readonly audio: AudioBus;
  readonly startedAudio: unknown[];
  readonly renderer: FakeRenderer;
  readonly frames: ManualFrames;
  readonly notices: Array<{ title: string; message: string }>;
  readonly worldFactoryInputs: unknown[];
  readonly order: string[];
  getGame(): RecordedGame | null;
}

function createHarness(slug: string, manifestUrl: string): Harness {
  document.body.innerHTML =
    '<main id="app" class="host"><main id="game-root"></main></main>';
  const gameRoot = document.getElementById("game-root");
  if (gameRoot === null) throw new Error("missing #game-root");
  const order: string[] = [];
  const notices: Array<{ title: string; message: string }> = [];
  const worldFactoryInputs: unknown[] = [];
  const renderer = createFakeRenderer();
  const { audio, started } = createFakeAudio();
  const frames = new ManualFrames();
  let game: RecordedGame | null = null;

  const fakeWindow = {
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    location: { search: "" },
    addEventListener(): void {},
    removeEventListener(): void {},
    requestAnimationFrame: frames.raf,
    cancelAnimationFrame: frames.cancel,
  } as unknown as Window;

  const chrome = {
    stageBar: document.createElement("div"),
    stageRoomEl: document.createElement("span"),
    stagePlayersEl: document.createElement("span"),
    setConnection(): void {},
    setStageActive(): void {},
    showReconnectBanner(): void {},
    mount(): void {},
  } as unknown as HostChrome;

  const noticesApi = {
    clear(): void {},
    show(options: { title: string; message: string }): unknown {
      notices.push({ title: options.title, message: options.message });
      return null;
    },
    showError(error: unknown): void {
      const message = error instanceof Error ? error.message : String(error);
      notices.push({ title: "Game stopped", message });
    },
    showRenderer(): void {},
  } as unknown as HostNotices;

  const deps: StageDeps = {
    doc: document,
    window: fakeWindow,
    gameRoot,
    games: {
      games: [
        {
          slug,
          name: slug,
          description: "",
          minPlayers: 1,
          maxPlayers: 2,
          needsGyro: false,
          manifestUrl,
        },
      ],
      importModule: async () => {
        importCalls += 1;
        return {
          default: (manifest: Game["manifest"]) => {
            game = createRecordedGame(order, manifest);
            return game;
          },
        };
      },
    },
    mapper: new InputMapper(),
    client: { serverNow: () => null } as unknown as HostClient,
    debugCounters: createDebugCounters(false),
    layouts: new LayoutApi({ sender: { send(): void {} } }),
    eventRouter: new EventRouter(),
    chrome,
    roster: { updateStageBar(): void {} } as unknown as HostRoster,
    notices: noticesApi,
    overlay: { recordFrame(): void {} } as unknown as HostOverlay,
    syncPause(): void {},
    hideLauncher(): void {},
    closeOverlays(): void {},
    onBackToGames(): void {},
    audio,
    createRenderer: async (options): Promise<GameRendererChoice> => ({
      ok: true,
      renderer,
      backend: "canvas2d",
      canvas: options.canvas,
      usedFallback: false,
      ...(options.manifest.renderer === "babylon"
        ? {
            createWorld: (input) => {
              worldFactoryInputs.push(input);
              return createFakeWorld(order);
            },
          }
        : {}),
    }),
  };

  return {
    stage: createStage(deps),
    audio,
    startedAudio: started,
    renderer,
    frames,
    notices,
    worldFactoryInputs,
    order,
    getGame: () => game,
  };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function startButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    ".lanpad-start__button",
  );
  if (button === null) throw new Error("no start screen button");
  return button;
}

function requireGame(harness: Harness): RecordedGame {
  const game = harness.getGame();
  if (game === null) throw new Error("the game factory has not run");
  return game;
}

function requireContext(game: RecordedGame): GameContext {
  const ctx = game.context();
  if (ctx === null) throw new Error("game.init has not run");
  return ctx;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("host asset/audio/world integration", () => {
  test("[ER-23-01][FR-9.11] an asset-backed game boots with ready assets and a playable registered sound", async () => {
    const harness = createHarness("fixture", FIXTURE_MANIFEST_URL);
    try {
      await harness.stage.openGame("fixture");

      // Eager bytes only: the lazy arena group must not be fetched at boot.
      expect(requests.some((url) => url.endsWith("files/triangle.glb"))).toBe(
        true,
      );
      expect(requests.some((url) => url.endsWith("files/hit.ogg"))).toBe(true);
      expect(requests.some((url) => url.endsWith("files/arena.json"))).toBe(
        false,
      );

      expect(
        document.querySelector(".lanpad-start__hint")?.textContent,
      ).toBe("Ready. Press Enter to start.");
      expect(harness.audio.state).toBe("locked");

      startButton().click();
      await waitFor(
        () => (harness.getGame()?.initCalls ?? 0) === 1,
        "game.init",
      );

      const game = requireGame(harness);
      const ctx = requireContext(game);
      expect(ctx.assets).toBeDefined();
      const assets = ctx.assets;
      if (assets === undefined) throw new Error("expected ctx.assets");

      const triangle = assets.get("triangle");
      expect(triangle?.state).toBe("ready");
      expect(triangle?.value).toBeInstanceOf(Uint8Array);
      expect(assets.get("arena-data")).toBeUndefined();
      expect(ctx.world).toBeUndefined();

      // The start gesture unlocked the bus and the library registered `hit`.
      expect(harness.audio.unlocked).toBe(true);
      ctx.audio.playSfx("hit");
      expect(harness.startedAudio).toHaveLength(1);

      expect(harness.notices).toHaveLength(0);
      expect(harness.stage.isStageActive()).toBe(true);
      expect(document.querySelector(".lanpad-start")).toBeNull();
    } finally {
      harness.stage.teardownGame();
    }
  });

  test("[ER-23-01] a game without assets.json exposes no ctx.assets and starts exactly as before", async () => {
    const manifestUrl = serveVirtual("plain-game", {
      "game.manifest.json": gameManifest("plain-game"),
      "layout.json": LAYOUT_JSON,
    });
    const harness = createHarness("plain-game", manifestUrl);
    try {
      await harness.stage.openGame("plain-game");
      expect(
        document.querySelector(".lanpad-start__hint")?.textContent,
      ).toBe("Ready. Press Enter to start.");
      startButton().click();
      await waitFor(
        () => (harness.getGame()?.initCalls ?? 0) === 1,
        "game.init",
      );
      const ctx = requireContext(requireGame(harness));
      expect(ctx.assets).toBeUndefined();
      expect(ctx.world).toBeUndefined();
      expect(harness.notices).toHaveLength(0);
    } finally {
      harness.stage.teardownGame();
    }
  });

  test("[ER-23-01] an over-budget assets.json fails before any game code runs", async () => {
    const manifestUrl = serveVirtual("over-budget", {
      "game.manifest.json": gameManifest("over-budget", {
        assetBudget: { initialBytes: 100, totalBytes: 200 },
      }),
      "assets.json": JSON.stringify({
        schemaVersion: 1,
        groups: [{ id: "boot", mode: "eager" }],
        assets: [
          {
            id: "tri",
            path: "files/tri.glb",
            kind: "mesh",
            bytes: 600,
            group: "boot",
            ledger: "tri.glb",
          },
        ],
      }),
      "LICENSES.csv": `${LEDGER_HEADER}tri.glb,synthetic,test,CC0,2026-10-23,\n`,
      "layout.json": LAYOUT_JSON,
    });
    const harness = createHarness("over-budget", manifestUrl);
    try {
      await harness.stage.openGame("over-budget");
      expect(importCalls).toBe(0);
      expect(harness.getGame()).toBeNull();
      expect(requests.some((url) => url.endsWith("files/tri.glb"))).toBe(false);
      expect(harness.notices).toHaveLength(1);
      expect(harness.notices[0]?.message).toMatch(/E_ASSET_BUDGET|budget/i);
      expect(document.querySelector(".lanpad-start")).toBeNull();
    } finally {
      harness.stage.teardownGame();
    }
  });

  test("[ER-23-01] assets.json without LICENSES.csv fails before any game code runs", async () => {
    const manifestUrl = serveVirtual("no-ledger", {
      "game.manifest.json": gameManifest("no-ledger"),
      "assets.json": JSON.stringify({
        schemaVersion: 1,
        groups: [{ id: "boot", mode: "eager" }],
        assets: [
          {
            id: "tri",
            path: "files/tri.glb",
            kind: "mesh",
            bytes: 4,
            group: "boot",
            ledger: "tri.glb",
          },
        ],
      }),
      "layout.json": LAYOUT_JSON,
    });
    const harness = createHarness("no-ledger", manifestUrl);
    try {
      await harness.stage.openGame("no-ledger");
      expect(importCalls).toBe(0);
      expect(harness.getGame()).toBeNull();
      expect(harness.notices).toHaveLength(1);
      expect(harness.notices[0]?.message).toMatch(/LICENSES\.csv/);
    } finally {
      harness.stage.teardownGame();
    }
  });

  test("[ER-23-01] teardown disposes the asset library and the renderer", async () => {
    const harness = createHarness("fixture", FIXTURE_MANIFEST_URL);
    await harness.stage.openGame("fixture");
    startButton().click();
    await waitFor(
      () => (harness.getGame()?.initCalls ?? 0) === 1,
      "game.init",
    );
    const ctx = requireContext(requireGame(harness));
    const assets = ctx.assets;
    if (assets === undefined) throw new Error("expected ctx.assets");

    harness.stage.teardownGame();
    expect(harness.renderer.disposeCalls).toBe(1);
    expect(harness.stage.isStageActive()).toBe(false);
    await expect(assets.load("arena-data")).rejects.toMatchObject({
      code: "E_ASSET_DISPOSED",
    });
    expect(assets.get("triangle")).toBeUndefined();
    // Idempotent teardown must not double-dispose the renderer.
    harness.stage.teardownGame();
    expect(harness.renderer.disposeCalls).toBe(1);
  });

  test("[ER-22-01][ER-22-10] a Babylon game gets ctx.world, advanced once per tick before simulate and disposed once", async () => {
    const manifestUrl = serveVirtual("babylon-game", {
      "game.manifest.json": gameManifest("babylon-game", {
        renderer: "babylon",
      }),
      "assets.json": JSON.stringify({
        schemaVersion: 1,
        groups: [{ id: "boot", mode: "eager" }],
        assets: [
          {
            id: "tri",
            path: "files/tri.glb",
            kind: "mesh",
            bytes: 4,
            group: "boot",
            ledger: "tri.glb",
          },
        ],
      }),
      "LICENSES.csv": `${LEDGER_HEADER}tri.glb,synthetic,test,CC0,2026-10-23,\n`,
      "files/tri.glb": new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
      "layout.json": LAYOUT_JSON,
    });
    const harness = createHarness("babylon-game", manifestUrl);
    try {
      await harness.stage.openGame("babylon-game");
      startButton().click();
      await waitFor(
        () => (harness.getGame()?.initCalls ?? 0) === 1,
        "game.init",
      );

      const game = requireGame(harness);
      const ctx = requireContext(game);
      expect(ctx.world).toBeDefined();

      // The stage hands the eager GLB declarations to the world factory.
      expect(harness.worldFactoryInputs).toHaveLength(1);
      const input = harness.worldFactoryInputs[0] as {
        declarations?: ReadonlyArray<{ id: string; kind: string }>;
      };
      expect(input.declarations?.map((entry) => entry.id)).toContain("tri");

      await waitFor(() => harness.frames.pending > 0, "the loop's first frame");
      for (let index = 0; index < 40 && game.simulateCalls < 3; index += 1) {
        harness.frames.step(50);
        await Promise.resolve();
      }
      expect(game.simulateCalls).toBeGreaterThanOrEqual(3);

      const world = ctx.world as unknown as FakeWorld;
      expect(world.updates.length).toBe(game.simulateCalls);
      // Every simulate is immediately preceded by exactly one world update.
      const interleaved = harness.order.filter(
        (entry) => entry === "world" || entry === "simulate",
      );
      expect(interleaved.length).toBe(game.simulateCalls * 2);
      for (let index = 0; index < interleaved.length; index += 2) {
        expect(interleaved[index]).toBe("world");
        expect(interleaved[index + 1]).toBe("simulate");
      }

      harness.stage.teardownGame();
      expect(world.disposedCount).toBe(1);
      expect(game.disposeCalls).toBe(1);
      expect(harness.renderer.disposeCalls).toBe(1);
      harness.stage.teardownGame();
      expect(world.disposedCount).toBe(1);
    } finally {
      harness.stage.teardownGame();
    }
  });
});
