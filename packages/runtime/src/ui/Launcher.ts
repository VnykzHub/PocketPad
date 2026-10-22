/**
 * Host launcher (HP-03; FR-10.3, FR-9.13, AR-4).
 *
 * The launcher lists whatever `GameEntry` records the caller supplies; it never
 * hard-codes a game menu and has no per-slug branches. Title, player range and
 * the optional description all come from the entry (which mirrors the game
 * manifest). Missing optional data becomes a neutral line instead of `undefined`
 * in the DOM.
 *
 * Remote operability (AR-4, HP-03): every card is a real `<button>`, so mouse,
 * keyboard and assistive technology share one activation path. Arrow keys move
 * focus between cards (left/up backwards, right/down forwards, wrapping at the
 * ends); Enter, Space, OK/Select and a legacy keyCode 13 launch the focused
 * card. Focus moves instantly: no transition, scale or fade.
 *
 * The component ships structure and class names only. `src/style.css` owns the
 * visuals (560x360 `--surface` cards, 20px radius, 64px "Games" heading, 24px
 * gutter, 3px `--accent` focus ring). Classes:
 * `lanpad-launcher`, `lanpad-launcher__title`, `lanpad-launcher__grid`,
 * `lanpad-launcher__card`, `lanpad-launcher__card-title`,
 * `lanpad-launcher__card-meta`, `lanpad-launcher__card-description`,
 * `lanpad-launcher__card-connected`, `lanpad-launcher__empty`,
 * `lanpad-launcher__empty-title`, `lanpad-launcher__empty-hint`.
 */
import type { GameEntry } from "../game/registry.js";

/**
 * A registry entry plus the two optional fields the host may have loaded from
 * the same manifest. The shape is additive over the frozen `GameEntry`, so a
 * plain `GameEntry[]` is always accepted.
 */
export interface LauncherGame extends Omit<GameEntry, "description"> {
  /** Game-supplied one-liner; the launcher renders a neutral line when absent. */
  readonly description?: string;
  /** Live connected count, shown only when greater than zero. */
  readonly connected?: number;
}

export interface LauncherOptions {
  /** Bundled games from `getGames()` or another registry view. */
  readonly games: ReadonlyArray<LauncherGame>;
  /** Called with the entry's slug when a card is activated. */
  readonly onLaunch: (slug: string) => void;
  /** When supplied, the launcher mounts immediately; otherwise call `mount()`. */
  readonly root?: HTMLElement;
}

export const LAUNCHER_HEADING = "Games";
export const LAUNCHER_EMPTY_TITLE = "No games installed";
export const LAUNCHER_EMPTY_HINT = "Add a game package, then restart the host.";
export const LAUNCHER_MISSING_DESCRIPTION = "No description provided.";
export const LAUNCHER_UNTITLED = "Untitled game";
export const LAUNCHER_SEARCH_LABEL = "Search games";
export const LAUNCHER_SEARCH_PLACEHOLDER = "Search games";
export const LAUNCHER_NO_MATCH = "No games match.";

export type LauncherFilter = "all" | "solo" | "duo" | "party";

export const LAUNCHER_FILTERS: ReadonlyArray<{
  readonly id: LauncherFilter;
  readonly label: string;
}> = [
  { id: "all", label: "All games" },
  { id: "solo", label: "1 player" },
  { id: "duo", label: "2–4 players" },
  { id: "party", label: "5–8 players" },
];

/** Short monogram for a card's art block; drawn, never a per-slug image. */
export function launcherInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0] ?? "");
  return letters.join("").toUpperCase() || "?";
}

/** `1–8 players`, `4 players`, or a neutral `Players` for unusable input. */
export function playerRangeLabel(minPlayers: number, maxPlayers: number): string {
  if (!Number.isFinite(minPlayers) || !Number.isFinite(maxPlayers)) {
    return "Players";
  }
  const min = Math.min(8, Math.max(1, Math.trunc(minPlayers)));
  const max = Math.min(8, Math.max(min, Math.trunc(maxPlayers)));
  if (min === max) return `${min} player${min === 1 ? "" : "s"}`;
  return `${min}–${max} players`;
}

export class Launcher {
  readonly element: HTMLElement;
  readonly searchInput: HTMLInputElement;

  private readonly doc: Document;
  private readonly onLaunch: (slug: string) => void;
  private readonly allGames: ReadonlyArray<LauncherGame>;
  private readonly cards: HTMLButtonElement[] = [];
  private readonly filterButtons: HTMLButtonElement[] = [];
  private readonly grid: HTMLElement;
  private readonly noMatch: HTMLElement;
  private activeIndex = 0;
  private activeFilter: LauncherFilter = "all";
  private query = "";
  private destroyed = false;

