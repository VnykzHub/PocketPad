/**
 * Console game row (spec 25 §2.2; DESIGN.md console-shell tier).
 *
 * A horizontal shelf of real `<button>` tiles. Exactly one tile is active: it
 * is the only tab stop (roving `tabIndex`), it alone reveals tagline, player
 * range, input badges and the Play affordance, and it is the only tile that
 * accepts parallax. Everything is derived from `GameManifest.presentation`;
 * a missing presentation still yields a deterministic gradient and monogram.
 *
 * Focus changes are synchronous. The full tier may scale the focused tile and
 * move it up to 8px with the pointer; the reduced tier pins focus instantly
 * and ignores parallax. Neither tier delays a key, a click or a gamepad action.
 */
import {
  inputBadgeLabel,
  monogramFor,
  playerRangeLabel,
  presentationAccent,
  presentationBadges,
  presentationGradient,
  presentationTagline,
  sortConsoleGames,
} from "./presentation.js";
import type { ConsoleGame, MotionTier } from "./types.js";

export const ROW_HEADING = "Games";
export const EMPTY_ROW_TITLE = "No games installed";
export const EMPTY_ROW_HINT = "Add a game folder, then reload the host.";
export const PLAY_LABEL = "Play";
export const MAX_PARALLAX_PX = 8;

/**
 * Thumbnails are optional manifest art. Only a root-relative path or a base64
 * image data URL is accepted, so the value can never break out of `url("…")`.
 * A rejected thumbnail simply leaves the generated gradient visible.
 */
const SAFE_THUMBNAIL =
  /^(?:\/[A-Za-z0-9/._~%:@+=-]*|data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+)$/;

export interface ConsoleGameRowOptions {
  readonly games: readonly ConsoleGame[];
  readonly motion?: MotionTier;
  readonly onActivate?: (game: ConsoleGame) => void;
  readonly onFocusChange?: (game: ConsoleGame) => void;
}

interface TileBinding {
  readonly game: ConsoleGame;
  readonly slot: HTMLElement;
  readonly element: HTMLButtonElement;
  readonly art: HTMLElement;
  readonly details: HTMLElement;
  readonly handleClick: () => void;
  readonly handleFocus: () => void;
}

export class ConsoleGameRow {
  readonly element: HTMLElement;
  readonly track: HTMLElement;
  readonly emptyState: HTMLElement;

  private readonly doc: Document;
  private readonly motion: MotionTier;
  private readonly games: readonly ConsoleGame[];
  private readonly onActivate: ((game: ConsoleGame) => void) | undefined;
  private readonly onFocusChange: ((game: ConsoleGame) => void) | undefined;
  private readonly tiles: TileBinding[] = [];
  private activeIndex = 0;
  private parallaxX = 0;
  private parallaxY = 0;
  private destroyed = false;

  constructor(doc: Document, options: ConsoleGameRowOptions) {
    this.doc = doc;
    this.motion = options.motion ?? "full";
    this.onActivate = options.onActivate;
    this.onFocusChange = options.onFocusChange;
    this.games = sortConsoleGames(options.games);

    const root = doc.createElement("section");
    root.className = "console-row";
    root.dataset["motion"] = this.motion;
    root.setAttribute("aria-labelledby", "console-row-title");

    const head = doc.createElement("div");
    head.className = "console-row__head";
    const heading = doc.createElement("h2");
    heading.id = "console-row-title";
    heading.className = "console-row__title";
    heading.textContent = ROW_HEADING;
    const count = doc.createElement("p");
    count.className = "console-row__count";
    count.textContent =
      this.games.length === 1 ? "1 game" : `${this.games.length} games`;
    head.append(heading, count);

    this.track = doc.createElement("ul");
    this.track.className = "console-row__track";
    this.track.setAttribute("aria-label", ROW_HEADING);

    for (const game of this.games) {
      this.track.append(this.createTile(game).slot);
    }

    this.emptyState = doc.createElement("div");
    this.emptyState.className = "console-row__empty";
    this.emptyState.hidden = this.games.length > 0;
    const emptyTitle = doc.createElement("h3");
    emptyTitle.className = "console-row__empty-title";
    emptyTitle.textContent = EMPTY_ROW_TITLE;
    const emptyHint = doc.createElement("p");
    emptyHint.className = "console-row__empty-hint";
    emptyHint.textContent = EMPTY_ROW_HINT;
    this.emptyState.append(emptyTitle, emptyHint);

    this.track.hidden = this.games.length === 0;
    root.append(head, this.track, this.emptyState);
    this.element = root;

    if (this.games.length > 0) this.applyActive(0, false);
  }

