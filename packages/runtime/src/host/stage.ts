/**
 * HP-04 stage and canvas lifecycle (D3/D7).
 *
 * Owns everything between a slug and a running game: the canvas, renderer,
 * context-loss recovery, dynamic resolution, `GameHost`, the start screen and
 * the asset load. The room, roster and socket belong to `room.ts`; tearing a
 * stage down never touches them.
 *
 * `GameHost` is built here and receives the shared `InputMapper`, `AudioBus`
 * and debug counters. Games only ever see the `GameContext` (FR-7.17).
 */
import { createCanvas2DDevice } from "@lanpad/engine-renderer-webgl2/canvas2d";
import type {
  AssetDeclaration,
  AssetLibrary,
  AssetProgress as LoadedAssetProgress,
  GameManifest,
  GameWorld3D,
} from "@lanpad/sdk";
import type { BabylonGameRenderer } from "../babylon/BabylonGameRenderer.js";
import type {
  BabylonModelProvider,
  BabylonModelSource,
} from "../babylon/world3d/types.js";
import type { AssetProgress } from "../assets/AssetLoader.js";
import { AudioBus } from "../audio/AudioBus.js";
import { createGameAssetLibrary, toLoadProgress } from "../assets/gameAssets.js";
import type { GameAssetLibrary } from "../assets/GameAssetLibrary.js";
import type { BundledGames } from "../demo/bundledGames.js";
import { createEngineCanvas2DRenderer } from "../engine/canvas2DRenderer.js";
import { EngineGameRenderer } from "../engine/engine3DRenderer.js";
import type { EventRouter } from "../game/EventRouter.js";
import type { GameDebugCounters } from "../game/GameContext.js";
import { GameHost } from "../game/GameHost.js";
import type { LayoutApi } from "../game/LayoutApi.js";
import { loadGame, type LoadedGame } from "../game/loadGame.js";
import { registerManifestLayouts } from "../game/manifestLayouts.js";
import type { InputMapper } from "../input/InputMapper.js";
import type { FrameStats } from "../loop/types.js";
import type { HostClient } from "../net/hostClient.js";
import {
  applyResolutionScale,
  attachContextLossRecovery,
  ContextLossRecovery,
  readViewportEnvironment,
  ResolutionController,
  resolveTvProfile,
} from "../profile/index.js";
import {
  createFallbackNotice,
  RendererUnavailableError,
  type Renderer3D,
  type RendererBackend,
} from "../render/Renderer.js";
import {
  selectRenderer,
  type RendererSelectionFactories,
} from "../render/selectRenderer.js";
import { StartScreen } from "../ui/StartScreen.js";
import type { HostChrome } from "./chrome.js";
import { BACK_TO_GAMES_LABEL, GAME_NOT_FOUND_TITLE } from "./copy.js";
import type { HostNotices } from "./notices.js";
import type { HostOverlay, OverlayRuntimeStats } from "./overlay.js";
import type { HostRoster } from "./roster.js";

/**
 * Start-screen readiness for a game with no `assets.json` (spec 23 §3.3):
 * there is nothing to fetch, so the screen is ready immediately.
 */
const NO_ASSETS_PROGRESS: AssetProgress = {
  loadedBytes: 0,
  totalBytes: 0,
  determinate: true,
  fraction: 1,
  loadedCount: 0,
  totalCount: 0,
  currentUrl: null,
  done: true,
};

/** The same "ready at once" signal in the loader's own progress shape. */
const NO_ASSETS_LOADED_PROGRESS: LoadedAssetProgress = {
  fetched: 0,
  declared: 0,
  determinate: true,
  state: "ready",
  loadedCount: 0,
  totalCount: 0,
  currentId: null,
};

/**
 * Benchmark affordance: `?debug=1&babylon-backend=webgl2` forces the WebGL2
 * path so the fallback can be measured on a machine whose WebGPU works. It is
 * debug-only (no effect without `?debug=1`) and never read from game data.
 */
function readBabylonBackendOverride(
  window: Window,
): "webgl2" | undefined {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("debug") !== "1") return undefined;
    return params.get("babylon-backend") === "webgl2" ? "webgl2" : undefined;
  } catch {
    return undefined;
  }
}

export interface OpenGameOptions {
  /** Rematch: reload and start without a second start-screen gesture. */
  readonly autoStart?: boolean;
}

