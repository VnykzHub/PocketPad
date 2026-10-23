/**
 * Console shell composition root (spec 25 §2; BUILD-BRIEF launcher).
 *
 * Owns the launcher phases and wires the components together:
 *
 *   start   gate only; its first key/button/tap unlocks audio, then home
 *   home    top bar, focused game row, lobby, hint bar, live backdrop
 *   loading loading screen with byte progress; the backdrop is paused
 *
 * Launch is synchronous: the loading screen is shown before `onLaunch`, so the
 * host can navigate without a blank frame. `returnFromGame` restores the tile
 * that launched, resumes the backdrop and hides the loading screen. A host
 * that destroys and recreates the shell between routes preserves continuity by
 * passing `skipStartGate` and `focusSlug` (see `host/launcher.ts`).
 *
 * The shell owns exactly one timer: the minute clock. It is injectable so
 * tests can count schedules and cancels, and it starts only on `mount()`.
 * Gamepads are polled by the host (`pollGamepad`); there is no frame loop here.
 */
import type { AssetProgress } from "../../assets/AssetLoader.js";
import { ConsoleBackdrop } from "./backdrop.js";
import { ConsoleGameRow } from "./gameRow.js";
import { ConsoleHintBar } from "./hintBar.js";
import { ConsoleInput, type GamepadLike } from "./input.js";
import { ConsoleLobbyPanel } from "./lobbyPanel.js";
import { ConsoleLoadingScreen } from "./loadingScreen.js";
import { readPrefersReducedMotion, resolveMotionTier } from "./motion.js";
import {
  presentationAccent,
  presentationGradient,
  visibleConsoleGames,
} from "./presentation.js";
import { ConsoleStartGate } from "./startGate.js";
import { ConsoleTopBar, type QrRenderer } from "./topBar.js";
import type {
  ConsoleAction,
  ConsoleConnection,
  ConsoleGame,
  ConsolePlayerInput,
  ConsoleRoomInfo,
  InputMode,
  MotionTier,
} from "./types.js";

export type ShellPhase = "start" | "home" | "loading";

export const DEFAULT_BACKDROP =
  "radial-gradient(120% 120% at 50% 0%, #1a1a1a 0%, #050505 72%)";
export const CLOCK_INTERVAL_MS = 60_000;

export interface ConsoleShellOptions {
  readonly games: readonly ConsoleGame[];
  readonly onLaunch: (game: ConsoleGame) => void;
  /** Back during loading; return home first, then let the host abort. */
  readonly onCancelLaunch?: (game: ConsoleGame) => void;
  /** Runs inside the start gesture; rejects are swallowed by the gate. */
  readonly unlockAudio?: () => Promise<void>;
  readonly room?: ConsoleRoomInfo;
  readonly connection?: ConsoleConnection;
  readonly players?: readonly ConsolePlayerInput[];
  readonly renderQr?: QrRenderer;
  /** `?debug=1`: show `debugOnly` tech demos such as Engine Cube. */
  readonly debug?: boolean;
  readonly lowTier?: boolean;
  readonly prefersReducedMotion?: boolean;
  /** Return from a game: no second audio gate. */
  readonly skipStartGate?: boolean;
  /** Tile to focus on construction (restored after a launch). */
  readonly focusSlug?: string | null;
  /** Called once the start gesture (and audio unlock) completed. */
  readonly onStarted?: () => void;
  readonly now?: () => Date;
  readonly scheduleClock?: (tick: () => void) => unknown;
  readonly cancelClock?: (handle: unknown) => void;
  readonly gamepads?: () => ReadonlyArray<GamepadLike | null | undefined>;
}

export class ConsoleShell {
  readonly element: HTMLElement;
  readonly frame: HTMLElement;
  readonly backdrop: ConsoleBackdrop;
  readonly topBar: ConsoleTopBar;
  readonly row: ConsoleGameRow;
  readonly lobby: ConsoleLobbyPanel;
  readonly hints: ConsoleHintBar;
  readonly loading: ConsoleLoadingScreen;
  readonly input: ConsoleInput;
  readonly motion: MotionTier;
  readonly startGate: ConsoleStartGate | null;

  private readonly options: ConsoleShellOptions;
  private readonly now: () => Date;
  private phaseValue: ShellPhase;
  private currentGameValue: ConsoleGame | null = null;
  private lastLaunchedSlug: string | null = null;
  private clockHandle: unknown = null;
  private clockRunning = false;
  private mounted = false;
  private destroyed = false;

