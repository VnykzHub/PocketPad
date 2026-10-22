/**
 * D6-CTRL-04 haptics toggle tests: default on, per-viewer localStorage
 * persistence under "lanpad.haptics", storage failures never break startup,
 * and player/button bindings stay in sync.
 */
import { describe, expect, it } from "vitest";
import {
  HAPTICS_STORAGE_KEY,
  HapticsToggle,
  readHapticsPreference,
  resolveHapticsStorage,
  writeHapticsPreference,
  type HapticsStorage,
  type HapticsPlayerBinding,
  type HapticsStorageScope,
} from "../src/haptics/toggle.js";

class FakeStorage implements HapticsStorage {
  readonly values = new Map<string, string>();
  readonly writes: Array<{ key: string; value: string }> = [];
  failReads = false;
  failWrites = false;

  getItem(key: string): string | null {
    if (this.failReads) {
      throw new Error("storage blocked");
    }
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new Error("storage full");
    }
    this.values.set(key, value);
    this.writes.push({ key, value });
  }
}

class FakePlayer implements HapticsPlayerBinding {
  readonly applied: boolean[] = [];

  setEnabled(enabled: boolean): void {
    this.applied.push(enabled);
  }
}

describe("[FR-8.12][AR-3] haptics preference storage", () => {
  it("uses the documented key and treats only exact 'off' as disabled", () => {
    expect(HAPTICS_STORAGE_KEY).toBe("lanpad.haptics");

    const storage = new FakeStorage();
    expect(readHapticsPreference(storage)).toBe(true);

    storage.values.set(HAPTICS_STORAGE_KEY, "off");
    expect(readHapticsPreference(storage)).toBe(false);

    storage.values.set(HAPTICS_STORAGE_KEY, "on");
    expect(readHapticsPreference(storage)).toBe(true);

    storage.values.set(HAPTICS_STORAGE_KEY, "maybe");
    expect(readHapticsPreference(storage)).toBe(true);

    expect(readHapticsPreference(null)).toBe(true);
    expect(readHapticsPreference(undefined)).toBe(true);
  });

  it("persists 'on'/'off' and survives storage exceptions", () => {
    const storage = new FakeStorage();
    writeHapticsPreference(storage, false);
    writeHapticsPreference(storage, true);
    expect(storage.writes).toEqual([
      { key: HAPTICS_STORAGE_KEY, value: "off" },
      { key: HAPTICS_STORAGE_KEY, value: "on" },
    ]);

    const unreadable = new FakeStorage();
    unreadable.failReads = true;
    expect(readHapticsPreference(unreadable)).toBe(true);

    const unwritable = new FakeStorage();
    unwritable.failWrites = true;
    expect(() => {
      writeHapticsPreference(unwritable, false);
    }).not.toThrow();
    expect(() => {
      writeHapticsPreference(null, false);
    }).not.toThrow();
  });

  it("resolves lazily and returns null when storage access throws", () => {
    const storage = new FakeStorage();
    expect(resolveHapticsStorage({ localStorage: storage })).toBe(storage);
    expect(resolveHapticsStorage({})).toBeNull();
    expect(resolveHapticsStorage(null)).not.toBeUndefined();

    const blocked = {} as HapticsStorageScope;
    Object.defineProperty(blocked, "localStorage", {
      get() {
        throw new Error("blocked by policy");
      },
    });
    expect(resolveHapticsStorage(blocked)).toBeNull();
  });
});

describe("[FR-8.12][AR-3] HapticsToggle", () => {
  it("[FR-8.12][AR-3] defaults on and reads the stored preference", () => {
    const defaults = new HapticsToggle({ storage: null });
    expect(defaults.enabled).toBe(true);
    expect(defaults.isEnabled).toBe(true);

    const storage = new FakeStorage();
    storage.values.set(HAPTICS_STORAGE_KEY, "off");
    const stored = new HapticsToggle({ storage });
    expect(stored.enabled).toBe(false);

    const overridden = new HapticsToggle({ storage, initialEnabled: true });
    expect(overridden.enabled).toBe(true);
  });

  it("[FR-8.12][AR-3] persists every change and notifies subscribers", () => {
    const storage = new FakeStorage();
    const toggle = new HapticsToggle({ storage });
    const seen: boolean[] = [];
    const unsubscribe = toggle.subscribe((enabled) => {
      seen.push(enabled);
    });

    toggle.setEnabled(false);
    expect(toggle.enabled).toBe(false);
    expect(storage.values.get(HAPTICS_STORAGE_KEY)).toBe("off");

    toggle.toggle();
    expect(toggle.enabled).toBe(true);
    expect(storage.values.get(HAPTICS_STORAGE_KEY)).toBe("on");

    toggle.setEnabled(true); // no-op, no extra write
    expect(storage.writes).toHaveLength(2);
    expect(seen).toEqual([false, true]);

    unsubscribe();
    toggle.setEnabled(false);
    expect(seen).toEqual([false, true]);
  });

  it("keeps notifying when one listener throws", () => {
    const toggle = new HapticsToggle({ storage: null });
    const seen: boolean[] = [];
    toggle.subscribe(() => {
      throw new Error("broken UI");
    });
    toggle.subscribe((enabled) => {
      seen.push(enabled);
    });

    expect(() => {
      toggle.setEnabled(false);
    }).not.toThrow();
    expect(seen).toEqual([false]);
  });

  it("still flips when writes fail", () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    const toggle = new HapticsToggle({ storage });
    expect(() => {
      toggle.setEnabled(false);
    }).not.toThrow();
    expect(toggle.enabled).toBe(false);
  });

  it("[FR-8.12][AR-3] applies the current state to a player and follows changes", () => {
    const toggle = new HapticsToggle({ storage: null });
    const player = new FakePlayer();

    const unbind = toggle.bindPlayer(player);
    expect(player.applied).toEqual([true]);

    toggle.setEnabled(false);
    expect(player.applied).toEqual([true, false]);

    unbind();
    toggle.setEnabled(true);
    expect(player.applied).toEqual([true, false]);
  });

  it("[FR-8.12][AR-3] binds a toggle button with pressed state, label and cleanup", () => {
    const storage = new FakeStorage();
    const toggle = new HapticsToggle({ storage });
    const button = document.createElement("button");
    button.textContent = "Haptics";

    const unbind = toggle.bindButton(button, { updateLabel: true });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.dataset["haptics"]).toBe("on");
    expect(button.title).toBe("Haptics on");
    expect(button.textContent).toBe("Haptics on");

    button.click();
    expect(toggle.enabled).toBe(false);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.dataset["haptics"]).toBe("off");
    expect(button.title).toBe("Haptics off");
    expect(button.textContent).toBe("Haptics off");
    expect(storage.values.get(HAPTICS_STORAGE_KEY)).toBe("off");

    unbind();
    button.click();
    expect(toggle.enabled).toBe(false);
  });

  it("leaves button text alone unless updateLabel is requested", () => {
    const toggle = new HapticsToggle({ storage: null });
    const button = document.createElement("button");
    button.textContent = "Vibration";

    toggle.bindButton(button);
    expect(button.textContent).toBe("Vibration");
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });
});