export interface StageDeps {
  readonly doc: Document;
  readonly window: Window;
  readonly gameRoot: HTMLElement;
  readonly games: BundledGames;
  readonly mapper: InputMapper;
  readonly client: HostClient;
  readonly debugCounters: GameDebugCounters;
  readonly layouts: LayoutApi;
  readonly eventRouter: EventRouter;
  readonly chrome: HostChrome;
  readonly roster: HostRoster;
  readonly notices: HostNotices;
  readonly overlay: HostOverlay;
  readonly syncPause: () => void;
  /** Starting a game leaves the launcher route. */
  readonly hideLauncher: () => void;
  /** HP-04b/HP-05 close when the stage tears down. */
  readonly closeOverlays: () => void;
  /** HP-07 "Back to games" action on the unknown-game notice. */
  readonly onBackToGames: () => void;
  /**
   * Eager-load progress for a host-level loading screen (spec 25 §2.4). The
   * launcher forwards it via `setLoadingProgress`; the stage start screen is
   * still updated independently.
   */
  readonly onAssetProgress?: (progress: LoadedAssetProgress) => void;
  /** Test seam: shared audio bus; production creates its own (Web Audio). */
  readonly audio?: AudioBus;
  /** Test seam: renderer selection, so stage tests need no GPU. */
  readonly createRenderer?: (
    options: GameRendererChoiceOptions,
  ) => Promise<GameRendererChoice>;
}

export interface GameRendererChoiceOptions {
  readonly canvas: HTMLCanvasElement;
  readonly manifest: GameManifest;
  readonly maxRenderHeight?: number;
  readonly tvProfile?: boolean;
  /** Benchmark override for the Babylon backend; production leaves it unset. */
  readonly babylonBackend?: "webgpu" | "webgl2";
  readonly factories?: Partial<RendererSelectionFactories>;
  readonly createCanvas2D?: typeof createCanvas2DDevice;
}

export type GameRendererChoice =
  | {
      readonly ok: true;
      readonly renderer: Renderer3D;
      readonly backend: RendererBackend;
      /** May differ from `options.canvas`; the caller must mount it. */
      readonly canvas: HTMLCanvasElement;
      readonly usedFallback: boolean;
      /**
       * Babylon only: creates the single spec-22 `GameWorld3D` on the already
       * initialized renderer. When the game declares GLB mesh assets, their
       * assets are wrapped in a model provider first (spec 22/23 seam). The
       * stage installs the result as `ctx.world`; the host disposes it.
       */
      readonly createWorld?: (input?: {
        readonly library: AssetLibrary;
        readonly declarations: readonly AssetDeclaration[];
      }) => GameWorld3D | Promise<GameWorld3D>;
    }
  | {
      readonly ok: false;
      readonly reason: "3d-unavailable";
      /** Fixed selector copy; safe to display. */
      readonly message: string;
      readonly canvas: HTMLCanvasElement;
    };

type GameRendererOk = Extract<GameRendererChoice, { ok: true }>;

/** Babylon world factory carried by a successful renderer choice. */
type GameWorldFactory = NonNullable<GameRendererOk["createWorld"]>;

/**
 * Selects and initializes the renderer a manifest asks for.
 *
 * `canvas2d` (the default) keeps the pre-engine path exactly: engine Canvas2D
 * device plus `createEngineCanvas2DRenderer`, and a Canvas2D failure rejects
 * with the friendly `RendererUnavailableError`.
 *
 * `engine` calls `selectRenderer({ require3D: true })`, so Canvas2D is refused
 * instead of silently flattening a 3D game. The selected device is wrapped in
 * `EngineGameRenderer`. The selector may replace the canvas after a failed
 * WebGPU init; the result reports the canvas that must be mounted.
 */