  /** Sorted games in display order. */
  get gameList(): readonly ConsoleGame[] {
    return this.games;
  }

  get focusedGame(): ConsoleGame | null {
    return this.games[this.activeIndex] ?? null;
  }

  get focusedIndex(): number {
    return this.games.length === 0 ? -1 : this.activeIndex;
  }

  /** Focuses the active tile, or the shelf when no games exist. */
  focus(): void {
    if (this.destroyed) return;
    const tile = this.tiles[this.activeIndex];
    if (tile !== undefined) {
      tile.element.focus();
      return;
    }
    if (this.element.tabIndex < 0) this.element.tabIndex = -1;
    this.element.focus();
  }

  /** Moves by `delta` with wrap-around at both ends. */
  move(delta: number): void {
    if (this.destroyed || this.games.length === 0 || delta === 0) return;
    const next =
      (((this.activeIndex + delta) % this.games.length) + this.games.length) %
      this.games.length;
    this.focusIndex(next);
  }

  focusFirst(): void {
    if (this.games.length > 0) this.focusIndex(0);
  }

  focusLast(): void {
    if (this.games.length > 0) this.focusIndex(this.games.length - 1);
  }

  /** Activates and focuses index `index` (the roving tab stop moves with it). */
  focusIndex(index: number): boolean {
    if (this.destroyed || this.games.length === 0) return false;
    if (!Number.isInteger(index) || index < 0 || index >= this.games.length) {
      return false;
    }
    this.applyActive(index, true);
    this.tiles[index]?.element.focus();
    return true;
  }

  /** Restores the tile that was focused before a launch. */
  focusSlug(slug: string | null): boolean {
    if (slug === null) return false;
    const index = this.games.findIndex((game) => game.slug === slug);
    if (index < 0) return false;
    return this.focusIndex(index);
  }

  /** Launches the focused game; false when the shelf is empty. */
  activateActive(): boolean {
    const game = this.focusedGame;
    if (this.destroyed || game === null) return false;
    this.onActivate?.(game);
    return true;
  }

  /**
   * Pointer parallax for the focused tile, capped at 8px. The reduced tier
   * ignores it entirely; input handling never reads this value.
   */
  setParallax(x: number, y: number): void {
    if (this.destroyed) return;
    const tile = this.tiles[this.activeIndex];
    if (tile === undefined) return;
    if (this.motion === "reduced") {
      this.parallaxX = 0;
      this.parallaxY = 0;
      tile.element.style.setProperty("--parallax-x", "0px");
      tile.element.style.setProperty("--parallax-y", "0px");
      return;
    }
    this.parallaxX = clampParallax(x);
    this.parallaxY = clampParallax(y);
    tile.element.style.setProperty("--parallax-x", `${this.parallaxX}px`);
    tile.element.style.setProperty("--parallax-y", `${this.parallaxY}px`);
  }