  constructor(doc: Document, options: ConsoleShellOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.motion = resolveMotionTier({
      prefersReducedMotion:
        options.prefersReducedMotion !== undefined
          ? options.prefersReducedMotion
          : readPrefersReducedMotion(doc),
      ...(options.lowTier !== undefined ? { lowTier: options.lowTier } : {}),
    });

    const root = doc.createElement("div");
    root.className = "console-shell";
    root.dataset["motion"] = this.motion;
    this.element = root;

    this.backdrop = new ConsoleBackdrop(doc, { tier: this.motion });
    root.append(this.backdrop.element);

    const frame = doc.createElement("div");
    frame.className = "console-shell__frame";
    this.frame = frame;

    this.topBar = new ConsoleTopBar(doc, {
      ...(options.room !== undefined ? { room: options.room } : {}),
      ...(options.connection !== undefined
        ? { connection: options.connection }
        : {}),
      ...(options.players !== undefined ? { players: options.players } : {}),
      ...(options.renderQr !== undefined ? { renderQr: options.renderQr } : {}),
    });

    const games = visibleConsoleGames(options.games, options.debug === true);
    this.row = new ConsoleGameRow(doc, {
      games,
      motion: this.motion,
      onActivate: (game) => this.launch(game),
      onFocusChange: () => this.syncBackdrop(),
    });

    this.lobby = new ConsoleLobbyPanel(doc, {
      ...(options.players !== undefined ? { players: options.players } : {}),
      ...(options.room !== undefined ? { room: options.room } : {}),
      onScanRequest: () => this.topBar.setQrOpen(true),
    });

    this.hints = new ConsoleHintBar(doc, "keyboard");
    this.loading = new ConsoleLoadingScreen(doc, { motion: this.motion });

    const main = doc.createElement("main");
    main.className = "console-shell__main";
    main.append(this.row.element, this.lobby.element);
    frame.append(this.topBar.element, main, this.hints.element);
    root.append(frame);

    this.phaseValue = options.skipStartGate === true ? "home" : "start";
    if (options.skipStartGate !== true) {
      this.startGate = new ConsoleStartGate(doc, {
        onStart: this.handleGateStart,
        ...(options.unlockAudio !== undefined
          ? { unlockAudio: options.unlockAudio }
          : {}),
      });
      root.append(this.startGate.element);
    } else {
      this.startGate = null;
    }

    this.input = new ConsoleInput(doc, {
      onAction: (action) => this.handleAction(action),
      onModeChange: (mode) => this.hints.setMode(mode),
      ...(options.gamepads !== undefined ? { gamepads: options.gamepads } : {}),
    });

    root.append(this.loading.element);
    this.setPhase(this.phaseValue);

    if (options.focusSlug !== undefined && options.focusSlug !== null) {
      this.row.focusSlug(options.focusSlug);
    }
    this.syncBackdrop();
    this.row.element.addEventListener("pointermove", this.handlePointerMove);
  }

  get phase(): ShellPhase {
    return this.phaseValue;
  }

  get currentGame(): ConsoleGame | null {
    return this.currentGameValue;
  }

  get launchedSlug(): string | null {
    return this.lastLaunchedSlug;
  }

  get isMounted(): boolean {
    return this.mounted;
  }

  /** Appends the shell and starts the clock; focus is a separate call. */
  mount(parent: HTMLElement): void {
    if (this.destroyed) return;
    parent.append(this.element);
    this.mounted = true;
    if (this.phaseValue === "home") this.input.attach();
    this.startClock();
    if (this.phaseValue === "home") this.focus();
  }

  focus(): void {
    if (this.destroyed) return;
    if (this.phaseValue === "start") {
      this.startGate?.focus();
      return;
    }
    if (this.phaseValue === "loading") {
      this.loading.focus();
      return;
    }
    this.row.focus();
  }

  /** Programmatic start gesture (tap, test, or a host-level "any button"). */
  async start(source: InputMode | "pointer" = "pointer"): Promise<void> {
    if (this.destroyed || this.phaseValue !== "start") return;
    await this.startGate?.activate(source);
  }

  /** Shows the loading screen and hands control to the host. */
  beginLaunch(game: ConsoleGame): void {
    if (this.destroyed || this.phaseValue !== "home") return;
    this.currentGameValue = game;
    this.lastLaunchedSlug = game.slug;
    this.backdrop.pause();
    this.setPhase("loading");
    this.loading.show(game.name);
    this.loading.focus();
    this.options.onLaunch(game);
  }

  setLoadingProgress(progress: AssetProgress): void {
    if (this.phaseValue !== "loading") return;
    this.loading.update(progress);
  }

  /**
   * Back on the home screen after a game. `slug` defaults to the launch slug;
   * the tile is restored and focused, and the backdrop resumes immediately.
   */
  returnFromGame(slug?: string | null): void {
    if (this.destroyed) return;
    const target = slug !== undefined ? slug : this.lastLaunchedSlug;
    this.currentGameValue = null;
    this.loading.hide();
    this.backdrop.resume();
    this.setPhase("home");
    if (target !== null && !this.row.focusSlug(target)) {
      this.row.focusFirst();
    }
    this.input.attach();
    this.row.focus();
  }

