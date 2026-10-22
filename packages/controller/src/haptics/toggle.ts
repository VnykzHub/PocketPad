/**
 * Per-viewer haptics preference (D6-CTRL-04; FR-8.12, AR-3).
 *
 * Haptics are optional. The toggle is on by default and persisted per viewer
 * under `localStorage["lanpad.haptics"]` as exactly "on" or "off" — no other
 * value, and no server involvement. Turning it off immediately stops any
 * vibration and suppresses later patterns; turning it on restores them.
 *
 * Storage access is wrapped because `localStorage` can throw in private mode
 * or when the browser blocks site data. A storage failure must never break
 * controller startup, so an unavailable store behaves like the default (on).
 * No global is touched at import time; the default storage is resolved when a
 * `HapticsToggle` is constructed.
 */

/** localStorage key shared by every controller viewport. */
export const HAPTICS_STORAGE_KEY = "lanpad.haptics";

/** The two persisted values; anything else is treated as the default. */
export type HapticsPreference = "on" | "off";

/** Structural subset of Storage needed here. */
export interface HapticsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Structural subset of a writable `globalThis` for lazy storage lookup. */
export interface HapticsStorageScope {
  readonly localStorage?: HapticsStorage | undefined;
}

/** Minimal player surface the toggle drives. */
export interface HapticsPlayerBinding {
  setEnabled(enabled: boolean): void;
}

export interface HapticsToggleOptions {
  /**
   * Explicit storage; `null` forces the in-memory default. Omit to lazily read
   * `globalThis.localStorage`.
   */
  readonly storage?: HapticsStorage | null | undefined;
  /** Overrides the stored preference (mainly for tests/initial UI). */
  readonly initialEnabled?: boolean | undefined;
}

export interface HapticsButtonOptions {
  /** Replace the button's text with "Haptics on"/"Haptics off". */
  readonly updateLabel?: boolean | undefined;
}

/**
 * Resolves `globalThis.localStorage` without throwing. Access itself can throw
 * when storage is blocked, so even the property read is guarded.
 */
export function resolveHapticsStorage(
  scope?: HapticsStorageScope | null,
): HapticsStorage | null {
  try {
    const target = scope ?? (globalThis as HapticsStorageScope);
    const storage = target.localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

/** Reads the saved preference; missing, unreadable or unknown means enabled. */
export function readHapticsPreference(
  storage: HapticsStorage | null | undefined,
): boolean {
  if (storage === null || storage === undefined) {
    return true;
  }
  try {
    return storage.getItem(HAPTICS_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Persists the preference; storage failures are ignored. */
export function writeHapticsPreference(
  storage: HapticsStorage | null | undefined,
  enabled: boolean,
): void {
  if (storage === null || storage === undefined) {
    return;
  }
  try {
    storage.setItem(HAPTICS_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Private mode/full quota: the in-memory toggle still works this session.
  }
}

export class HapticsToggle {
  private readonly storage: HapticsStorage | null;
  private enabledState: boolean;
  private readonly listeners = new Set<(enabled: boolean) => void>();

  constructor(options: HapticsToggleOptions = {}) {
    this.storage =
      options.storage !== undefined ? options.storage : resolveHapticsStorage();
    this.enabledState =
      options.initialEnabled !== undefined
        ? options.initialEnabled
        : readHapticsPreference(this.storage);
  }

  get enabled(): boolean {
    return this.enabledState;
  }

  /** Alias used by callers that read `player.isEnabled`. */
  get isEnabled(): boolean {
    return this.enabledState;
  }

  /** Applies and persists a new preference; notifies bound players/buttons. */
  setEnabled(next: boolean): void {
    if (next === this.enabledState) {
      return;
    }
    this.enabledState = next;
    writeHapticsPreference(this.storage, next);
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch {
        // One broken UI listener must not prevent the player from updating.
      }
    }
  }

  toggle(): boolean {
    this.setEnabled(!this.enabledState);
    return this.enabledState;
  }

  /** Subscribes to changes; returns an unsubscribe function. */
  subscribe(listener: (enabled: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Applies the current preference to a player immediately and on every later
   * change. Returns an unsubscribe function.
   */
  bindPlayer(player: HapticsPlayerBinding): () => void {
    player.setEnabled(this.enabledState);
    return this.subscribe((enabled) => {
      player.setEnabled(enabled);
    });
  }

  /**
   * Wires a visible toggle button: click flips the preference, and
   * `aria-pressed`/`data-haptics`/`title` always reflect it. Returns a cleanup
   * function that removes both the listener and the subscription.
   */
  bindButton(button: HTMLElement, options: HapticsButtonOptions = {}): () => void {
    const render = (): void => {
      const enabled = this.enabledState;
      button.setAttribute("aria-pressed", enabled ? "true" : "false");
      button.dataset["haptics"] = enabled ? "on" : "off";
      button.title = enabled ? "Haptics on" : "Haptics off";
      if (options.updateLabel === true) {
        button.textContent = enabled ? "Haptics on" : "Haptics off";
      }
    };

    const onClick = (): void => {
      this.toggle();
    };

    button.addEventListener("click", onClick);
    const unsubscribe = this.subscribe(render);
    render();

    return () => {
      button.removeEventListener("click", onClick);
      unsubscribe();
    };
  }
}
