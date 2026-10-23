/**
 * Static evidence harness for the console shell (spec 25; stream D).
 *
 * Loads the real `ConsoleShell` from `packages/runtime/src/ui/console/` with
 * synthetic fixture manifests, so the launcher can be screenshotted at
 * 1920x1080 without the host app, a room or a game. It is not product code.
 *
 * Query parameters:
 *   scene=start|four|thirteen|empty|lobby   which fixture set to mount
 *   motion=reduced                          force the reduced motion tier
 *   qr=1                                    open the join-QR panel
 *   toolbar=1                               show the scene navigation links
 *
 * The join URL below is a local fake whose fragment is obviously not a token;
 * as in the product, it is only ever passed to the QR renderer. Loading-screen
 * bytes shown after "Play" are synthetic demo values, not a measurement.
 */
import QRCode from "qrcode";
import "../../packages/runtime/src/ui/console/console.css";
import { ConsoleShell } from "../../packages/runtime/src/ui/console/shell.js";
import type {
  ConsoleGame,
  ConsolePlayerInput,
  ConsoleRoomInfo,
} from "../../packages/runtime/src/ui/console/types.js";
import {
  EIGHT_PLAYERS,
  FIXTURE_CONNECTION,
  FIXTURE_JOIN_URL,
  FIXTURE_NOW,
  FIXTURE_ROOM,
  FOUR_GAMES,
  THIRTEEN_GAMES,
} from "./fixtures.js";

type SceneName = "start" | "four" | "thirteen" | "empty" | "lobby";

interface SceneData {
  readonly games: readonly ConsoleGame[];
  readonly players: readonly ConsolePlayerInput[];
  readonly startGate: boolean;
}

const SCENES: Record<SceneName, SceneData> = {
  start: {
    games: FOUR_GAMES,
    players: EIGHT_PLAYERS.slice(0, 2),
    startGate: true,
  },
  four: {
    games: FOUR_GAMES,
    players: EIGHT_PLAYERS.slice(0, 2),
    startGate: false,
  },
  thirteen: {
    games: THIRTEEN_GAMES,
    players: EIGHT_PLAYERS.slice(0, 3),
    startGate: false,
  },
  empty: { games: [], players: [], startGate: false },
  lobby: { games: FOUR_GAMES, players: EIGHT_PLAYERS, startGate: false },
};

function readScene(value: string | null): SceneName {
  if (
    value === "start" ||
    value === "four" ||
    value === "thirteen" ||
    value === "empty" ||
    value === "lobby"
  ) {
    return value;
  }
  return "four";
}

const params = new URLSearchParams(window.location.search);
const sceneName = readScene(params.get("scene"));
const scene = SCENES[sceneName];
const reducedMotion = params.get("motion") === "reduced";
const openQr = params.get("qr") === "1";
const showToolbar = params.get("toolbar") === "1";

const app = document.querySelector<HTMLElement>("#app");
if (app === null) throw new Error("console-launcher evidence: #app is missing");

const room: ConsoleRoomInfo = {
  code: FIXTURE_ROOM.code,
  pin: FIXTURE_ROOM.pin,
  joinUrl: FIXTURE_JOIN_URL,
};

const shell: ConsoleShell = new ConsoleShell(document, {
  games: scene.games,
  players: scene.players,
  room,
  connection: FIXTURE_CONNECTION,
  skipStartGate: !scene.startGate,
  prefersReducedMotion: reducedMotion,
  now: () => FIXTURE_NOW,
  scheduleClock: (tick) => window.setInterval(tick, 60_000),
  cancelClock: (handle) => window.clearInterval(handle as number),
  renderQr: (canvas, joinUrl) =>
    QRCode.toCanvas(canvas, joinUrl, { width: 384, margin: 1 }),
  onLaunch: () => {
    // Synthetic progress so the loading screen is inspectable in a screenshot;
    // this is a fixture value, not a measured asset budget.
    shell.setLoadingProgress({
      loadedBytes: 12_400_000,
      totalBytes: 18_600_000,
      determinate: true,
      fraction: 12_400_000 / 18_600_000,
      loadedCount: 3,
      totalCount: 7,
      currentUrl: null,
      done: false,
    });
  },
});

shell.mount(app);
document.body.dataset["scene"] = sceneName;

if (openQr) shell.topBar.setQrOpen(true);

const toolbar = document.querySelector<HTMLElement>("#toolbar");
if (toolbar !== null) toolbar.hidden = !showToolbar;