export async function createGameRenderer(
  options: GameRendererChoiceOptions,
): Promise<GameRendererChoice> {
  if (options.manifest.renderer === "babylon") {
    const { createBabylonGameRenderer } = await import(
      "../babylon/createBabylonRenderer.js"
    );
    const choice = await createBabylonGameRenderer({
      canvas: options.canvas,
      ...(options.babylonBackend !== undefined
        ? { forceBackend: options.babylonBackend }
        : {}),
    });
    if (!choice.ok) {
      return {
        ok: false,
        reason: "3d-unavailable",
        message: choice.message,
        canvas: options.canvas,
      };
    }
    try {
      await choice.renderer.init(choice.canvas);
    } catch (error) {
      choice.renderer.dispose();
      throw error;
    }
    return {
      ok: true,
      renderer: choice.renderer,
      backend: choice.backend,
      canvas: choice.canvas,
      usedFallback: choice.usedFallback,
      // Spec 22: one world per renderer, created only after init succeeds.
      createWorld: (input) => createBabylonWorld(choice.renderer, input),
    };
  }

  if (options.manifest.renderer !== "engine") {
    const createCanvas2D = options.createCanvas2D ?? createCanvas2DDevice;
    const device = await createCanvas2D({
      canvas: options.canvas,
      ...(options.maxRenderHeight !== undefined
        ? { maxRenderHeight: options.maxRenderHeight }
        : {}),
    }).catch((cause: unknown) => {
      throw new RendererUnavailableError(
        createFallbackNotice("canvas2d-unavailable"),
        cause,
      );
    });
    const renderer = createEngineCanvas2DRenderer(device, options.canvas);
    try {
      await renderer.init(options.canvas);
    } catch (error) {
      renderer.dispose();
      throw error;
    }
    return {
      ok: true,
      renderer,
      backend: "canvas2d",
      canvas: options.canvas,
      usedFallback: false,
    };
  }

  const selection = await selectRenderer({
    canvas: options.canvas,
    require3D: true,
    ...(options.maxRenderHeight !== undefined
      ? { maxRenderHeight: options.maxRenderHeight }
      : {}),
    ...(options.tvProfile !== undefined ? { tvProfile: options.tvProfile } : {}),
    ...(options.factories !== undefined ? { factories: options.factories } : {}),
  });
  if (!selection.ok) {
    return {
      ok: false,
      reason: "3d-unavailable",
      message: selection.message,
      canvas: options.canvas,
    };
  }

  let renderer: EngineGameRenderer | null = null;
  try {
    renderer = new EngineGameRenderer(selection.device, selection.canvas);
    await renderer.init(selection.canvas);
  } catch (error) {
    // The adapter disposes the device when its own init fails; this covers a
    // constructor failure before the adapter exists. Both are idempotent.
    if (renderer === null) selection.device.dispose();
    else renderer.dispose();
    throw error;
  }
  return {
    ok: true,
    renderer,
    backend: selection.backend,
    canvas: selection.canvas,
    usedFallback: selection.usedFallback,
  };
}

/**
 * Creates the Babylon world, first wrapping the game's ready GLB mesh assets
 * as spec-22 model sources. Handles that are not ready (lazy groups) are left
 * alone, so boot never fetches an asset the game did not declare eager.
 */
async function createBabylonWorld(
  renderer: BabylonGameRenderer,
  input?: {
    readonly library: AssetLibrary;
    readonly declarations: readonly AssetDeclaration[];
  },
): Promise<GameWorld3D> {
  const provider =
    input === undefined
      ? null
      : await loadBabylonModelProvider(
          renderer,
          input.library,
          input.declarations,
        );
  return provider === null
    ? renderer.createWorld()
    : renderer.createWorld({ provider });
}

async function loadBabylonModelProvider(
  renderer: BabylonGameRenderer,
  library: AssetLibrary,
  declarations: readonly AssetDeclaration[],
): Promise<BabylonModelProvider | null> {
  const meshDeclarations = declarations.filter(
    (declaration) => declaration.kind === "mesh",
  );
  if (meshDeclarations.length === 0) return null;
  const scene = renderer.babylonScene;
  if (scene === null) {
    throw new Error("The Babylon scene is not ready for model loading.");
  }

  // Both the glTF plugin and the loader are lazy chunks inside the Babylon
  // adapter (ER-21-08); 2D games and asset-free Babylon games never load them.
  const { loadAssetContainerFromBytes } = await import(
    "../babylon/loadAssetContainer.js"
  );
  const { createAssetContainerModelSource } = await import(
    "../babylon/babylonBindings.js"
  );

  const sources = new Map<string, BabylonModelSource>();
  for (const declaration of meshDeclarations) {
    // `get` returns only ready handles, so a lazy mesh is skipped here; the
    // game's own `ctx.assets.load` still owns that fetch decision.
    const handle = library.get(declaration.id);
    if (handle === undefined) continue;
    const bytes = handle.value;
    if (!(bytes instanceof Uint8Array)) {
      throw new Error(`Mesh asset "${declaration.id}" did not decode to bytes.`);
    }
    const container = await loadAssetContainerFromBytes(bytes, scene, {
      pluginExtension: declaration.path.endsWith(".gltf") ? ".gltf" : ".glb",
      name: declaration.id,
    });
    sources.set(declaration.id, createAssetContainerModelSource(container));
  }

  return {
    hasModel: (assetId) => sources.has(assetId),
    getModel: (assetId) => sources.get(assetId) ?? null,
  };
}

