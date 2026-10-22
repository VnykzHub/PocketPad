/**
 * Coin Run camera (GAME-PF-05; FR-9.4, PR-9.1, PR-9.3).
 *
 * A fixed 18-world-unit vertical view with no vertical scrolling. The
 * horizontal view width follows the host surface aspect ratio, so a 16:9 TV
 * shows 32 world units and a narrow surface shows fewer. The camera follows
 * the mean x of active players with a 2-unit deadzone and exponential
 * smoothing, clamped to the level bounds; it never reads
 * `devicePixelRatio` and never contains a pixel constant.
 *
 * Everything is plain data and allocation-free after setup: `updateCamera`
 * walks the caller's player array once and writes into `CameraState`.
 */

/** World units visible vertically. The level is exactly this tall. */
export const CAMERA_VIEW_HEIGHT = 18;

/** Horizontal deadzone in world units before the camera starts moving. */
export const CAMERA_DEADZONE = 2;

/** Exponential smoothing rate, per second (higher follows faster). */
export const CAMERA_SMOOTHING = 12;

/**
 * Fallback surface aspect when a renderer does not expose its size. The host
 * TV profile is 16:9; this is a fallback, not a fixed pixel size. The real
 * surface size is feature-detected in `render.ts`.
 */
export const CAMERA_FALLBACK_ASPECT = 16 / 9;

/** Mutable camera state, owned by the game and reused every frame. */
export interface CameraState {
  /** Centre x in world units. */
  x: number;
  /** Committed target x after deadzone + clamp. */
  targetX: number;
  /** World units visible horizontally (`viewHeight * aspect`). */
  viewWidth: number;
  /** World units visible vertically; fixed at 18. */
  readonly viewHeight: number;
  /** Level width in world units. */
  levelWidth: number;
  /** False until the first `updateCamera` snap; smoothing starts after it. */
  initialized: boolean;
}

/** The camera only reads position and presence from a player. */
export interface CameraTarget {
  /** World x of the player centre. */
  readonly x: number;
  /** True while the player's body is simulated (not falling/respawning). */
  readonly active: boolean;
  /** True while the controller is connected. */
  readonly connected: boolean;
}

/** Clamp helper; `min > max` is resolved to the level centre. */
function clampCentre(x: number, viewWidth: number, levelWidth: number): number {
  if (levelWidth <= viewWidth) {
    return levelWidth / 2;
  }
  const min = viewWidth / 2;
  const max = levelWidth - viewWidth / 2;
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

/** World units visible horizontally for a surface aspect ratio. */
export function viewWidthForAspect(aspect: number): number {
  const safe = Number.isFinite(aspect) && aspect > 0 ? aspect : CAMERA_FALLBACK_ASPECT;
  return CAMERA_VIEW_HEIGHT * safe;
}

/**
 * Creates a camera for a level. `aspect` comes from the host surface size;
 * the default is the 16:9 TV profile.
 */
export function createCamera(
  levelWidth: number,
  aspect: number = CAMERA_FALLBACK_ASPECT,
): CameraState {
  const width = Number.isFinite(levelWidth) && levelWidth > 0 ? levelWidth : 1;
  const viewWidth = viewWidthForAspect(aspect);
  return {
    x: clampCentre(width / 2, viewWidth, width),
    targetX: clampCentre(width / 2, viewWidth, width),
    viewWidth,
    viewHeight: CAMERA_VIEW_HEIGHT,
    levelWidth: width,
    initialized: false,
  };
}

/**
 * Recomputes the horizontal view on resize and clamps the camera so the level
 * does not show outside its bounds. No pixels, no DPR.
 */
export function resizeCamera(camera: CameraState, aspect: number): void {
  camera.viewWidth = viewWidthForAspect(aspect);
  const clamped = clampCentre(camera.x, camera.viewWidth, camera.levelWidth);
  camera.x = clamped;
  camera.targetX = clamped;
}

/**
 * Moves the camera toward the mean x of active players.
 *
 * Deadzone: the target only changes when the clamped mean is more than
 * `CAMERA_DEADZONE` units from the camera. Smoothing: the camera approaches
 * the target with `1 - exp(-CAMERA_SMOOTHING * dt)`.
 *
 * @param players player views; only `active && connected` players count
 * @param count number of entries in `players` to read (no `slice`/`filter`)
 */
export function updateCamera(
  camera: CameraState,
  dt: number,
  players: ReadonlyArray<CameraTarget>,
  count: number = players.length,
): void {
  let sum = 0;
  let active = 0;
  const limit = count < players.length ? count : players.length;
  for (let index = 0; index < limit; index += 1) {
    const player = players[index];
    if (player === undefined) continue;
    if (!player.active || !player.connected) continue;
    sum += player.x;
    active += 1;
  }

  if (active > 0) {
    const mean = clampCentre(sum / active, camera.viewWidth, camera.levelWidth);
    if (!camera.initialized) {
      camera.x = mean;
      camera.targetX = mean;
      camera.initialized = true;
    } else if (Math.abs(mean - camera.x) > CAMERA_DEADZONE) {
      camera.targetX = mean;
    }
  } else if (!camera.initialized) {
    camera.initialized = true;
  }

  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  if (step > 0) {
    const blend = 1 - Math.exp(-CAMERA_SMOOTHING * step);
    camera.x += (camera.targetX - camera.x) * blend;
  }
  camera.x = clampCentre(camera.x, camera.viewWidth, camera.levelWidth);
}

/** Left edge of the visible world rectangle. */
export function cameraLeft(camera: CameraState): number {
  return camera.x - camera.viewWidth / 2;
}

/** Right edge of the visible world rectangle. */
export function cameraRight(camera: CameraState): number {
  return camera.x + camera.viewWidth / 2;
}

/** World-units-to-pixels scale for a surface height. Uniform on both axes. */
export function cameraScale(camera: CameraState, surfaceHeight: number): number {
  const safeHeight = Number.isFinite(surfaceHeight) && surfaceHeight > 0 ? surfaceHeight : 1;
  return safeHeight / camera.viewHeight;
}

/** Screen point written in place by `worldToScreen` (no allocation). */
export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Projects a world point to surface pixels. `out` is caller-owned so render
 * loops allocate nothing.
 */
export function worldToScreen(
  camera: CameraState,
  worldX: number,
  worldY: number,
  surfaceHeight: number,
  out: ScreenPoint,
): ScreenPoint {
  const scale = cameraScale(camera, surfaceHeight);
  out.x = (worldX - cameraLeft(camera)) * scale;
  out.y = worldY * scale;
  return out;
}

/**
 * True when a world-space circle or box overlaps the visible horizontal band.
 * Vertical culling is unnecessary: the view is exactly the level height.
 */
export function isHorizontallyVisible(
  camera: CameraState,
  x: number,
  halfWidth: number,
): boolean {
  const margin = halfWidth > 0 ? halfWidth : 0;
  return x + margin >= cameraLeft(camera) && x - margin <= cameraRight(camera);
}
