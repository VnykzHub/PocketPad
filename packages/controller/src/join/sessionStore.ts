/**
 * Per-room controller session storage (D4-CTRL-01, FR-5.4/5.5).
 *
 * A join stores `{session, slot, roomToken?, expiresAt}` under
 * `lanpad.session.<CODE>` in `sessionStorage`, mirrored to `localStorage` with
 * a 4 h expiry so a browser restart can reclaim the slot. Only the session
 * token proves slot ownership; the room token is kept solely for a *new* join
 * after the server reports the reservation expired.
 *
 * Storage is injected (never touched through `window` here) because private
 * mode can make both stores throw. Every access is wrapped in try/catch: a
 * disabled store degrades to "no session" and must never break the join flow.
 */
import { MAX_CONTROLLERS } from "@lanpad/protocol";
import { normalizeRoomCode } from "../route.js";

/** Browser-restart mirror lifetime. Rooms die after 4 h at the latest (FR-5.2). */
export const SESSION_TTL_MS = 4 * 60 * 60 * 1000;

/** Storage key prefix; the room code is appended verbatim (upper-cased). */
export const SESSION_STORAGE_PREFIX = "lanpad.session.";

/** The minimal Web Storage surface this module needs. `Storage` satisfies it. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A stored controller session. `expiresAt` is an epoch-millisecond deadline. */
export interface SessionRecord {
  session: string;
  slot: number;
  roomToken?: string;
  expiresAt: number;
}

/** What a caller supplies on join; the store computes the default expiry. */
export interface SessionWrite {
  session: string;
  slot: number;
  roomToken?: string;
  expiresAt?: number;
}

export interface SessionStore {
  /** Returns a live record for the room, or null when absent, malformed or expired. */
  get(code: string): SessionRecord | null;
  /** Stores a record in sessionStorage and mirrors it to localStorage. */
  set(code: string, record: SessionWrite): void;
  /** Removes the room's record from both stores. */
  clear(code: string): void;
}

export interface SessionStoreOptions {
  sessionStorage?: StorageLike | null;
  localStorage?: StorageLike | null;
  now?: () => number;
  /** Override for tests; defaults to `SESSION_TTL_MS`. */
  ttlMs?: number;
}

/** `lanpad.session.<CODE>`; unknown codes are normalized the same way join parses them. */
export function sessionStorageKey(code: string): string {
  const normalized = normalizeRoomCode(code) ?? code.trim().toUpperCase();
  return `${SESSION_STORAGE_PREFIX}${normalized}`;
}

function parseRecord(raw: string | null): SessionRecord | null {
  if (raw === null) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { session, slot, expiresAt } = record;
  if (typeof session !== "string" || session.length === 0) {
    return null;
  }
  if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 1 || slot > MAX_CONTROLLERS) {
    return null;
  }
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return null;
  }
  const parsed: SessionRecord = { session, slot, expiresAt };
  if (typeof record.roomToken === "string" && record.roomToken.length > 0) {
    parsed.roomToken = record.roomToken;
  }
  return parsed;
}

function safeGet(storage: StorageLike | null | undefined, key: string): string | null {
  if (storage === null || storage === undefined) {
    return null;
  }
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: StorageLike | null | undefined, key: string, value: string): void {
  if (storage === null || storage === undefined) {
    return;
  }
  try {
    storage.setItem(key, value);
  } catch {
    // Private mode or a full quota: the session just does not persist.
  }
}

function safeRemove(storage: StorageLike | null | undefined, key: string): void {
  if (storage === null || storage === undefined) {
    return;
  }
  try {
    storage.removeItem(key);
  } catch {
    // Nothing else to do; a stale value is rejected by the expiry check.
  }
}

/**
 * Builds a store over the two browser storages. Passing the same object twice
 * is harmless. With no storages the store is memory-less (always null).
 */
export function createSessionStore(options: SessionStoreOptions = {}): SessionStore {
  const sessionStorage = options.sessionStorage ?? null;
  const localStorage = options.localStorage ?? null;
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;

  return {
    get(code) {
      const key = sessionStorageKey(code);
      const nowMs = now();

      const rawSession = safeGet(sessionStorage, key);
      const fromSession = parseRecord(rawSession);
      if (fromSession !== null) {
        if (fromSession.expiresAt > nowMs) {
          return fromSession;
        }
        safeRemove(sessionStorage, key);
      } else if (rawSession !== null) {
        // Malformed JSON: drop it rather than retrying on every load.
        safeRemove(sessionStorage, key);
      }

      // Browser restart path: sessionStorage is gone but localStorage survives.
      const fromLocal = parseRecord(safeGet(localStorage, key));
      if (fromLocal === null) {
        return null;
      }
      if (fromLocal.expiresAt <= nowMs) {
        safeRemove(localStorage, key);
        safeRemove(sessionStorage, key);
        return null;
      }
      // Rehydrate the tab store so this tab keeps working if localStorage is
      // later cleared by the browser.
      safeSet(sessionStorage, key, JSON.stringify(fromLocal));
      return fromLocal;
    },

    set(code, record) {
      const key = sessionStorageKey(code);
      const stored: SessionRecord = {
        session: record.session,
        slot: record.slot,
        expiresAt: record.expiresAt ?? now() + ttlMs,
      };
      if (record.roomToken !== undefined) {
        stored.roomToken = record.roomToken;
      }
      const serialized = JSON.stringify(stored);
      safeSet(sessionStorage, key, serialized);
      safeSet(localStorage, key, serialized);
    },

    clear(code) {
      const key = sessionStorageKey(code);
      safeRemove(sessionStorage, key);
      safeRemove(localStorage, key);
    },
  };
}