  /** Current parallax offsets; tests use this to prove the cap. */
  get parallax(): { readonly x: number; readonly y: number } {
    return { x: this.parallaxX, y: this.parallaxY };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const tile of this.tiles) {
      tile.element.removeEventListener("click", tile.handleClick);
      tile.element.removeEventListener("focus", tile.handleFocus);
    }
    this.tiles.length = 0;
    this.element.remove();
  }

  private createTile(game: ConsoleGame): TileBinding {
    const doc = this.doc;
    const accent = presentationAccent(game);
    const slot = doc.createElement("li");
    slot.className = "console-tile-slot";

    const element = doc.createElement("button");
    element.setAttribute("type", "button");
    element.className = "console-tile";
    element.dataset["slug"] = game.slug;
    element.dataset["consoleTile"] = "true";
    element.dataset["active"] = "false";
    element.tabIndex = -1;
    element.style.setProperty("--tile-accent", accent);

    const art = doc.createElement("span");
    art.className = "console-tile__art";
    art.setAttribute("aria-hidden", "true");
    art.dataset["art"] = "generated";
    art.style.setProperty("background", presentationGradient(game));
    const thumbnail = game.presentation?.thumbnail;
    if (thumbnail !== undefined && SAFE_THUMBNAIL.test(thumbnail)) {
      const image = doc.createElement("span");
      image.className = "console-tile__image";
      image.style.setProperty("background-image", `url("${thumbnail}")`);
      art.append(image);
      art.dataset["art"] = "image";
    }
    const monogram = doc.createElement("span");
    monogram.className = "console-tile__monogram";
    monogram.textContent = monogramFor(game.name);
    art.append(monogram);

    const body = doc.createElement("span");
    body.className = "console-tile__body";
    const title = doc.createElement("span");
    title.className = "console-tile__title";
    title.textContent = game.name;

    const details = doc.createElement("span");
    details.className = "console-tile__details";
    details.hidden = true;

    const tagline = presentationTagline(game);
    if (tagline !== null) {
      const taglineEl = doc.createElement("span");
      taglineEl.className = "console-tile__tagline";
      taglineEl.textContent = tagline;
      details.append(taglineEl);
    }

    const range = doc.createElement("span");
    range.className = "console-tile__range";
    range.textContent = playerRangeLabel(game.minPlayers, game.maxPlayers);
    details.append(range);

    const badges = presentationBadges(game);
    if (badges.length > 0) {
      const badgeList = doc.createElement("span");
      badgeList.className = "console-tile__badges";
      for (const badge of badges) {
        const badgeEl = doc.createElement("span");
        badgeEl.className = "console-badge";
        badgeEl.textContent = inputBadgeLabel(badge);
        badgeList.append(badgeEl);
      }
      details.append(badgeList);
    }

    const play = doc.createElement("span");
    play.className = "console-tile__play";
    play.setAttribute("aria-hidden", "true");
    play.textContent = PLAY_LABEL;
    details.append(play);

    body.append(title, details);
    element.append(art, body);

    // One accessible name covers the art and the details hidden off-focus.
    const parts = [game.name, playerRangeLabel(game.minPlayers, game.maxPlayers)];
    if (tagline !== null) parts.push(tagline);
    element.setAttribute("aria-label", parts.join(", "));

    const binding: TileBinding = {
      game,
      slot,
      element,
      art,
      details,
      handleClick: () => {
        if (this.destroyed) return;
        this.onActivate?.(game);
      },
      handleFocus: () => {
        if (this.destroyed) return;
        const index = this.tiles.indexOf(binding);
        if (index >= 0 && index !== this.activeIndex) {
          this.applyActive(index, true);
        }
      },
    };
    element.addEventListener("click", binding.handleClick);
    element.addEventListener("focus", binding.handleFocus);
    this.tiles.push(binding);
    slot.append(element);
    return binding;
  }

  private applyActive(index: number, notify: boolean): void {
    const previous = this.tiles[this.activeIndex];
    if (previous !== undefined) {
      previous.element.dataset["active"] = "false";
      previous.element.tabIndex = -1;
      previous.details.hidden = true;
      previous.element.style.setProperty("--parallax-x", "0px");
      previous.element.style.setProperty("--parallax-y", "0px");
    }

    this.activeIndex = index;
    const next = this.tiles[index];
    if (next === undefined) return;
    next.element.dataset["active"] = "true";
    next.element.tabIndex = 0;
    next.details.hidden = false;
    next.element.style.setProperty("--parallax-x", `${this.parallaxX}px`);
    next.element.style.setProperty("--parallax-y", `${this.parallaxY}px`);

    if (notify) this.onFocusChange?.(next.game);
  }
}

function clampParallax(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MAX_PARALLAX_PX, Math.min(MAX_PARALLAX_PX, value));
}
