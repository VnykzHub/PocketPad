/**
 * Engine Cube host adapter (M1 3D path).
 *
 * This is the module `loadGame` imports from `game.manifest.json`: a default
 * `(manifest) => Game` factory. It consumes `GameContext` only (FR-7.17) and
 * draws exclusively through the 3D surface (`setCamera`, `beginFrame`,
 * `drawCube`, `endFrame`). The host selects the renderer from the manifest's
 * `"renderer": "engine"`; this game never names a backend.
 *
 * Scene: one large cube in the middle and two smaller satellites orbiting it.
 * The left stick orbits the camera, the A button boosts the spin. Every vector
 * and angle is preallocated; `simulate` and `render` allocate nothing.
 */
import type {
  Game,
  GameContext,
  GameControllerState,
  GameInputSnapshot,
  GameManifest,
  Vec3,
} from "@lanpad/sdk";

/** Layout document id shipped in `layouts/` (GAME-EC-01). */
export const EC_LAYOUT_ID = "ec-default-v1";

/** Manifest player cap this scene is authored for. */
export const EC_MAX_PLAYERS = 2;

/** Cube colors, one per scene slot; index 0 is the centre cube. */
const CUBE_COLORS = ["#6ee7ff", "#ffd166", "#ff6b9d"] as const;

/** Cube sizes in world units, matching `CUBE_COLORS`. */
const CUBE_SIZES = [1.4, 0.7, 0.55] as const;

/** Orbit radii for the two satellite cubes. */
const ORBIT_RADII = [2.1, 2.8] as const;

/** Radians per second of idle yaw. */
const SPIN_SPEED = 0.9;

/** Multiplier applied to every spin while the boost button is held. */
const BOOST_MULTIPLIER = 2.5;

/** Orbit speed of the satellites, radians per second. */
const SATELLITE_SPEED = 0.7;

/** Camera framing (matches the M0 cube experiment). */
const CAMERA_RADIUS = 5.2;
const CAMERA_HEIGHT = 2.6;
const CAMERA_YAW = 0.6;
const CAMERA_TARGET_Y = 0.9;
const CAMERA_ORBIT_GAIN = 0.8;
const CAMERA_ORBIT_SMOOTHING = 4;

/** The boost button bit exposed by `ec-default-v1`. */
const BOOST_BUTTON_MASK = 0x0001;

/** Mutable per-cube state; one instance per scene cube, reused forever. */
interface CubeState {
  yaw: number;
  phase: number;
}

/** True for a controller slot this scene can drive (FR-8.2). */
function isConnectedSlot(
  player: GameControllerState,
  maxPlayers: number,
): boolean {
  return (
    player.connected &&
    Number.isInteger(player.slot) &&
    player.slot >= 1 &&
    player.slot <= maxPlayers
  );
}

function countBits(mask: number): number {
  let value = mask;
  let count = 0;
  while (value !== 0) {
    value &= value - 1;
    count += 1;
  }
  return count;
}

/**
 * Creates the Engine Cube `Game`. The default export is the frozen `GameModule`
 * shape; named export exists for tests.
 */
