/**
 * Headless game test kit (Wave 0; spec 22 §6).
 *
 * Games and streams use this instead of copying hand-rolled fakes. It has no
 * GPU, DOM, socket, timer or runtime dependency. It is not part of the
 * production game bundle unless a test imports `@lanpad/sdk/testing`.
 */
import type {
  AssetLibrary,
  AssetProgress,
  AssetHandle,
  GameAudio,
  GameContext,
  GameControllerState,
  GameDebug,
  GameEvents,
  GameHaptics,
  GameInputReader,
  GameInputSnapshot,
  GameLayouts,
  GamePanels,
  GameRenderer3D,
  GameRng,
  JsonValue,
} from "./game-api.js";
import type { GameManifest } from "./manifest.js";
import type {
  ClipPlayOptions,
  FollowOptions,
  GameWorld3D,
  PostOptions,
  PrimitiveKind,
  PrimitiveOptions,
  ShadowTier,
  SkyPreset,
  World3DCapabilities,
  WorldActor,
  WorldInstances,
} from "./world3d.js";
import { WorldError } from "./world3d.js";

/** One recorded call; test-only, so allocation here is allowed. */
export interface FakeWorldCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface FakeWorldOptions {
  /** Asset ids `hasModel`/`spawnModel` accept; default: any non-empty id. */
  readonly models?: readonly string[];
  readonly capabilities?: Partial<World3DCapabilities>;
}

export interface FakeActor extends Omit<WorldActor, "alive"> {
  /** Mutable in the fake so tests can observe teardown. */
  alive: boolean;
  /** Clip time advanced by `update`, seconds; test convenience. */
  clipTime: number;
  currentClip: string | null;
}

export interface FakeWorld extends GameWorld3D {
  readonly calls: FakeWorldCall[];
  readonly actors: readonly FakeActor[];
  readonly instances: readonly WorldInstances[];
  readonly camera: {
    x: number;
    y: number;
    z: number;
    tx: number;
    ty: number;
    tz: number;
    fov: number;
  } | null;
  readonly followed: FakeActor | null;
  readonly disposed: boolean;
}

const DEFAULT_CAPS: World3DCapabilities = {
  backend: "webgpu",
  tier: "high",
  shadows: true,
  post: true,
  animation: true,
  instances: true,
  instanceTint: true,
  maxActors: 256,
  maxInstances: 1024,
};

