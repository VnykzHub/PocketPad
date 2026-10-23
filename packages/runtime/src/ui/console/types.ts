/**
 * Console shell shared types (spec 25; stream D).
 *
 * The shell reads `GameManifest.presentation` through `ConsoleGame`; it never
 * knows a game slug except through the data the host hands it. `debugOnly` is
 * a host-side product flag (Engine Cube), not a manifest field.
 */
import type { GamePresentation } from "@lanpad/sdk";

/** One home-screen tile source, derived from a game manifest by the host. */
export interface ConsoleGame {
  readonly slug: string;
  readonly name: string;
  /** Manifest `description`; the launcher shows it only when present. */
  readonly description?: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  /** Additive manifest metadata (spec 25 §1); absent means generated art. */
  readonly presentation?: GamePresentation;
  /** Tech demos shown only with `?debug=1`. */
  readonly debugOnly?: boolean;
}

/** Identity shapes from DESIGN.md `--player-*` tokens / game-kit identity. */
export type PlayerShape = "circle" | "triangle" | "square" | "diamond";

/** Presence of a controller slot. */
export type PlayerPresence = "connected" | "reconnecting" | "open";

/**
 * What the host knows about a player. Identity fields are optional so a simple
 * caller can pass `{ slot }` and still get the DESIGN colour, label and shape.
 */
export interface ConsolePlayerInput {
  readonly slot: number;
  readonly label?: string;
  readonly color?: string;
  readonly shape?: PlayerShape;
  readonly state?: PlayerPresence;
}

/** A fully resolved player row; state never relies on colour alone. */
export interface ConsolePlayer {
  readonly slot: number;
  readonly label: string;
  readonly color: string;
  readonly shape: PlayerShape;
  readonly state: PlayerPresence;
}

/** Motion tier from DESIGN.md's console-shell amendment (D3). */
export type MotionTier = "full" | "reduced";

/** Which control surface last drove the launcher; selects the hint line. */
export type InputMode = "keyboard" | "gamepad" | "remote";

/** Normalized launcher actions shared by every input source (ER-25-04). */
export type ConsoleAction =
  | "prev"
  | "next"
  | "first"
  | "last"
  | "confirm"
  | "back";

/** Connection pill content; `tone` decorates, the text carries the state. */
export interface ConsoleConnection {
  readonly text: string;
  readonly tone: "ok" | "pending" | "bad";
}

/** Room credentials and the token-safe QR source. */
export interface ConsoleRoomInfo {
  readonly code: string | null;
  readonly pin: string | null;
  /** `<origin>/c/<CODE>#<token>`; only ever passed to the QR renderer. */
  readonly joinUrl?: string | null;
}