export interface HostStage {
  openGame(slug: string, options?: OpenGameOptions): Promise<void>;
  /** Stops the current game but keeps the room, roster and socket (HP-04). */
  teardownGame(): void;
  unlockAudio(): Promise<void>;
  pauseGame(): void;
  resumeGame(): void;
  isStageActive(): boolean;
  hasStartScreen(): boolean;
  getCurrentSlug(): string | null;
  clearCurrentSlug(): void;
  /** Renderer/canvas numbers for the 4 Hz debug overlay. */
  getDisplayStats(): OverlayRuntimeStats;
}

export function createStage(deps: StageDeps): HostStage {
  const audio = deps.audio ?? new AudioBus();
  const createRenderer = deps.createRenderer ?? createGameRenderer;
  const profile = resolveTvProfile(
    readViewportEnvironment(deps.window),
    deps.window.location.search,
  );
  const babylonBackend = readBabylonBackendOverride(deps.window);
  const resolution = new ResolutionController();

  let startScreen: StartScreen | null = null;
  let gameHost: GameHost | null = null;
  /** The loaded game whose host is built after the start gesture. */
  let loadedGame: LoadedGame | null = null;
  /** Spec-23 library; disposed with the stage, never handed to the game. */
  let assetLibrary: GameAssetLibrary | null = null;
  /** Spec-22 world created by the renderer for a Babylon manifest. */
  let world: GameWorld3D | null = null;
  /** One-shot world factory from the renderer choice, before the world exists. */
  let createWorld: GameWorldFactory | null = null;
  let renderer: Renderer3D | null = null;
  let backend: RendererBackend | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let detachContextLoss: (() => void) | null = null;
  /** True from the start gesture until the stage is left. */
  let stageActive = false;
  let currentSlug: string | null = null;
  /** Bumped by teardown so an in-flight game load cannot mount into a new route. */
  let gameGeneration = 0;

  function setStageActive(value: boolean): void {
    stageActive = value;
    deps.chrome.setStageActive(value);
  }

  function applySize(): void {
    if (renderer === null || canvas === null) return;
    // Every renderer writes inline CSS sizes when it resizes. Clear them first
    // so the stage stylesheet computes the presentation box; otherwise the
    // canvas freezes at its intrinsic 300×150 on first mount and ignores the
    // stage layout.
    canvas.style.removeProperty("width");
    canvas.style.removeProperty("height");
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;
    applyResolutionScale(renderer, width, height, profile.dpr, resolution.scale);
  }

  function onFrameStats(stats: FrameStats): void {
    deps.overlay.recordFrame(stats);
    if (resolution.sample(stats.frameMs)) {
      applySize();
    }
  }

  function teardownGame(): void {
    gameGeneration += 1;
    setStageActive(false);
    deps.closeOverlays();
    gameHost?.dispose();
    gameHost = null;
    startScreen?.destroy();
    startScreen = null;
    // Spec 23: the library belongs to the stage; a game only borrows handles.
    // Disposing it silences in-flight lazy loads and frees decoded assets.
    assetLibrary?.dispose();
    assetLibrary = null;
    loadedGame = null;
    detachContextLoss?.();
    detachContextLoss = null;
    deps.window.removeEventListener("resize", applySize);
    // The host already disposed the world; the renderer dispose below is the
    // second (idempotent) owner, so drop our reference first.
    world = null;
    createWorld = null;
    renderer?.dispose();
    renderer = null;
    backend = null;
    canvas?.remove();
    canvas = null;
    deps.chrome.stageBar.hidden = true;
    // The HP-06 banner belongs to the room, not the stage: a reconnecting
    // host keeps it while moving between the launcher and a game.
  }

  /**
   * Builds the `GameHost` after the start gesture. Building it here (rather
   * than during load) is what lets the host register decoded game audio on
   * the bus first, per spec 23 §3.3-4.
   */
  function buildGameHost(): GameHost | null {
    const loaded = loadedGame;
    const active = renderer;
    const activeBackend = backend;
    if (loaded === null || active === null || activeBackend === null) {
      return null;
    }

    const host = new GameHost({
      game: loaded.game,
      gameId: currentSlug ?? "",
      renderer: active,
      audio,
      mapper: deps.mapper,
      now: () => performance.now(),
      raf: (callback) => deps.window.requestAnimationFrame(callback),
      cancel: (id) => deps.window.cancelAnimationFrame(id),
      serverNow: () => deps.client.serverNow(),
      debug: deps.debugCounters,
      onFrameStats,
      onError: (error) => deps.notices.showError(error),
      ...(assetLibrary === null ? {} : { assets: assetLibrary }),
      ...(world === null ? {} : { world }),
    });
    // Named `ctx.events.on` handlers run at the start of each simulate tick,
    // before GameHost drains its queue for `game.onEvent` (D5-RT-01).
    host.input.setTickHook(() => {
      deps.eventRouter.dispatch();
    });
    return host;
  }

  async function startGame(): Promise<void> {
    if (canvas === null) return;
    const generation = gameGeneration;
    startScreen?.destroy();
    startScreen = null;
    setStageActive(true);
    deps.hideLauncher();
    canvas.hidden = false;
    deps.chrome.stageBar.hidden = false;
    deps.roster.updateStageBar();
    applySize();

    // Spec 23 §3.3-4: decode/register audio after the gesture unlocked the
    // bus and before the game context exists. A rematch reuses the already
    // unlocked bus; a game with no assets.json has nothing to register.
    const library = assetLibrary;
    if (library !== null && audio.unlocked) {
      try {
        await library.registerAudio(audio);
      } catch (error) {
        if (generation !== gameGeneration) return;
        deps.notices.showError(error);
        return;
      }
      if (generation !== gameGeneration) return;
    }

    const host = gameHost ?? buildGameHost();
    if (host === null) return;
    gameHost = host;
    try {
      await host.start();
    } catch (error) {
      deps.notices.showError(error);
      return;
    }
    deps.syncPause();
  }

  async function openGame(
    slug: string,
    options: OpenGameOptions = {},
  ): Promise<void> {
    const entry = deps.games.games.find((game) => game.slug === slug) ?? null;
    teardownGame();
    if (entry === null) {
      currentSlug = null;
      deps.notices.show({
        title: GAME_NOT_FOUND_TITLE,
        message: `Unknown game "${slug}" at /games/${slug}/.`,
        actionLabel: BACK_TO_GAMES_LABEL,
        onAction: () => deps.onBackToGames(),
        tone: "error",
      });
      return;
    }

    const generation = gameGeneration;
    currentSlug = slug;
    deps.notices.clear();

    const surface = deps.doc.createElement("canvas");
    surface.className = "lanpad-canvas";
    surface.hidden = true;
    deps.gameRoot.append(surface);
    canvas = surface;

    let loaded: LoadedGame;
    try {
      // The manifest decides the renderer, so it must load before selection.
      loaded = await loadGame(entry.manifestUrl, {
        importModule: deps.games.importModule,
      });
      if (generation !== gameGeneration) return;
      loadedGame = loaded;
      // Spec 23: validation (ledger, schema, budgets) already happened in
      // `loadGame`; constructing the library re-checks the budget before a
      // single asset byte is fetched. Games without assets.json stay null.
      if (loaded.assets !== null) {
        assetLibrary = createGameAssetLibrary(loaded.assets);
      }
    } catch (error) {
      if (generation !== gameGeneration) return;
      deps.notices.showError(error);
      return;
    }

    let active: Renderer3D | null = null;
    try {
      const choice = await createRenderer({
        canvas: surface,
        manifest: loaded.manifest,
        maxRenderHeight: profile.maxRenderHeight,
        tvProfile: profile.mode === "tv",
        ...(babylonBackend !== undefined ? { babylonBackend } : {}),
      });
      if (generation !== gameGeneration) {
        if (choice.ok) choice.renderer.dispose();
        if (choice.canvas !== surface) choice.canvas.remove();
        return;
      }
      if (!choice.ok) {
        surface.remove();
        canvas = null;
        deps.notices.show({
          title: "3D is not available",
          message: choice.message,
          actionLabel: BACK_TO_GAMES_LABEL,
          onAction: () => deps.onBackToGames(),
          tone: "error",
        });
        return;
      }
      active = choice.renderer;
      renderer = choice.renderer;
      backend = choice.backend;
      createWorld = choice.createWorld ?? null;
      // A failed WebGPU init can claim the original canvas, so the selector
      // may hand back a fresh one. It must be mounted before the first frame.
      if (choice.canvas !== surface) {
        surface.remove();
        choice.canvas.className = "lanpad-canvas";
        choice.canvas.hidden = true;
        deps.gameRoot.append(choice.canvas);
        canvas = choice.canvas;
      }
    } catch (error) {
      if (generation !== gameGeneration) return;
      surface.remove();
      canvas?.remove();
      canvas = null;
      if (error instanceof RendererUnavailableError) {
        deps.notices.showRenderer(error.notice, true);
      } else {
        deps.notices.showError(error);
      }
      return;
    }

    if (active === null || canvas === null) return;

    const contextRecovery = new ContextLossRecovery({
      controller: resolution,
      onRestored: applySize,
    });
    detachContextLoss = attachContextLossRecovery(canvas, contextRecovery);
    deps.window.addEventListener("resize", applySize);

    try {
      // D5/D7 seam: games call `ctx.layouts.set(slot, "<layout id>")`, and the
      // host registers the manifest's layout files before the game starts.
      await registerManifestLayouts(deps.layouts, loaded);
      if (generation !== gameGeneration) return;
    } catch (error) {
      if (generation !== gameGeneration) return;
      deps.notices.showError(error);
      return;
    }

    // The host is built on the start gesture (after audio registration), so
    // the sink forwards through the closure instead of a captured instance.
    deps.eventRouter.setSink({
      push: (slot, name, data) => {
        gameHost?.pushEvent(slot, name, data);
      },
    });

    if (options.autoStart !== true) {
      const screen = new StartScreen(deps.doc, {
        audio,
        title: loaded.manifest.name,
        onStart: () => void startGame(),
      });
      startScreen = screen;
      deps.gameRoot.prepend(screen.element);
      screen.focus();
    }

    try {
      if (assetLibrary !== null) {
        // Spec 23 §3.3-3: eager bytes load on the start screen with exact
        // byte progress; lazy assets wait for the game's `ctx.assets.load`.
        await assetLibrary.loadEager((progress) => {
          deps.onAssetProgress?.(progress);
          startScreen?.updateProgress(toLoadProgress(progress));
        });
      } else {
        // No assets.json: nothing to fetch, so the screen is ready at once.
        deps.onAssetProgress?.(NO_ASSETS_LOADED_PROGRESS);
        startScreen?.updateProgress(NO_ASSETS_PROGRESS);
      }
    } catch (error) {
      if (generation !== gameGeneration) return;
      deps.notices.showError(error);
      return;
    }

    // Spec 22: a Babylon manifest gets exactly one world. It is created after
    // the eager asset load so GLB meshes in the eager group can become model
    // sources, and before the start gesture so `ctx.world` is ready at init.
    // A 2D/engine manifest never gets a `createWorld` seam and stays absent.
    if (createWorld !== null) {
      const buildWorld = createWorld;
      createWorld = null;
      const assetInput =
        assetLibrary === null || loaded.assets === null
          ? undefined
          : {
              library: assetLibrary,
              declarations: loaded.assets.manifest.assets,
            };
      try {
        const created = await buildWorld(assetInput);
        if (generation !== gameGeneration) {
          created.dispose();
          return;
        }
        world = created;
      } catch (error) {
        if (generation !== gameGeneration) return;
        deps.notices.showError(error);
        return;
      }
    }

    if (generation !== gameGeneration) return;
    if (options.autoStart === true) {
      await startGame();
    }
  }

  function getDisplayStats(): OverlayRuntimeStats {
    return {
      backend,
      drawCalls: renderer?.drawCalls ?? 0,
      textureMemoryMB: renderer?.textureMemoryMB ?? 0,
      resolution:
        canvas === null
          ? null
          : {
              scale: resolution.scale,
              dpr: profile.dpr,
              width: canvas.width,
              height: canvas.height,
            },
    };
  }

  return {
    openGame,
    teardownGame,
    unlockAudio: () => audio.unlock(),
    pauseGame: () => gameHost?.pause(),
    resumeGame: () => gameHost?.resume(),
    isStageActive: () => stageActive,
    hasStartScreen: () => startScreen !== null,
    getCurrentSlug: () => currentSlug,
    clearCurrentSlug: () => {
      currentSlug = null;
    },
    getDisplayStats,
  };
}