/** A pure `ctx.world`: records calls, advances clips, never touches a GPU. */
export function createFakeWorld(options: FakeWorldOptions = {}): FakeWorld {
  const allowed = options.models === undefined ? null : new Set(options.models);
  const capabilities: World3DCapabilities = {
    ...DEFAULT_CAPS,
    ...options.capabilities,
  };
  const calls: FakeWorldCall[] = [];
  const actors: FakeActor[] = [];
  const instanceHandles: WorldInstances[] = [];
  let nextHandle = 1;
  let disposed = false;
  let followed: FakeActor | null = null;
  let camera: FakeWorld["camera"] = null;

  const record = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args });
  };
  const requireAlive = (): void => {
    if (disposed) {
      throw new WorldError("E_WORLD_DISPOSED", "The fake world is disposed.");
    }
  };
  const requireModel = (assetId: string): void => {
    if (allowed !== null && !allowed.has(assetId)) {
      throw new WorldError(
        "E_WORLD_ASSET",
        `Asset "${assetId}" is not in the fake world.`,
      );
    }
  };

  function createActor(): FakeActor {
    const id = nextHandle;
    nextHandle += 1;
    const actor: FakeActor = {
      id,
      alive: true,
      clipTime: 0,
      currentClip: null,
      setPosition(x, y, z) {
        record("setPosition", id, x, y, z);
      },
      setYaw(radians) {
        record("setYaw", id, radians);
      },
      setQuaternion(x, y, z, w) {
        record("setQuaternion", id, x, y, z, w);
      },
      setScale(uniform) {
        record("setScale", id, uniform);
      },
      setScale3(x, y, z) {
        record("setScale3", id, x, y, z);
      },
      setTint(color) {
        record("setTint", id, color);
      },
      setEmissive(color) {
        record("setEmissive", id, color);
      },
      setVisible(visible) {
        record("setVisible", id, visible);
      },
      playClip(name: string, opts?: ClipPlayOptions) {
        record("playClip", id, name, opts);
        actor.currentClip = name;
        actor.clipTime = 0;
      },
      stopClip(fadeSeconds?: number) {
        record("stopClip", id, fadeSeconds);
        actor.currentClip = null;
      },
      crossfadeClip(name: string, fadeSeconds: number, opts?: ClipPlayOptions) {
        record("crossfadeClip", id, name, fadeSeconds, opts);
        actor.currentClip = name;
        actor.clipTime = 0;
      },
      setClipSpeed(speed: number) {
        record("setClipSpeed", id, speed);
      },
      dispose() {
        record("disposeActor", id);
        actor.alive = false;
      },
    };
    actors.push(actor);
    return actor;
  }

  const world: FakeWorld = {
    get capabilities() {
      return capabilities;
    },
    get calls() {
      return calls;
    },
    get actors() {
      return actors;
    },
    get instances() {
      return instanceHandles;
    },
    get camera() {
      return camera;
    },
    get followed() {
      return followed;
    },
    get disposed() {
      return disposed;
    },
    hasModel(assetId) {
      return allowed === null ? assetId.length > 0 : allowed.has(assetId);
    },
    spawnModel(assetId) {
      requireAlive();
      requireModel(assetId);
      record("spawnModel", assetId);
      return createActor();
    },
    spawnInstances(assetId, count) {
      requireAlive();
      requireModel(assetId);
      if (count > capabilities.maxInstances) {
        throw new WorldError(
          "E_WORLD_LIMIT",
          `Instance count ${count} exceeds the fake limit ${capabilities.maxInstances}.`,
        );
      }
      record("spawnInstances", assetId, count);
      const handle: WorldInstances = {
        count,
        setTransform(index, x, y, z, yaw, scale) {
          record("setInstanceTransform", index, x, y, z, yaw, scale);
        },
        setVisible(index, visible) {
          record("setInstanceVisible", index, visible);
        },
        setTintAt(index, color) {
          record("setInstanceTint", index, color);
        },
        dispose() {
          record("disposeInstances");
        },
      };
      instanceHandles.push(handle);
      return handle;
    },
    createPrimitive(kind: PrimitiveKind, opts?: PrimitiveOptions) {
      requireAlive();
      record("createPrimitive", kind, opts);
      return createActor();
    },
    setSun(direction, color, intensity) {
      record("setSun", direction, color, intensity);
    },
    setAmbient(color, intensity) {
      record("setAmbient", color, intensity);
    },
    setFog(color, near, far) {
      record("setFog", color, near, far);
    },
    setSky(preset: SkyPreset) {
      record("setSky", preset);
    },
    setSkyTexture(assetId) {
      record("setSkyTexture", assetId);
    },
    setShadowTier(tier: ShadowTier) {
      record("setShadowTier", tier);
    },
    setPost(opts: PostOptions) {
      record("setPost", opts);
    },
    setCamera(position, target, fovDegrees) {
      record("setCamera", position, target, fovDegrees);
      camera = {
        x: position.x,
        y: position.y,
        z: position.z,
        tx: target.x,
        ty: target.y,
        tz: target.z,
        fov: fovDegrees ?? 60,
      };
    },
    follow(actor: WorldActor, opts?: FollowOptions) {
      record("follow", actor.id, opts);
      followed = actor as FakeActor;
    },
    clearFollow() {
      record("clearFollow");
      followed = null;
    },
    update(dtSeconds: number) {
      requireAlive();
      record("update", dtSeconds);
      for (const actor of actors) {
        if (actor.alive && actor.currentClip !== null) {
          actor.clipTime += dtSeconds;
        }
      }
    },
    dispose() {
      if (disposed) return;
      record("dispose");
      disposed = true;
      followed = null;
    },
  };

  return world;
}

/** One fake controller; all fields default to disconnected/zero. */
export function createFakePlayer(
  slot: number,
  overrides: Partial<GameControllerState> = {},
): GameControllerState {
  return {
    slot,
    connected: true,
    buttons: 0,
    edges: 0,
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
    gyro: { x: 0, y: 0, z: 0 },
    gyroActive: false,
    gyroRecentered: false,
    triggers: { lt: 0, rt: 0 },
    tick: 0,
    ...overrides,
  };
}

export interface FakeInput extends GameInputReader {
  /** Replace the snapshot for the next tick. */
  setPlayers(players: readonly GameControllerState[]): void;
  pushEvent(slot: number, name: string, data: JsonValue): void;
}