  constructor(doc: Document, options: LauncherOptions) {
    this.doc = doc;
    this.onLaunch = options.onLaunch;
    this.allGames = options.games;

    const section = doc.createElement("section");
    section.className = "lanpad-launcher";
    section.setAttribute("role", "region");
    section.setAttribute("aria-label", LAUNCHER_HEADING);

    const header = doc.createElement("div");
    header.className = "lanpad-launcher__header";

    const heading = doc.createElement("h1");
    heading.className = "lanpad-launcher__title";
    heading.textContent = LAUNCHER_HEADING;

    const tools = doc.createElement("div");
    tools.className = "lanpad-launcher__tools";

    this.searchInput = doc.createElement("input");
    this.searchInput.type = "search";
    this.searchInput.className = "lanpad-launcher__search";
    this.searchInput.placeholder = LAUNCHER_SEARCH_PLACEHOLDER;
    this.searchInput.setAttribute("aria-label", LAUNCHER_SEARCH_LABEL);
    this.searchInput.autocomplete = "off";
    this.searchInput.addEventListener("input", this.handleSearchInput);
    this.searchInput.addEventListener("keydown", this.handleSearchKeyDown);

    const filters = doc.createElement("div");
    filters.className = "lanpad-launcher__filters";
    filters.setAttribute("role", "group");
    filters.setAttribute("aria-label", "Filter games");
    for (const filter of LAUNCHER_FILTERS) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "lanpad-launcher__filter";
      button.dataset["filter"] = filter.id;
      button.textContent = filter.label;
      button.setAttribute(
        "aria-pressed",
        filter.id === this.activeFilter ? "true" : "false",
      );
      button.addEventListener("click", () => {
        this.setFilter(filter.id);
      });
      this.filterButtons.push(button);
      filters.append(button);
    }

    tools.append(this.searchInput, filters);
    header.append(heading, tools);
    section.append(header);

    this.grid = doc.createElement("div");
    this.grid.className = "lanpad-launcher__grid";

    this.noMatch = doc.createElement("p");
    this.noMatch.className = "lanpad-launcher__no-match";
    this.noMatch.hidden = true;
    this.noMatch.textContent = LAUNCHER_NO_MATCH;

    if (options.games.length === 0) {
      section.append(this.createEmptyState());
    } else {
      options.games.forEach((game, index) => {
        const card = this.createCard(game, index);
        this.cards.push(card);
        this.grid.append(card);
      });
      section.append(this.grid, this.noMatch);
    }

    section.addEventListener("keydown", this.handleKeyDown as EventListener);
    this.element = section;

    if (options.games.length > 0) this.applyFilter();