  updatePlayers(players: readonly ConsolePlayerInput[]): void {
    this.topBar.setPlayers(players);
    this.lobby.setPlayers(players);
  }

  updateConnection(connection: ConsoleConnection): void {
    this.topBar.setConnection(connection);
  }

  updateRoom(room: ConsoleRoomInfo): void {
    this.topBar.setRoom(room);
    this.lobby.setRoom(room);
  }

  /** Host frame hook; no-op until a pad edge is seen. */
  pollGamepad(): ConsoleAction[] {
    return this.input.pollGamepad();
  }

  /** Phone remote (broker event translated to a button id by the host). */
  handleRemote(button: string): boolean {
    return this.input.handleRemote(button);
  }

  handleAction(action: ConsoleAction): void {
    if (this.destroyed) return;
    if (this.phaseValue === "start") {
      if (action === "confirm") void this.start("gamepad");
      return;
    }
    if (this.phaseValue === "loading") {
      if (action === "back") this.cancelLaunch();
      return;
    }
    switch (action) {
      case "prev":
        this.row.move(-1);
        break;
      case "next":
        this.row.move(1);
        break;
      case "first":
        this.row.focusFirst();
        break;
      case "last":
        this.row.focusLast();
        break;
      case "confirm":
        this.row.activateActive();
        break;
      case "back":
        if (this.topBar.isQrOpen) this.topBar.setQrOpen(false);
        break;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopClock();
    this.input.destroy();
    this.startGate?.destroy();
    this.row.element.removeEventListener("pointermove", this.handlePointerMove);
    this.backdrop.destroy();
    this.topBar.destroy();
    this.row.destroy();
    this.lobby.destroy();
    this.hints.destroy();
    this.loading.destroy();
    this.element.remove();
    this.mounted = false;
  }

  private launch(game: ConsoleGame): void {
    this.beginLaunch(game);
  }

  private cancelLaunch(): void {
    const game = this.currentGameValue;
    if (game === null) return;
    this.returnFromGame(game.slug);
    this.options.onCancelLaunch?.(game);
  }

  private readonly handleGateStart = (): void => {
    if (this.destroyed) return;
    this.startGate?.destroy();
    this.setPhase("home");
    this.input.attach();
    this.hints.setMode(this.input.currentMode);
    this.options.onStarted?.();
    this.row.focus();
  };

  private setPhase(phase: ShellPhase): void {
    this.phaseValue = phase;
    this.element.dataset["phase"] = phase;
    // The frame is inert outside the home phase so Tab cannot escape the gate
    // and the loading screen owns focus while a game starts.
    this.frame.hidden = phase !== "home";
    if (phase === "home") this.topBar.setClock(this.now());
  }

  private syncBackdrop(): void {
    const game = this.row.focusedGame;
    if (game === null) {
      this.backdrop.show({ accent: "#4cb3f0", gradient: DEFAULT_BACKDROP });
      return;
    }
    this.backdrop.show({
      accent: presentationAccent(game),
      gradient: presentationGradient(game),
    });
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.motion === "reduced" || this.destroyed) return;
    const target = event.currentTarget as HTMLElement | null;
    const rect = target?.getBoundingClientRect?.();
    if (rect === undefined || rect.width <= 0 || rect.height <= 0) return;
    const x = ((event.clientX - rect.left) / rect.width - 0.5) * 16;
    const y = ((event.clientY - rect.top) / rect.height - 0.5) * 16;
    this.row.setParallax(x, y);
  };

  private startClock(): void {
    if (this.clockRunning || this.destroyed) return;
    this.clockRunning = true;
    this.topBar.setClock(this.now());
    if (this.options.scheduleClock !== undefined) {
      this.clockHandle = this.options.scheduleClock(this.tickClock);
    } else if (typeof setInterval === "function") {
      this.clockHandle = setInterval(this.tickClock, CLOCK_INTERVAL_MS);
    }
  }

  private stopClock(): void {
    if (!this.clockRunning) return;
    this.clockRunning = false;
    if (this.clockHandle === null) return;
    if (this.options.cancelClock !== undefined) {
      this.options.cancelClock(this.clockHandle);
    } else if (typeof clearInterval === "function") {
      clearInterval(this.clockHandle as Parameters<typeof clearInterval>[0]);
    }
    this.clockHandle = null;
  }

  private readonly tickClock = (): void => {
    if (!this.destroyed) this.topBar.setClock(this.now());
  };
}