export function createEngineCubeGame(manifest: GameManifest): Game {
  const maxPlayers = Math.max(1, Math.min(manifest.maxPlayers, EC_MAX_PLAYERS));

  let ctx: GameContext | null = null;
  let disposed = false;
  let orbitOffset = 0;
  let orbitTarget = 0;
  let seenMask = 0;
  let connectedMask = 0;
  let boost = false;

  const cubes: CubeState[] = [
    { yaw: 0, phase: 0 },
    { yaw: 0, phase: 0 },
    { yaw: 0, phase: Math.PI },
  ];
  /** Reused draw arguments; mutated in place every frame. */
  const positions: Vec3[] = [
    { x: 0, y: 1.1, z: 0 },
    { x: 0, y: 0.9, z: 0 },
    { x: 0, y: 0.9, z: 0 },
  ];
  const cameraPosition: Vec3 = { x: 0, y: CAMERA_HEIGHT, z: CAMERA_RADIUS };
  const cameraTarget: Vec3 = { x: 0, y: CAMERA_TARGET_Y, z: 0 };

  function applyLayout(slot: number): void {
    const layouts = ctx?.layouts;
    if (layouts === undefined) return;
    try {
      layouts.set(slot, EC_LAYOUT_ID);
    } catch {
      // A missing layout API must never stop the scene (D5 seam).
    }
  }

  function clearLayout(slot: number): void {
    const layouts = ctx?.layouts;
    if (layouts === undefined) return;
    try {
      layouts.clear(slot);
    } catch {
      // Same as applyLayout: presentation only.
    }
  }

  /** One layout request per connection edge, one clear per disconnect. */
  function observePlayers(input: GameInputSnapshot): void {
    const players = input.players;
    let presentMask = 0;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (player === undefined || !isConnectedSlot(player, maxPlayers)) continue;
      const bit = 1 << player.slot;
      if ((presentMask & bit) !== 0) continue;
      presentMask |= bit;
      if ((seenMask & bit) !== 0) continue;
      seenMask |= bit;
      applyLayout(player.slot);
    }

    let gone = seenMask & ~presentMask;
    while (gone !== 0) {
      const bit = gone & -gone;
      gone &= gone - 1;
      const slot = 31 - Math.clz32(bit);
      seenMask &= ~bit;
      clearLayout(slot);
    }
    connectedMask = presentMask;
  }

  /**
   * Reads the first connected slot's left stick and boost state. `buttons`
   * carries held state, so boost stays on while the button is down.
   */
  function readControls(input: GameInputSnapshot): void {
    const players = input.players;
    let stick = 0;
    let pressed = false;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (player === undefined || !isConnectedSlot(player, maxPlayers)) continue;
      if (index === 0) stick = player.lx;
      if ((player.buttons & BOOST_BUTTON_MASK) !== 0) pressed = true;
    }
    orbitTarget = Math.max(-1, Math.min(1, stick)) * CAMERA_ORBIT_GAIN;
    boost = pressed;
  }

  const game: Game = {
    manifest,

    init(context: GameContext): void {
      ctx = context;
      disposed = false;
      orbitOffset = 0;
      orbitTarget = 0;
      seenMask = 0;
      connectedMask = 0;
      boost = false;
      for (let index = 0; index < cubes.length; index += 1) {
        const cube = cubes[index];
        if (cube === undefined) continue;
        cube.yaw = index * 0.4;
        cube.phase = index === 2 ? Math.PI : 0;
      }
    },

    simulate(dt: number, input: GameInputSnapshot): void {
      if (disposed || ctx === null) return;
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

      observePlayers(input);
      readControls(input);

      const smoothing = Math.min(1, step * CAMERA_ORBIT_SMOOTHING);
      orbitOffset += (orbitTarget - orbitOffset) * smoothing;

      const spin = step * SPIN_SPEED * (boost ? BOOST_MULTIPLIER : 1);
      for (let index = 0; index < cubes.length; index += 1) {
        const cube = cubes[index];
        if (cube === undefined) continue;
        cube.yaw = (cube.yaw + spin * (index % 2 === 0 ? 1 : -1)) % (Math.PI * 2);
        if (index > 0) {
          cube.phase = (cube.phase + step * SATELLITE_SPEED) % (Math.PI * 2);
        }
      }

      ctx.debug.setCounter("players", countBits(connectedMask));
      ctx.debug.setCounter("spin", Math.round(cubes[0]?.yaw ?? 0));
    },

    render(alpha: number): void {
      const context = ctx;
      if (disposed || context === null) return;

      const yaw = CAMERA_YAW + orbitOffset;
      cameraPosition.x = Math.sin(yaw) * CAMERA_RADIUS;
      cameraPosition.z = Math.cos(yaw) * CAMERA_RADIUS;
      cameraPosition.y = CAMERA_HEIGHT;
      cameraTarget.x = 0;
      cameraTarget.y = CAMERA_TARGET_Y;
      cameraTarget.z = 0;

      context.renderer.setCamera(cameraPosition, cameraTarget);
      context.renderer.beginFrame(alpha);

      const centre = positions[0];
      if (centre !== undefined) {
        centre.x = 0;
        centre.y = 1.1;
        centre.z = 0;
        context.renderer.drawCube(
          centre,
          CUBE_SIZES[0],
          CUBE_COLORS[0],
          cubes[0]?.yaw ?? 0,
        );
      }

      for (let index = 1; index < cubes.length; index += 1) {
        const cube = cubes[index];
        const position = positions[index];
        if (cube === undefined || position === undefined) continue;
        const radius = ORBIT_RADII[index - 1] ?? 0;
        position.x = Math.sin(cube.phase) * radius;
        position.z = Math.cos(cube.phase) * radius;
        position.y = 0.9 + Math.sin(cube.phase * 1.7) * 0.25;
        context.renderer.drawCube(
          position,
          CUBE_SIZES[index] ?? 0,
          CUBE_COLORS[index] ?? CUBE_COLORS[0],
          cube.yaw,
        );
      }

      context.renderer.endFrame();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      ctx = null;
      seenMask = 0;
      connectedMask = 0;
      boost = false;
    },
  };

  return game;
}

/** Frozen `GameModule` shape consumed by `loadGame`. */
export default createEngineCubeGame;