    if (options.root !== undefined) this.mount(options.root);
  }

  /** Appends the launcher to a host container. Safe to call more than once. */
  mount(root: HTMLElement): void {
    if (this.destroyed) return;
    root.append(this.element);
  }

  /** Moves remote focus to the first visible card; no-op in the empty state. */
  focus(): void {
    const visible = this.visibleIndexes();
    const index = visible.includes(this.activeIndex)
      ? this.activeIndex
      : visible[0];
    if (index !== undefined) this.setActive(index);
  }

  /** Removes listeners and the mounted tree. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.element.removeEventListener("keydown", this.handleKeyDown as EventListener);
    this.searchInput.removeEventListener("input", this.handleSearchInput);
    this.searchInput.removeEventListener("keydown", this.handleSearchKeyDown);
    this.element.remove();
    this.cards.length = 0;
    this.filterButtons.length = 0;
  }

  private createEmptyState(): HTMLElement {
    const empty = this.doc.createElement("div");
    empty.className = "lanpad-launcher__empty";

    const title = this.doc.createElement("p");
    title.className = "lanpad-launcher__empty-title";
    title.textContent = LAUNCHER_EMPTY_TITLE;

    const hint = this.doc.createElement("p");
    hint.className = "lanpad-launcher__empty-hint";
    hint.textContent = LAUNCHER_EMPTY_HINT;

    empty.append(title, hint);
    return empty;
  }

  private createCard(game: LauncherGame, index: number): HTMLButtonElement {
    const card = this.doc.createElement("button");
    card.setAttribute("type", "button");
    card.className = "lanpad-launcher__card";
    card.dataset["slug"] = game.slug;
    card.dataset["index"] = String(index);

    const titleText = game.name.trim();
    const displayName = titleText.length > 0 ? titleText : LAUNCHER_UNTITLED;

    const art = this.doc.createElement("span");
    art.className = "lanpad-launcher__card-art";
    art.setAttribute("aria-hidden", "true");
    art.textContent = launcherInitials(displayName);

    const title = this.doc.createElement("span");
    title.className = "lanpad-launcher__card-title";
    title.textContent = displayName;

    const meta = this.doc.createElement("span");
    meta.className = "lanpad-launcher__card-meta";
    meta.textContent = playerRangeLabel(game.minPlayers, game.maxPlayers);

    const descriptionText = game.description?.trim() ?? "";
    const description = this.doc.createElement("span");
    description.className = "lanpad-launcher__card-description";
    description.textContent =
      descriptionText.length > 0
        ? descriptionText
        : LAUNCHER_MISSING_DESCRIPTION;
    if (descriptionText.length === 0) {
      description.dataset["missing"] = "true";
    }

    card.append(art, title, meta, description);

    if (typeof game.connected === "number" && game.connected > 0) {
      const connected = this.doc.createElement("span");
      connected.className = "lanpad-launcher__card-connected";
      connected.textContent = `${Math.trunc(game.connected)} connected`;
      card.append(connected);
    }

    card.addEventListener("click", () => {
      this.activate(index);
    });
    card.addEventListener("focus", () => {
      this.activeIndex = index;
    });

    return card;
  }

  private matchesGame(game: LauncherGame): boolean {
    const query = this.query.trim().toLowerCase();
    if (query.length > 0) {
      const haystack = `${game.name} ${game.description ?? ""}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    switch (this.activeFilter) {
      case "solo":
        return game.minPlayers <= 1;
      case "duo":
        return game.minPlayers <= 4 && game.maxPlayers >= 2;
      case "party":
        return game.maxPlayers >= 5;
      default:
        return true;
    }
  }

  private visibleIndexes(): number[] {
    const visible: number[] = [];
    this.cards.forEach((card, index) => {
      if (!card.hidden) visible.push(index);
    });
    return visible;
  }

  private applyFilter(): void {
    const hadCardFocus = this.cards.some(
      (card) => card === this.doc.activeElement,
    );
    this.cards.forEach((card, index) => {
      const game = this.allGames[index];
      card.hidden = game === undefined ? true : !this.matchesGame(game);
    });

    const visible = this.visibleIndexes();
    this.noMatch.hidden = visible.length > 0;

    if (visible.length === 0) {
      this.activeIndex = -1;
      return;
    }
    if (!visible.includes(this.activeIndex)) {
      this.activeIndex = visible[0] ?? -1;
    }
    if (hadCardFocus) this.focus();
  }

  private setFilter(filter: LauncherFilter): void {
    this.activeFilter = filter;
    for (const button of this.filterButtons) {
      button.setAttribute(
        "aria-pressed",
        button.dataset["filter"] === filter ? "true" : "false",
      );
    }
    this.applyFilter();
  }

  private activate(index: number): void {
    if (this.destroyed) return;
    const card = this.cards[index];
    if (card === undefined) return;
    const slug = card.dataset["slug"];
    if (slug === undefined) return;
    this.onLaunch(slug);
  }

  private move(delta: number): void {
    const visible = this.visibleIndexes();
    if (visible.length === 0) return;
    const position = visible.indexOf(this.activeIndex);
    const next =
      position < 0
        ? 0
        : ((position + delta) % visible.length + visible.length) % visible.length;
    this.setActive(visible[next] ?? -1);
  }

  private setActive(index: number): void {
    if (index < 0 || index >= this.cards.length) return;
    const card = this.cards[index];
    if (card === undefined || card.hidden) return;
    this.activeIndex = index;
    card.focus();
    if (typeof card.scrollIntoView === "function") {
      card.scrollIntoView({ block: "nearest" });
    }
  }

  private readonly handleSearchInput = (): void => {
    this.query = this.searchInput.value;
    this.applyFilter();
  };

  private readonly handleSearchKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.focus();
      return;
    }
    if (event.key === "Escape" && this.searchInput.value.length > 0) {
      event.preventDefault();
      this.searchInput.value = "";
      this.query = "";
      this.applyFilter();
    }
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (this.destroyed || this.cards.length === 0) return;

    const target = event.target as Node | null;
    // The search field owns its own keys so typing never walks the shelf.
    if (target === this.searchInput) return;
    // Let a filter chip keep Enter/Space for its own click; down/up enters
    // the shelf so a remote can move from the tools to the games.
    if (this.filterButtons.includes(target as HTMLButtonElement)) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.focus();
      }
      return;
    }

    const key = event.key;
    const keyCode = typeof event.keyCode === "number" ? event.keyCode : 0;

    if (
      key === "ArrowRight" ||
      key === "ArrowDown" ||
      keyCode === 39 ||
      keyCode === 40
    ) {
      event.preventDefault();
      this.move(1);
      return;
    }
    if (
      key === "ArrowLeft" ||
      key === "ArrowUp" ||
      keyCode === 37 ||
      keyCode === 38
    ) {
      event.preventDefault();
      this.move(-1);
      return;
    }
    if (key === "Home" || keyCode === 36) {
      event.preventDefault();
      const visible = this.visibleIndexes();
      this.setActive(visible[0] ?? -1);
      return;
    }
    if (key === "End" || keyCode === 35) {
      event.preventDefault();
      const visible = this.visibleIndexes();
      this.setActive(visible.at(-1) ?? -1);
      return;
    }

    // "Select"/"OK" cover older TV remotes; keyCode 13 covers browsers that
    // report "Unidentified" for the remote's centre button. preventDefault
    // stops the browser also synthesising a click, so a launch happens once.
    const isActivate =
      key === "Enter" ||
      key === " " ||
      key === "Spacebar" ||
      key === "Select" ||
      key === "OK" ||
      keyCode === 13 ||
      keyCode === 32;
    if (!isActivate) return;
    event.preventDefault();
    if (event.repeat === true) return;
    this.activate(this.activeIndex);
  };
}