export function createFakeInput(
  players?: readonly GameControllerState[],
): FakeInput {
  let list = players?.slice() ?? [createFakePlayer(1)];
  const events: { slot: number; name: string; data: JsonValue }[] = [];
  const snapshot = (): GameInputSnapshot => ({ tick: 0, players: list });
  return {
    get snapshot() {
      return snapshot();
    },
    poll() {
      return snapshot();
    },
    player(slot: number) {
      return list.find((player) => player.slot === slot);
    },
    events() {
      return events;
    },
    setPlayers(next) {
      list = next.slice();
    },
    pushEvent(slot, name, data) {
      events.push({ slot, name, data });
    },
  };
}

export interface FakeAudio extends GameAudio {
  readonly sfx: string[];
  readonly music: string[];
  readonly stopped: number;
}

export function createFakeAudio(): FakeAudio {
  const sfx: string[] = [];
  const music: string[] = [];
  let stopped = 0;
  let clock = 0;
  return {
    get sfx() {
      return sfx;
    },
    get music() {
      return music;
    },
    get stopped() {
      return stopped;
    },
    playSfx(id: string) {
      sfx.push(id);
    },
    playMusic(id: string) {
      music.push(id);
    },
    stopMusic() {
      stopped += 1;
    },
    now() {
      clock += 1 / 60;
      return clock;
    },
    unlocked: true,
    latencyHint: "interactive",
  };
}

export interface FakeAssets extends AssetLibrary {
  readonly requests: string[];
}

export function createFakeAssets(
  values: Readonly<Record<string, unknown>> = {},
): FakeAssets {
  const requests: string[] = [];
  const handles = new Map<string, AssetHandle>();
  const makeHandle = (id: string): AssetHandle => {
    const existing = handles.get(id);
    if (existing !== undefined) return existing;
    const handle: AssetHandle = {
      id,
      kind: "json",
      state: id in values ? "ready" : "failed",
      get value() {
        if (!(id in values)) throw new Error(`Asset "${id}" is not ready.`);
        return values[id];
      },
      retain() {
        return handle;
      },
      release() {},
      failed:
        id in values
          ? null
          : {
              id,
              code: "E_ASSET_MISSING",
              message: `Missing "${id}"`,
              retryable: false,
            },
    };
    handles.set(id, handle);
    return handle;
  };
  const progress: AssetProgress = {
    fetched: 0,
    declared: 0,
    determinate: true,
    state: "idle",
    loadedCount: 0,
    totalCount: 0,
    currentId: null,
  };
  return {
    get requests() {
      return requests;
    },
    load<T>(id: string): Promise<AssetHandle<T>> {
      requests.push(id);
      return Promise.resolve(makeHandle(id) as AssetHandle<T>);
    },
    get<T>(id: string): AssetHandle<T> | undefined {
      return handles.get(id) as AssetHandle<T> | undefined;
    },
    loadedBytes: 0,
    budgetBytes: 5 * 1024 * 1024,
    progress,
    dispose() {},
  };
}

export function createFakeContext(
  overrides: Partial<GameContext> = {},
): GameContext {
  const players = overrides.input?.snapshot.players;
  const input = createFakeInput(
    players === undefined ? undefined : Array.from(players),
  );
  const audio = createFakeAudio();
  const renderer: GameRenderer3D = {
    backend: "canvas2d",
    beginFrame() {},
    endFrame() {},
    drawCalls: 0,
    textureMemoryMB: 0,
    setCamera() {},
    drawCube() {},
  };
  let seed = 1;
  const rng: GameRng = {
    seed: 1,
    next() {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    },
    int(min, max) {
      return min + Math.floor(this.next() * (max - min + 1));
    },
  };
  const debug: GameDebug = {
    enabled: false,
    setCounter() {},
  };
  const panels: GamePanels = {
    set() {},
    show() {},
    clear() {},
  };
  const layouts: GameLayouts = {
    set() {},
    clear() {},
  };
  const haptics: GameHaptics = {
    pulse() {},
  };
  const events: GameEvents = {
    on() {
      return () => {};
    },
    onAny() {
      return () => {};
    },
  };
  const manifest: GameManifest = {
    schemaVersion: 1,
    name: "Fake Game",
    description: "Headless test manifest.",
    entry: "index.js",
    layouts: [],
    assetBudget: { initialBytes: 4096, totalBytes: 65536 },
    minPlayers: 1,
    maxPlayers: 8,
    needsGyro: false,
  };
  return {
    manifest,
    input,
    renderer,
    audio,
    rng,
    debug,
    panels,
    layouts,
    haptics,
    events,
    serverNow: () => 0,
    ...overrides,
  };
}
